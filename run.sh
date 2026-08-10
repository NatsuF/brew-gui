#!/bin/bash
# BrewMaster — Homebrew 交互式管理工具启动脚本
# 请在系统终端（Terminal.app / iTerm2）中运行本脚本

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_PYTHON="$SCRIPT_DIR/.venv/bin/python3"
PORT=5432

if [ ! -f "$VENV_PYTHON" ]; then
    echo "❌ 虚拟环境未找到。正在自动安装依赖..."
    # 使用系统 Python（/usr/bin/python3），以避免沙箱权限问题
    /usr/bin/python3 -m venv "$SCRIPT_DIR/.venv"
    "$SCRIPT_DIR/.venv/bin/pip" install flask -q
    echo "✅ 依赖安装完成"
fi

echo ""
echo "  🍺  BrewMaster  —  Homebrew 交互式管理工具"
echo "  ───────────────────────────────────────────"
echo "  启动后浏览器将自动打开 http://localhost:${PORT}"
echo "  按 Ctrl+C 停止服务"
echo ""

cd "$SCRIPT_DIR"
sleep 1 && open "http://localhost:${PORT}" &
"$VENV_PYTHON" app.py
