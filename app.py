#!/usr/bin/env python3
"""
BrewMaster — macOS Homebrew 交互式管理工具
Flask 后端 + 现代 Web 前端
"""

import subprocess
import json
import re
import os
import sys
import signal
import platform
import threading
import datetime
import time
from pathlib import Path
from flask import Flask, render_template, jsonify, request, Response, stream_with_context


def _resource_path(relative_path):
    """获取资源文件的绝对路径，兼容开发环境和 PyInstaller 打包环境。"""
    if hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, relative_path)
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), relative_path)


def _get_history_file():
    """获取操作历史文件的可写路径。打包后使用用户目录，开发时使用项目目录。"""
    if hasattr(sys, '_MEIPASS'):
        # 优先使用用户目录，失败则回退到打包目录
        for candidate in [
            Path.home() / ".brewmaster" / "operation_history.json",
            Path(sys._MEIPASS) / "operation_history.json",
            Path("/tmp") / "brewmaster_history.json",
        ]:
            try:
                candidate.parent.mkdir(parents=True, exist_ok=True)
                if not candidate.exists():
                    candidate.write_text("[]", encoding="utf-8")
                else:
                    # 验证文件可写
                    with open(candidate, "a"):
                        pass
                return candidate
            except (PermissionError, OSError):
                continue
        # 最终回退
        fallback = Path("/tmp") / "brewmaster_history.json"
        if not fallback.exists():
            fallback.write_text("[]", encoding="utf-8")
        return fallback
    return Path(__file__).parent / "operation_history.json"


app = Flask(__name__,
            template_folder=_resource_path('templates'),
            static_folder=_resource_path('static'))

BREW_PATH = "/opt/homebrew/bin/brew"
if not Path(BREW_PATH).exists():
    BREW_PATH = "/usr/local/bin/brew"

# Global reference to the currently-running brew process (for force-interrupt)
_active_process = None
_active_process_lock = threading.Lock()
_HISTORY_FILE = _get_history_file()

# ——— Heartbeat / Auto-shutdown ———
_last_activity = datetime.datetime.now()
_activity_lock = threading.Lock()


def _update_activity():
    """Update last activity timestamp."""
    global _last_activity
    with _activity_lock:
        _last_activity = datetime.datetime.now()


def _watchdog_thread(timeout_seconds=30):
    """Background thread: shut down server if no activity for timeout_seconds."""
    while True:
        time.sleep(5)
        with _activity_lock:
            elapsed = (datetime.datetime.now() - _last_activity).total_seconds()
        if elapsed > timeout_seconds:
            print("[Watchdog] No activity for %ds, shutting down." % int(elapsed), flush=True)
            os._exit(0)

# ——— Helpers ———

def _find_askpass_helper():
    """Locate sudo_askpass.sh in dev, one-dir, or .app bundle layouts."""
    candidates = [
        _resource_path("sudo_askpass.sh"),
    ]
    # Bundled app: executable is inside BrewMaster.app/Contents/MacOS/
    exe_dir = Path(sys.executable).parent
    candidates.extend([
        str(exe_dir / "sudo_askpass.sh"),
        str(exe_dir.parent / "Resources" / "sudo_askpass.sh"),
        str(exe_dir.parent / "Frameworks" / "sudo_askpass.sh"),
    ])
    for path in candidates:
        if os.path.isfile(path):
            return path
    return None


def _brew_env():
    env = {
        "HOME": os.environ.get("HOME", os.path.expanduser("~")),
        "USER": os.environ.get("USER", ""),
        "LOGNAME": os.environ.get("USER", ""),
        "SHELL": os.environ.get("SHELL", "/bin/zsh"),
        "PATH": "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "LANG": os.environ.get("LANG", "en_US.UTF-8"),
        "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
        "HOMEBREW_NO_AUTO_UPDATE": "1",
        "HOMEBREW_NO_ENV_HINTS": "1",
    }
    # SUDO_ASKPASS helper: pops a native macOS password dialog when brew invokes sudo
    askpass = _find_askpass_helper()
    if askpass:
        env["SUDO_ASKPASS"] = askpass
    return env


def _history_path():
    return _HISTORY_FILE


def _save_history(operation, package, result):
    try:
        entry = {
            "time": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "operation": operation,
            "package": package,
            "result": result,
        }
        hist_file = _history_path()
        if hist_file.exists():
            with open(hist_file, "r") as f:
                data = json.load(f)
        else:
            data = []
        data.append(entry)
        # Keep last 200 entries
        if len(data) > 200:
            data = data[-200:]
        with open(hist_file, "w") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def run_brew(args, timeout=60):
    try:
        result = subprocess.run(
            [BREW_PATH] + args,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=_brew_env(),
            cwd=str(Path.home()),
        )
        return result.returncode, result.stdout.strip(), result.stderr.strip()
    except subprocess.TimeoutExpired:
        return -1, "", "Command timed out"
    except FileNotFoundError:
        return -1, "", "Homebrew not found. Please install Homebrew first."
    except Exception as e:
        return -1, "", str(e)


def run_brew_stream(args):
    """Run a brew command and yield output line by line (for SSE)."""
    global _active_process
    try:
        proc = subprocess.Popen(
            [BREW_PATH] + args,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=_brew_env(),
            cwd=str(Path.home()),
        )
        with _active_process_lock:
            _active_process = proc
        for line in iter(proc.stdout.readline, ""):
            yield line.rstrip()
        proc.stdout.close()
        proc.wait()
        yield f"__EXIT_CODE__:{proc.returncode}"
    except PermissionError:
        yield "ERROR: 权限不足 — 请在系统终端中运行此工具，而非沙箱环境"
        yield "FIX: 打开 macOS 终端，cd 到 brew-gui 目录，执行 ./run.sh"
        yield "__EXIT_CODE__:1"
    except FileNotFoundError:
        yield "ERROR: Homebrew not found. Please install Homebrew first."
        yield "__EXIT_CODE__:1"
    except Exception as e:
        yield f"ERROR: {e}"
        yield "__EXIT_CODE__:1"
    finally:
        with _active_process_lock:
            _active_process = None


def _sse_response(generator_func, *args):
    """Helper to create SSE streaming responses."""
    def generate():
        for line in generator_func(*args):
            yield f"data: {json.dumps({'line': line})}\n\n"
        yield "data: [DONE]\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _dir_size(path, _seen=None):
    """Calculate directory size in bytes (follows symlinks, avoids cycles)."""
    if _seen is None:
        _seen = set()
    real = os.path.realpath(path)
    if real in _seen:
        return 0
    _seen.add(real)
    total = 0
    try:
        for entry in os.scandir(path):
            try:
                if entry.is_file(follow_symlinks=True):
                    total += entry.stat(follow_symlinks=True).st_size
                elif entry.is_dir(follow_symlinks=True):
                    total += _dir_size(entry.path, _seen)
            except (PermissionError, OSError):
                pass
    except (PermissionError, OSError):
        pass
    return total


def format_size(bytes_val):
    """Format bytes to human readable."""
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if bytes_val < 1024:
            return f"{bytes_val:.1f} {unit}"
        bytes_val /= 1024
    return f"{bytes_val:.1f} PB"


# ——— Parsers ———

def parse_brew_list(raw, is_cask=False):
    if not raw:
        return []
    packages = []
    for line in raw.split("\n"):
        name = line.strip()
        if name and not name.startswith("==>"):
            packages.append({"name": name, "type": "cask" if is_cask else "formula"})
    return packages


def parse_brew_info(raw):
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return []


def parse_services(raw):
    services = []
    if not raw:
        return services
    lines = raw.split("\n")
    in_table = False
    for line in lines:
        if line.startswith("Name"):
            in_table = True
            continue
        if in_table and line.strip():
            parts = line.split()
            if len(parts) >= 2:
                services.append({
                    "name": parts[0],
                    "status": parts[1],
                    "user": parts[2] if len(parts) > 2 else "",
                })
    return services


def parse_outdated(raw):
    if not raw:
        return []
    packages = []
    for line in raw.split("\n"):
        line = line.strip()
        if line:
            parts = line.split()
            name = parts[0]
            versions = " ".join(parts[1:]) if len(parts) > 1 else ""
            packages.append({"name": name, "info": versions})
    return packages


# ——— Routes ———

@app.route("/")
def index():
    return render_template("index.html")


# ——— Dashboard ———

@app.route("/api/health")
def api_health():
    try:
        test_lock = "/opt/homebrew/var/homebrew/locks/_brewmaster_health_check.lock"
        with open(test_lock, "w") as f:
            f.write("test")
        os.remove(test_lock)
        return jsonify({"can_write": True, "message": "All good — running in native terminal"})
    except (PermissionError, OSError) as e:
        return jsonify({
            "can_write": False,
            "message": "Sandbox detected — upgrade/install/cleanup unavailable. "
                       "Please run ./run.sh in macOS Terminal.app instead.",
            "error": str(e),
        })


@app.route("/api/dashboard")
def api_dashboard():
    _, version_out, _ = run_brew(["--version"], timeout=5)
    version = version_out.split("\n")[0] if version_out else "Unknown"

    _, formula_out, _ = run_brew(["list", "--formula"], timeout=10)
    formula_count = len([l for l in formula_out.split("\n") if l.strip()]) if formula_out else 0

    _, cask_out, _ = run_brew(["list", "--cask"], timeout=10)
    cask_count = len([l for l in cask_out.split("\n") if l.strip()]) if cask_out else 0

    _, outdated_out, _ = run_brew(["outdated"], timeout=30)
    outdated_count = len([l for l in outdated_out.split("\n") if l.strip()]) if outdated_out else 0

    _, pinned_out, _ = run_brew(["list", "--pinned"], timeout=10)
    pinned_count = len([l for l in pinned_out.split("\n") if l.strip()]) if pinned_out else 0

    return jsonify({
        "version": version,
        "formula_count": formula_count,
        "cask_count": cask_count,
        "total_packages": formula_count + cask_count,
        "outdated_count": outdated_count,
        "pinned_count": pinned_count,
    })


# ——— Packages ———

@app.route("/api/packages")
def api_packages():
    """Get all installed packages with enhanced info."""
    _, formula_raw, _ = run_brew(["list", "--formula"], timeout=10)
    _, cask_raw, _ = run_brew(["list", "--cask"], timeout=10)

    formulas = parse_brew_list(formula_raw, is_cask=False)
    casks = parse_brew_list(cask_raw, is_cask=True)
    all_pkgs = formulas + casks

    # Get pinned set
    _, pinned_raw, _ = run_brew(["list", "--pinned"], timeout=10)
    pinned = set(l.strip() for l in pinned_raw.split("\n") if l.strip()) if pinned_raw else set()

    for pkg in all_pkgs:
        pkg["pinned"] = pkg["name"] in pinned

    return jsonify({"packages": all_pkgs, "total": len(all_pkgs)})


@app.route("/api/package/<name>")
def api_package_info(name):
    """Get detailed info about a package."""
    _, info_raw, _ = run_brew(["info", "--json", name], timeout=15)
    info = parse_brew_info(info_raw)
    result = info[0] if info else {"error": "Package not found"}

    # Add home URL for quick access
    if result.get("homepage"):
        result["_home_url"] = result["homepage"]

    return jsonify(result)


# ——— Search ———

@app.route("/api/search")
def api_search():
    """Search for packages with enhanced info."""
    query = request.args.get("q", "")
    if not query or len(query) < 2:
        return jsonify({"results": [], "total": 0})

    _, search_out, _ = run_brew(["search", query], timeout=15)
    results = []
    if search_out:
        names = []
        for line in search_out.split("\n"):
            line = line.strip()
            if line and not line.startswith("==>"):
                pkg_type = "formula"
                if line.endswith("(cask)") or "/cask/" in line:
                    pkg_type = "cask"
                name = line.replace("(cask)", "").strip()
                names.append((name, pkg_type))

        # Fetch info for first 8 results
        for i, (name, pkg_type) in enumerate(names):
            entry = {"name": name, "type": pkg_type}
            if i < 8:
                try:
                    _, info_raw, _ = run_brew(["info", "--json=v2", name], timeout=8)
                    parsed = parse_brew_info(info_raw)
                    if parsed:
                        if isinstance(parsed, dict) and "formulae" in parsed:
                            flist = parsed.get("formulae", []) or parsed.get("casks", [])
                            if flist:
                                item = flist[0]
                                entry["description"] = (item.get("desc") or "")[:200]
                                entry["homepage"] = item.get("homepage", "")
                                entry["installed_count"] = item.get("analytics", {}).get("install", {}).get("30d", {}).get(name, 0)
                        elif isinstance(parsed, list) and parsed:
                            item = parsed[0]
                            entry["description"] = (item.get("desc") or "")[:200]
                            entry["homepage"] = item.get("homepage", "")
                            entry["installed_count"] = 0
                except Exception:
                    pass
            results.append(entry)

    return jsonify({"results": results, "total": len(results)})


# ——— Install ———

@app.route("/api/install", methods=["POST"])
def api_install():
    data = request.get_json()
    name = data.get("name", "")
    is_cask = data.get("is_cask", False)
    if not name:
        return jsonify({"error": "Package name required"}), 400

    _save_history("安装", name, "已执行")

    args = ["install"]
    if is_cask:
        args.append("--cask")
    args.append(name)

    return _sse_response(run_brew_stream, args)


# ——— Uninstall ———

@app.route("/api/uninstall", methods=["POST"])
def api_uninstall():
    data = request.get_json()
    name = data.get("name", "")
    is_cask = data.get("is_cask", False)
    if not name:
        return jsonify({"error": "Package name required"}), 400

    _save_history("卸载", name, "已执行")

    args = ["uninstall"]
    if is_cask:
        args.append("--cask")
    args.append(name)
    return _sse_response(run_brew_stream, args)


# ——— Batch Uninstall ———

@app.route("/api/batch/uninstall", methods=["POST"])
def api_batch_uninstall():
    data = request.get_json()
    names = data.get("names", [])
    if not names:
        return jsonify({"error": "Package names required"}), 400

    _save_history("批量卸载", ", ".join(names), "已执行")

    args = ["uninstall"] + names
    return _sse_response(run_brew_stream, args)


@app.route("/api/batch/pin", methods=["POST"])
def api_batch_pin():
    """Batch pin packages via SSE stream."""
    data = request.get_json()
    names = data.get("names", [])
    if not names:
        return jsonify({"error": "Package names required"}), 400

    _save_history("批量固定", ", ".join(names), "已执行")

    args = ["pin"] + names
    return _sse_response(run_brew_stream, args)


# ——— Update ———

@app.route("/api/update", methods=["POST"])
def api_update():
    _save_history("更新索引", "全部", "已执行")
    return _sse_response(run_brew_stream, ["update"])


@app.route("/api/update_silent", methods=["POST"])
def api_update_silent():
    """Run brew update synchronously (for startup auto-update)."""
    _save_history("更新索引(自动)", "全部", "已执行")
    ret, out, err = run_brew(["update"], timeout=120)
    success = ret == 0
    return jsonify({
        "success": success,
        "output": (out or "")[-500:],
        "error": (err or "")[-500:],
    })


# ——— Outdated ———

@app.route("/api/outdated")
def api_outdated():
    _, outdated_raw, _ = run_brew(["outdated"], timeout=30)
    outdated = parse_outdated(outdated_raw)

    for pkg in outdated:
        _, list_out, _ = run_brew(["list", "--cask", pkg["name"]], timeout=5)
        pkg["type"] = "cask" if pkg["name"] in list_out else "formula"

    return jsonify({"outdated": outdated, "total": len(outdated)})


# ——— Upgrade ———

@app.route("/api/upgrade", methods=["POST"])
def api_upgrade():
    data = request.get_json() or {}
    name = data.get("name", "")
    names = data.get("names", [])  # for batch upgrade

    args = ["upgrade"]
    if names:
        args.extend(names)
        _save_history("升级", ", ".join(names), "已执行")
    elif name:
        args.append(name)
        _save_history("升级", name, "已执行")
    else:
        _save_history("升级全部", "全部", "已执行")
    return _sse_response(run_brew_stream, args)


# ——— Dependencies ———

@app.route("/api/deps/<name>")
def api_deps(name):
    """Get dependency tree for a package."""
    _, tree_out, _ = run_brew(["deps", "--tree", name], timeout=15)
    _, uses_out, _ = run_brew(["uses", "--installed", name], timeout=15)

    dep_tree = tree_out if tree_out else ""
    dependents = [l.strip() for l in uses_out.split("\n") if l.strip()] if uses_out else []

    return jsonify({
        "name": name,
        "dep_tree": dep_tree,
        "dependents": dependents,
    })


@app.route("/api/autoremove", methods=["POST"])
def api_autoremove():
    """Remove unused dependencies."""
    _save_history("自动清理", "未使用的依赖", "已执行")
    return _sse_response(run_brew_stream, ["autoremove"])


# ——— Pin/Unpin ———

@app.route("/api/pin", methods=["POST"])
def api_pin():
    data = request.get_json()
    name = data.get("name", "")
    action = data.get("action", "pin")

    if not name:
        return jsonify({"error": "Package name required"}), 400

    args = ["pin"] if action == "pin" else ["unpin"]
    args.append(name)

    returncode, stdout, stderr = run_brew(args)
    _save_history("固定" if action == "pin" else "取消固定", name, "成功" if returncode == 0 else "失败")
    return jsonify({"success": returncode == 0, "output": stdout, "error": stderr})


@app.route("/api/pinned")
def api_pinned():
    """Get list of pinned packages."""
    _, pinned_out, _ = run_brew(["list", "--pinned"], timeout=10)
    pinned = [l.strip() for l in pinned_out.split("\n") if l.strip()] if pinned_out else []
    return jsonify({"pinned": pinned, "total": len(pinned)})


# ——— Cask Info ———

@app.route("/api/casks")
def api_casks():
    """Get detailed info for installed casks."""
    _, cask_raw, _ = run_brew(["list", "--cask"], timeout=10)
    casks = [l.strip() for l in cask_raw.split("\n") if l.strip()] if cask_raw else []

    results = []
    for name in casks[:30]:  # limit to avoid timeout
        try:
            _, info_raw, _ = run_brew(["info", "--json=v2", name], timeout=10)
            parsed = parse_brew_info(info_raw)
            entry = {"name": name, "type": "cask"}
            if parsed:
                if isinstance(parsed, dict) and "casks" in parsed:
                    cs = parsed.get("casks", [])
                    if cs:
                        c = cs[0]
                        entry.update({
                            "full_name": c.get("full_token", c.get("full_name", "")),
                            "version": c.get("version", "unknown"),
                            "installed_size": "",
                            "install_date": "",
                        })
                        # Try to get app path and size
                        try:
                            _, app_raw, _ = run_brew(["info", "--cask", "--json=v1", name], timeout=5)
                            app_info = parse_brew_info(app_raw)
                            if app_info and isinstance(app_info, list) and app_info:
                                ai = app_info[0]
                                artifacts = ai.get("artifacts", [])
                                for art in artifacts:
                                    if isinstance(art, dict) and "app" in art:
                                        app_path = f"/Applications/{art['app']}"
                                        if Path(app_path).exists():
                                            entry["app_path"] = app_path
                                            entry["installed_size"] = format_size(_dir_size(app_path))
                                            break
                        except Exception:
                            pass
                elif isinstance(parsed, list) and parsed:
                    c = parsed[0]
                    entry.update({
                        "full_name": c.get("full_token", c.get("full_name", "")),
                        "version": c.get("version", "unknown"),
                    })
            results.append(entry)
        except Exception:
            results.append({"name": name, "type": "cask", "error": "获取信息失败"})

    return jsonify({"casks": results, "total": len(results)})


# ——— Disk Usage ———

@app.route("/api/disk-usage")
def api_disk_usage():
    """Get disk usage analysis."""
    # HOMEBREW_CELLAR
    cellar = Path("/opt/homebrew/Cellar")
    if not cellar.exists():
        cellar = Path("/usr/local/Cellar")

    cellar_size = _dir_size(cellar) if cellar.exists() else 0

    # Per-package size (Cellar — formulas)
    pkg_sizes = []
    if cellar.exists():
        for pkg_dir in sorted(cellar.iterdir(), key=lambda d: d.name):
            if pkg_dir.is_dir():
                sz = _dir_size(pkg_dir)
                pkg_sizes.append({"name": pkg_dir.name, "size": sz, "size_human": format_size(sz), "type": "formula"})

    # Caskroom path
    caskroom = Path("/opt/homebrew/Caskroom")
    if not caskroom.exists():
        caskroom = Path("/usr/local/Caskroom")

    # Per-package size (Caskroom — casks)
    cask_sizes = []
    if caskroom.exists():
        for pkg_dir in sorted(caskroom.iterdir(), key=lambda d: d.name):
            if pkg_dir.is_dir():
                sz = _dir_size(pkg_dir)
                cask_sizes.append({"name": pkg_dir.name, "size": sz, "size_human": format_size(sz), "type": "cask"})

    # Merge and sort by size desc
    pkg_sizes.extend(cask_sizes)
    pkg_sizes.sort(key=lambda x: x["size"], reverse=True)

    caskroom_size = sum(c["size"] for c in cask_sizes) if cask_sizes else 0

    # Other
    prefix = Path("/opt/homebrew")
    if not prefix.exists():
        prefix = Path("/usr/local")

    lib_size = _dir_size(prefix / "lib") if (prefix / "lib").exists() else 0
    share_size = _dir_size(prefix / "share") if (prefix / "share").exists() else 0
    opt_size = _dir_size(prefix / "opt") if (prefix / "opt").exists() else 0

    total = cellar_size + caskroom_size + lib_size + share_size + opt_size

    return jsonify({
        "total": total,
        "total_human": format_size(total),
        "cellar": {"size": cellar_size, "human": format_size(cellar_size)},
        "caskroom": {"size": caskroom_size, "human": format_size(caskroom_size)},
        "lib": {"size": lib_size, "human": format_size(lib_size)},
        "share": {"size": share_size, "human": format_size(share_size)},
        "opt": {"size": opt_size, "human": format_size(opt_size)},
        "packages": pkg_sizes[:30],  # top 30
    })


# ——— Cache Management ———

@app.route("/api/cache")
def api_cache():
    """Get cache info."""
    cache_dir = os.environ.get("HOMEBREW_CACHE", str(Path.home() / "Library/Caches/Homebrew"))
    cache_path = Path(cache_dir)

    cache_size = _dir_size(cache_path) if cache_path.exists() else 0
    file_count = sum(1 for _ in cache_path.rglob("*")) if cache_path.exists() else 0

    return jsonify({
        "path": str(cache_path),
        "size": cache_size,
        "size_human": format_size(cache_size),
        "file_count": file_count,
        "exists": cache_path.exists(),
    })


@app.route("/api/cache/clear", methods=["POST"])
def api_cache_clear():
    """Clear brew cache."""
    _save_history("清理缓存", "全部", "已执行")
    return _sse_response(run_brew_stream, ["cleanup", "--prune=all"])


# ——— Brewfile Management ———

@app.route("/api/brewfile/export", methods=["POST"])
def api_brewfile_export():
    """Export Brewfile."""
    data = request.get_json() or {}
    path = data.get("path", "")
    # 默认写入用户主目录，确保绝对路径
    brewfile_path = str(Path(path).expanduser().resolve()) if path.strip() else str(Path.home() / "Brewfile")

    args = ["bundle", "dump", "--file", brewfile_path]
    # --describe 已废弃，不再使用

    _save_history("导出 Brewfile", brewfile_path, "已执行")

    returncode, stdout, stderr = run_brew(args, timeout=30)
    content = ""
    if Path(brewfile_path).exists():
        content = Path(brewfile_path).read_text()
    return jsonify({
        "success": returncode == 0,
        "output": stdout,
        "error": stderr,
        "path": brewfile_path,
        "content": content,
    })


@app.route("/api/brewfile/preview", methods=["POST"])
def api_brewfile_preview():
    """Preview a Brewfile."""
    data = request.get_json() or {}
    path = data.get("path", "")
    brewfile_path = str(Path(path).expanduser().resolve()) if path.strip() else str(Path.home() / "Brewfile")
    if not Path(brewfile_path).exists():
        return jsonify({"error": "文件不存在", "path": brewfile_path})
    content = Path(brewfile_path).read_text()
    packages = [l.strip().split()[1] for l in content.split("\n")
                if l.strip().startswith(("brew ", "cask ", "tap ", "mas "))
                and len(l.strip().split()) >= 2]
    return jsonify({"path": brewfile_path, "content": content, "packages": packages, "count": len(packages)})


@app.route("/api/brewfile/install", methods=["POST"])
def api_brewfile_install():
    """Install from Brewfile."""
    data = request.get_json() or {}
    path = data.get("path", "")
    brewfile_path = str(Path(path).expanduser().resolve()) if path.strip() else str(Path.home() / "Brewfile")
    _save_history("安装 Brewfile", brewfile_path, "已执行")
    args = ["bundle", "install", "--file", brewfile_path]
    return _sse_response(run_brew_stream, args)


# ——— System Info ———

@app.route("/api/system-info")
def api_system_info():
    """Get macOS and Homebrew system information."""
    info = {
        "macos_version": platform.mac_ver()[0],
        "arch": platform.machine(),
        "processor": platform.processor(),
        "python_version": platform.python_version(),
        "brew_prefix": str(Path("/opt/homebrew")) if Path("/opt/homebrew").exists() else str(Path("/usr/local")),
        "brew_path": BREW_PATH,
    }

    # Xcode CLT
    try:
        result = subprocess.run(
            ["xcode-select", "-p"],
            capture_output=True, text=True, timeout=5,
            env=_brew_env(),
        )
        info["xcode_clt_path"] = result.stdout.strip()
        info["xcode_clt_installed"] = True
    except Exception:
        info["xcode_clt_installed"] = False

    # Shell
    info["shell"] = os.environ.get("SHELL", "unknown")

    # Homebrew env vars
    for var in ["HOMEBREW_PREFIX", "HOMEBREW_CELLAR", "HOMEBREW_REPOSITORY",
                "HOMEBREW_CACHE", "HOMEBREW_TEMP"]:
        try:
            result = subprocess.run(
                [BREW_PATH, f"--{var.replace('_', '-').lower()}"],
                capture_output=True, text=True, timeout=3,
                env=_brew_env(),
            )
            info[var.lower()] = result.stdout.strip()
        except Exception:
            info[var.lower()] = "unknown"

    return jsonify(info)


# ——— Operation History ———

@app.route("/api/history")
def api_history():
    """Get operation history."""
    hist_file = _history_path()
    if hist_file.exists():
        try:
            with open(hist_file, "r") as f:
                data = json.load(f)
            return jsonify({"history": list(reversed(data)), "total": len(data)})
        except (json.JSONDecodeError, ValueError):
            # 文件损坏或为空，重置为空列表
            with open(hist_file, "w") as f:
                json.dump([], f)
            return jsonify({"history": [], "total": 0})
    return jsonify({"history": [], "total": 0})


@app.route("/api/history/clear", methods=["POST"])
def api_history_clear():
    """Clear operation history."""
    hist_file = _history_path()
    if hist_file.exists():
        hist_file.unlink()
    return jsonify({"success": True})


# ——— Home URL ———

@app.route("/api/home/<name>")
def api_home(name):
    """Get homepage URL for a package."""
    _, info_raw, _ = run_brew(["info", "--json=v2", name], timeout=10)
    parsed = parse_brew_info(info_raw)
    homepage = ""
    if parsed:
        if isinstance(parsed, dict):
            flist = parsed.get("formulae", []) or parsed.get("casks", [])
            if flist:
                homepage = flist[0].get("homepage", "")
        elif isinstance(parsed, list) and parsed:
            homepage = parsed[0].get("homepage", "")
    return jsonify({"name": name, "homepage": homepage})


# ——— Services Auto-Refresh ———

@app.route("/api/services")
def api_services():
    _, services_raw, _ = run_brew(["services", "list"], timeout=10)
    services = parse_services(services_raw)
    return jsonify({"services": services})


@app.route("/api/service/<action>", methods=["POST"])
def api_service_action(action):
    if action not in ("start", "stop", "restart"):
        return jsonify({"error": "Invalid action"}), 400
    data = request.get_json()
    name = data.get("name", "")
    if not name:
        return jsonify({"error": "Service name required"}), 400
    _save_history("服务" + action, name, "已执行")
    return _sse_response(run_brew_stream, ["services", action, name])


# ——— Doctor ———

@app.route("/api/doctor", methods=["POST"])
def api_doctor():
    _save_history("诊断检查", "系统", "已执行")
    return _sse_response(run_brew_stream, ["doctor"])


# ——— Cleanup ———

@app.route("/api/cleanup", methods=["POST"])
def api_cleanup():
    data = request.get_json() or {}
    dry_run = data.get("dry_run", True)
    _save_history("清理旧版本", "全部" if not dry_run else "模拟", "已执行")
    args = ["cleanup"]
    if dry_run:
        args.append("--dry-run")
    return _sse_response(run_brew_stream, args)


# ——— Generic Command ———

@app.route("/api/command", methods=["POST"])
def api_command():
    data = request.get_json()
    args = data.get("args", [])
    if not args:
        return jsonify({"error": "Command args required"}), 400

    allowed = {"config", "analytics", "bundle", "pin", "unpin", "list", "info",
               "--version", "tap-info", "link", "unlink", "outdated",
               "deps", "uses", "autoremove", "home", "help"}
    if args[0] not in allowed:
        return jsonify({"error": f"Command '{args[0]}' not allowed via generic endpoint"}), 400

    _save_history("执行命令", " ".join(args), "已执行")
    return _sse_response(run_brew_stream, args)


# ——— Force Interrupt ———

@app.route("/api/kill", methods=["POST"])
def api_kill():
    """Kill the currently running brew process."""
    global _active_process
    with _active_process_lock:
        proc = _active_process
        _active_process = None  # Clear ref immediately to prevent reuse
    if proc is None:
        return jsonify({"success": False, "message": "没有运行中的进程"})
    try:
        if proc.poll() is None:
            # Try terminate first (SIGTERM)
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                # Force kill if still alive
                proc.kill()
                proc.wait()
            return jsonify({"success": True, "message": "进程已终止"})
        else:
            return jsonify({"success": False, "message": "进程已结束"})
    except ProcessLookupError:
        return jsonify({"success": True, "message": "进程已不存在"})
    except Exception as e:
        return jsonify({"success": False, "message": f"中断失败: {e}"})


# ——— Shutdown Server ———

@app.route("/api/shutdown", methods=["POST"])
def api_shutdown():
    """Shut down the entire BrewMaster backend process."""
    global _active_process
    # 先中断正在运行的 brew 子进程
    with _active_process_lock:
        proc = _active_process
        _active_process = None
    if proc is not None and proc.poll() is None:
        try:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        except Exception:
            pass

    _save_history("关闭服务", "BrewMaster 后台", "已执行")

    # 延迟退出，确保 HTTP 响应能正常返回给客户端
    def _delayed_exit():
        time.sleep(0.5)
        print("[Shutdown] Server shutdown requested, exiting.", flush=True)
        os._exit(0)

    threading.Thread(target=_delayed_exit, daemon=True).start()
    return jsonify({"success": True, "message": "服务正在关闭..."})


# ——— Tap Management ———

@app.route("/api/taps")
def api_taps():
    _, raw, _ = run_brew(["tap"], timeout=10)
    taps = []
    if raw:
        for line in raw.split("\n"):
            name = line.strip()
            if name:
                taps.append({"name": name, "pinned": False})
    _, pinned_raw, _ = run_brew(["tap", "--list-pinned"], timeout=10)
    if pinned_raw:
        pinned = set(l.strip() for l in pinned_raw.split("\n") if l.strip())
        for t in taps:
            t["pinned"] = t["name"] in pinned
    return jsonify({"taps": taps, "total": len(taps)})


@app.route("/api/tap/search", methods=["POST"])
def api_tap_search():
    data = request.get_json()
    query = (data.get("query", "") or "").strip()
    if not query:
        return jsonify({"results": []})

    import urllib.request
    import urllib.parse

    encoded = urllib.parse.quote(f"homebrew {query} in:name")
    url = f"https://api.github.com/search/repositories?q={encoded}&sort=stars&per_page=12"

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "BrewMaster/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = json.loads(resp.read())
    except Exception as e:
        return jsonify({"results": [], "error": f"GitHub API 请求失败: {e}"})

    results = []
    for item in raw.get("items", []):
        owner_info = item.get("owner", {})
        user = owner_info.get("login", "")
        repo_name = item.get("name", "")
        if repo_name.lower().startswith("homebrew-"):
            suffix = repo_name[len("homebrew-"):]
            tap_name = f"{user}/{suffix}"
        else:
            tap_name = f"{user}/{repo_name}"

        results.append({
            "full_name": item.get("full_name", ""),
            "tap_name": tap_name,
            "description": (item.get("description") or ""),
            "stars": item.get("stargazers_count", 0),
            "html_url": item.get("html_url", ""),
            "topics": item.get("topics", []),
        })

    return jsonify({"results": results})


@app.route("/api/tap/add", methods=["POST"])
def api_tap_add():
    data = request.get_json()
    name = data.get("name", "")
    if not name:
        return jsonify({"error": "Tap name required"}), 400
    _save_history("添加 Tap", name, "已执行")
    return _sse_response(run_brew_stream, ["tap", name])


@app.route("/api/tap/remove", methods=["POST"])
def api_tap_remove():
    data = request.get_json()
    name = data.get("name", "")
    if not name:
        return jsonify({"error": "Tap name required"}), 400
    _save_history("移除 Tap", name, "已执行")
    return _sse_response(run_brew_stream, ["untap", name])


if __name__ == "__main__":
    PORT = 5432

    # 打包模式下将输出重定向到日志文件（防止崩溃且便于调试）
    if getattr(sys, 'frozen', False):
        log_dir = Path.home() / ".brewmaster"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_file = log_dir / "brewmaster.log"
        try:
            log_fp = open(log_file, "a")
            sys.stdout = log_fp
            sys.stderr = log_fp
        except Exception:
            pass  # 日志写入失败不应阻止应用启动

    print(f"""
    ╔══════════════════════════════════════════╗
    ║        🍺  BrewMaster 启动中...           ║
    ║   Homebrew 交互式管理工具                 ║
    ║   打开浏览器访问: http://localhost:{PORT}    ║
    ╚══════════════════════════════════════════╝
    """, flush=True)

    # 打包后自动打开浏览器
    if hasattr(sys, '_MEIPASS') or getattr(sys, 'frozen', False):
        import webbrowser
        import threading as _t
        _t.Timer(1.5, lambda: webbrowser.open(f"http://localhost:{PORT}")).start()

    app.run(host="127.0.0.1", port=PORT, debug=False, threaded=True)
