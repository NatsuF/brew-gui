/**
 * BrewMaster — 前端交互逻辑
 */

// ===== State =====
let currentTab = 'dashboard';
let allPackages = [];
let packageFilter = 'all';
let currentStreamController = null;
let selectedPackages = new Set();
let batchMode = null; // 'uninstall' | 'pin'
let serviceMonitorInterval = null;

// ===== Init =====
let canWrite = false;

document.addEventListener('DOMContentLoaded', () => {
    initNavigation();
    checkHealth();
    loadDashboard();
    loadPackages();
    loadServices();
    loadCache();
    loadSearchRecommendations();

    // 启动时自动执行 brew update（静默后台）
    autoBrewUpdate();

    document.querySelector('.terminal-header').addEventListener('click', (e) => {
        if (!e.target.closest('.terminal-btn')) toggleTerminal();
    });
});

// ===== Navigation =====
function initNavigation() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
}

async function checkHealth() {
    try {
        const res = await fetch('/api/health');
        const data = await res.json();
        canWrite = data.can_write;
        if (!canWrite) showSandboxWarning(data.message);
    } catch (err) {
        canWrite = false;
        showSandboxWarning('Unable to verify write permissions.');
    }
}

function showSandboxWarning(message) {
    const banner = document.createElement('div');
    banner.className = 'sandbox-warning';
    banner.innerHTML = `<span class="sandbox-icon">⚠️</span><span class="sandbox-text">${message}</span><button class="sandbox-close" onclick="this.parentElement.remove()">×</button>`;
    document.querySelector('main').prepend(banner);
}

function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.nav-btn[data-tab="${tab}"]`).classList.add('active');
    document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
    document.getElementById(`tab-${tab}`).classList.add('active');

    if (tab === 'dashboard') loadDashboard();
    if (tab === 'packages') loadPackages();
    if (tab === 'updates') loadOutdated();
    if (tab === 'taps') loadTaps();
    if (tab === 'deps') { /* search-driven */ }
    if (tab === 'disk') loadDiskUsage();
    if (tab === 'cache') loadCache();
    if (tab === 'brewfile') { /* action-driven */ }
    if (tab === 'tools') { /* action-driven */ }
    if (tab === 'history') loadHistory();
    if (tab === 'services') { loadServices(); startServiceMonitor(); }
    else stopServiceMonitor();
}

// ===== Auto Brew Update (Startup) =====
let _autoUpdateDone = false;

async function autoBrewUpdate() {
    if (_autoUpdateDone) return;
    _autoUpdateDone = true;
    try {
        // 显示顶部进度提示
        const banner = document.createElement('div');
        banner.className = 'auto-update-banner';
        banner.innerHTML = '<span class="spinner spinner-sm"></span><span>正在后台执行 brew update，刷新版本状态...</span>';
        document.querySelector('main').prepend(banner);

        const res = await fetch('/api/update_silent', { method: 'POST' });
        const data = await res.json();

        banner.remove();
        if (data.success) {
            showToast('brew update 已完成，版本状态已刷新', 'success');
        } else {
            showToast('brew update 完成（可能含警告）', 'warning');
        }
        // 刷新仪表盘以显示最新的过期包数量
        loadDashboard();
    } catch (err) {
        console.log('Auto brew update failed:', err);
        const banner = document.querySelector('.auto-update-banner');
        if (banner) banner.remove();
    }
}

// ===== Dashboard Navigation =====
function navigateFromDashboard(tab, filter) {
    switchTab(tab);
    if (filter) {
        packageFilter = filter;
        // 同步 filter-chips 按钮状态
        document.querySelectorAll('.filter-chips .chip').forEach(c => c.classList.remove('active'));
        const chip = document.querySelector(`.filter-chips .chip[data-filter="${filter}"]`);
        if (chip) chip.classList.add('active');
    }
}

// ===== Dashboard =====
async function loadDashboard() {
    try {
        const res = await fetch('/api/dashboard');
        const data = await res.json();
        document.getElementById('stat-total').textContent = data.total_packages;
        document.getElementById('stat-formula').textContent = data.formula_count;
        document.getElementById('stat-cask').textContent = data.cask_count;
        document.getElementById('stat-outdated').textContent = data.outdated_count;
        document.getElementById('stat-pinned').textContent = data.pinned_count;
        document.getElementById('brew-version').textContent = data.version;
    } catch (err) { console.error('Dashboard error:', err); }
}

// ===== Packages =====
async function loadPackages() {
    const list = document.getElementById('package-list');
    list.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>加载中...</p></div>';
    try {
        const res = await fetch('/api/packages');
        const data = await res.json();
        allPackages = data.packages;
        renderPackages();
    } catch (err) { list.innerHTML = '<div class="empty-state"><p>加载失败</p></div>'; }
}

function renderPackages() {
    const list = document.getElementById('package-list');
    const searchText = (document.getElementById('package-filter')?.value || '').toLowerCase();

    let filtered = allPackages;
    if (packageFilter === 'pinned') {
        filtered = filtered.filter(p => p.pinned);
    } else if (packageFilter !== 'all') {
        filtered = filtered.filter(p => p.type === packageFilter);
    }
    if (searchText) {
        filtered = filtered.filter(p => p.name.toLowerCase().includes(searchText));
    }

    if (filtered.length === 0) {
        list.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><p>没有找到匹配的包</p></div>';
        return;
    }

    list.innerHTML = filtered.map(pkg => `
        <div class="package-item">
            <div class="pkg-icon ${pkg.type}">${pkg.type === 'cask' ? '🍏' : '🧪'}</div>
            <div class="pkg-info">
                <div class="pkg-name">${escapeHtml(pkg.name)}${pkg.pinned ? ' 📌' : ''}</div>
                <div class="pkg-type">${pkg.type}</div>
            </div>
            <div class="pkg-actions">
                <button class="pkg-action-btn home" onclick="openHomepage('${escapeHtml(pkg.name)}')" title="打开主页">主页</button>
                <button class="pkg-action-btn" onclick="showPackageInfo('${escapeHtml(pkg.name)}')" title="详情">详情</button>
                <button class="pkg-action-btn pin" onclick="togglePin('${escapeHtml(pkg.name)}', ${pkg.pinned})" title="${pkg.pinned ? '取消固定' : '固定版本'}">${pkg.pinned ? '取消固定' : '固定'}</button>
                <button class="pkg-action-btn danger" onclick="uninstallPackage('${escapeHtml(pkg.name)}', ${pkg.type === 'cask'})" title="卸载">卸载</button>
            </div>
        </div>
    `).join('');
}

function filterPackages() { renderPackages(); }

function setPackageFilter(filter, btn) {
    packageFilter = filter;
    document.querySelectorAll('.filter-chips .chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    renderPackages();
}

// ===== Batch Operations (Modal-based) =====
function openBatchModal(mode) {
    batchMode = mode;
    selectedPackages.clear();

    const titles = { uninstall: '批量卸载', pin: '批量固定' };
    document.getElementById('batch-modal-title').textContent = titles[mode] || '批量操作';
    document.getElementById('batch-confirm-btn').textContent = titles[mode] ? `确认${titles[mode]}` : '确认执行';

    const list = document.getElementById('batch-select-list');
    list.innerHTML = allPackages.map(pkg => `
        <label class="batch-select-item">
            <input type="checkbox" class="batch-check" value="${escapeHtml(pkg.name)}" onchange="onBatchCheck(this)">
            <span class="pkg-icon ${pkg.type}">${pkg.type === 'cask' ? '🍏' : '🧪'}</span>
            <span class="batch-item-name">${escapeHtml(pkg.name)}</span>
            <span class="batch-item-type ${pkg.type}">${pkg.type}</span>
        </label>
    `).join('');

    updateBatchCount();
    document.getElementById('batch-modal').classList.add('active');
}

function closeBatchModal() {
    document.getElementById('batch-modal').classList.remove('active');
    batchMode = null;
    selectedPackages.clear();
}

function onBatchCheck(cb) {
    if (cb.checked) selectedPackages.add(cb.value);
    else selectedPackages.delete(cb.value);
    updateBatchCount();
}

function filterBatchItems() {
    const query = document.querySelector('.batch-filter-input')?.value?.toLowerCase() || '';
    document.querySelectorAll('.batch-select-item').forEach(item => {
        const name = item.querySelector('.batch-item-name')?.textContent?.toLowerCase() || '';
        item.style.display = !query || name.includes(query) ? 'flex' : 'none';
    });
}

function selectAllBatch(select) {
    document.querySelectorAll('.batch-select-item .batch-check').forEach(cb => {
        cb.checked = select;
        if (select) selectedPackages.add(cb.value);
        else selectedPackages.delete(cb.value);
    });
    updateBatchCount();
}

function updateBatchCount() {
    document.getElementById('batch-select-count').textContent = `已选 ${selectedPackages.size} 项`;
}

function executeBatch() {
    const names = Array.from(selectedPackages);
    if (names.length === 0) {
        showToast('请至少选择一个包', 'warning');
        return;
    }

    const mode = batchMode; // 保存模式，closeBatchModal() 会清空 batchMode
    closeBatchModal();

    if (mode === 'uninstall') {
        if (!checkCanWrite('批量卸载')) return;
        showConfirm(`确认卸载 <strong>${names.length}</strong> 个包吗？此操作不可撤销。`, () => {
            openTerminal(`批量卸载 (${names.length} 个)`);
            streamCommand('/api/batch/uninstall', { names }, (exitCode) => {
                showToast(exitCode === 0 ? '批量卸载完成' : '处理完成（查看终端详情）', exitCode === 0 ? 'success' : 'warning');
                loadPackages();
                loadDashboard();
            });
        }, names);
    } else if (mode === 'pin') {
        if (!checkCanWrite('批量固定')) return;
        showConfirm(`确认固定 <strong>${names.length}</strong> 个包吗？固定后不会随 brew upgrade 自动升级。`, () => {
            openTerminal(`批量固定 (${names.length} 个)`);
            streamCommand('/api/batch/pin', { names }, (exitCode) => {
                showToast(exitCode === 0 ? '批量固定完成' : '处理完成（查看终端详情）', exitCode === 0 ? 'success' : 'warning');
                loadPackages();
                loadDashboard();
            });
        }, names);
    }
}

// Close batch modal on overlay click
document.getElementById('batch-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeBatchModal();
});

// ===== Pin/Unpin =====
function togglePin(name, isPinned) {
    if (!checkCanWrite(isPinned ? '取消固定' : '固定')) return;
    const action = isPinned ? 'unpin' : 'pin';
    fetch('/api/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, action }),
    }).then(r => r.json()).then(data => {
        showToast(data.success ? `${name} ${action === 'pin' ? '已固定' : '已取消固定'}` : (data.error || '操作失败'), data.success ? 'success' : 'error');
        if (data.success) {
            loadPackages();
            loadDashboard();
        }
    });
}

// ===== Package Homepage =====
async function openHomepage(name) {
    try {
        const res = await fetch(`/api/home/${encodeURIComponent(name)}`);
        const data = await res.json();
        if (data.homepage) {
            window.open(data.homepage, '_blank');
        } else {
            showToast('未找到主页链接', 'warning');
        }
    } catch (err) {
        showToast('获取主页失败', 'error');
    }
}

// ===== Package Info =====
async function showPackageInfo(name) {
    try {
        const res = await fetch(`/api/package/${encodeURIComponent(name)}`);
        const info = await res.json();
        if (info.error) { showToast(info.error, 'error'); return; }

        document.getElementById('modal-title').textContent = name;
        const body = document.getElementById('modal-body');
        let html = '';
        if (info.desc) html += `<p style="margin-bottom:16px;color:var(--text-secondary)">${escapeHtml(info.desc)}</p>`;

        const rows = [];
        if (info.full_name) rows.push(['全名', info.full_name]);
        if (info.tap) rows.push(['来源', info.tap]);
        if (info.homepage) rows.push(['主页', `<a href="${info.homepage}" target="_blank">${info.homepage}</a>`]);
        if (info.license) rows.push(['许可证', info.license]);
        if (info.versions) {
            if (info.versions.stable) rows.push(['稳定版', info.versions.stable]);
            if (info.versions.head) rows.push(['HEAD', info.versions.head]);
        }
        if (info.installed && info.installed.length > 0) {
            const inst = info.installed[0];
            rows.push(['已安装版本', inst.version || '—']);
            if (inst.poured_from_bottle !== undefined) rows.push(['来源', inst.poured_from_bottle ? '预编译瓶' : '源码编译']);
        }
        if (info.keg_only) rows.push(['Keg Only', info.keg_only_reason || 'Yes']);

        html += rows.map(([label, value]) => `
            <div class="info-row"><span class="info-label">${label}</span><span class="info-value">${typeof value === 'string' ? value : JSON.stringify(value)}</span></div>
        `).join('');

        html += `<div style="margin-top:16px;display:flex;gap:8px">
            ${info.homepage ? `<button class="action-btn" onclick="window.open('${info.homepage}','_blank')">🌐 打开主页</button>` : ''}
            <button class="action-btn" onclick="analyzeDepsFor('${escapeHtml(name)}');closeModal()">🔗 分析依赖</button>
        </div>`;

        body.innerHTML = html;
        document.getElementById('package-modal').classList.add('active');
    } catch (err) { showToast('获取包信息失败', 'error'); }
}

function closeModal() { document.getElementById('package-modal').classList.remove('active'); }
document.getElementById('package-modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(); });

// ===== Search =====
async function doSearch(presetQuery = null) {
    const query = presetQuery || document.getElementById('search-input').value.trim();
    const resultsDiv = document.getElementById('search-results');
    const recDiv = document.getElementById('search-recommendations');

    if (query.length < 2) {
        resultsDiv.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><p>请输入至少2个字符进行搜索</p></div>';
        return;
    }
    resultsDiv.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>搜索中...</p></div>';
    if (recDiv) recDiv.style.display = 'none';

    try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        if (data.results.length === 0) {
            resultsDiv.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><p>没有找到 "${escapeHtml(query)}" 相关的结果</p></div>`;
            if (recDiv) recDiv.style.display = 'block';
            return;
        }

        resultsDiv.innerHTML = data.results.map(r => `
            <div class="search-result-item">
                <div class="pkg-icon ${r.type}">${r.type === 'cask' ? '🍏' : '🧪'}</div>
                <div class="search-result-info">
                    <span class="result-name">${escapeHtml(r.name)}</span>
                    <span class="result-type">${r.type}</span>
                    ${r.description ? `<span class="search-result-desc" title="${escapeHtml(r.description)}">${escapeHtml(r.description)}</span>` : ''}
                </div>
                <div class="search-result-actions">
                    ${r.homepage ? `<button class="home-btn" onclick="window.open('${escapeHtml(r.homepage)}','_blank')" title="打开主页">🌐</button>` : '<span class="home-btn-placeholder"></span>'}
                    <button class="info-btn" onclick="showPackageInfo('${escapeHtml(r.name)}')" title="查看详情">详情</button>
                    <button class="install-btn" onclick="installPackage('${escapeHtml(r.name)}', ${r.type === 'cask'})">安装</button>
                </div>
            </div>
        `).join('');
    } catch (err) { resultsDiv.innerHTML = '<div class="empty-state"><p>搜索失败</p></div>'; }
}

function checkCanWrite(action) {
    if (!canWrite) {
        appendTerminal(`⛔ 写操作不可用 (${action}) — 请在 macOS 终端中运行 ./run.sh`, 'error');
        toggleTerminal(true);
        return false;
    }
    return true;
}

function installPackage(name, isCask) {
    if (!checkCanWrite('安装')) return;
    showConfirm(`确认安装 <strong>${escapeHtml(name)}</strong> 吗？`, () => {
        openTerminal(`安装 ${name}`);
        streamCommand('/api/install', { name, is_cask: isCask }, (exitCode) => {
            showToast(exitCode === 0 ? `${name} 安装完成` : '处理完成（查看终端详情）', exitCode === 0 ? 'success' : 'warning');
            loadPackages();
            loadDashboard();
        });
    });
}

function uninstallPackage(name, isCask) {
    if (!checkCanWrite('卸载')) return;
    showConfirm(`确认卸载 <strong>${escapeHtml(name)}</strong> 吗？此操作不可撤销。`, () => {
        openTerminal(`卸载 ${name}`);
        streamCommand('/api/uninstall', { name, is_cask: isCask }, (exitCode) => {
            showToast(exitCode === 0 ? `${name} 已卸载` : '处理完成（查看终端详情）', exitCode === 0 ? 'success' : 'warning');
            loadPackages();
            loadDashboard();
        });
    });
}

// ===== Updates =====
async function loadOutdated() {
    const list = document.getElementById('outdated-list');
    list.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>检查中...</p></div>';
    try {
        const res = await fetch('/api/outdated');
        const data = await res.json();
        if (data.outdated.length === 0) {
            list.innerHTML = '<div class="empty-state"><div class="empty-icon">✅</div><p>所有包都是最新的！</p></div>';
            document.getElementById('stat-outdated').textContent = data.total;
            return;
        }

        // 按 type 分组
        const formulae = data.outdated.filter(p => p.type !== 'cask');
        const casks = data.outdated.filter(p => p.type === 'cask');

        function renderItem(p) {
            return `
                <div class="outdated-item">
                    <div class="pkg-icon ${p.type}">${p.type === 'cask' ? '🍏' : '🧪'}</div>
                    <div class="outdated-name">${escapeHtml(p.name)}</div>
                    <div class="outdated-info">${escapeHtml(p.info)}</div>
                    <button class="pkg-action-btn" onclick="upgradePackage('${escapeHtml(p.name)}')">升级</button>
                </div>
            `;
        }

        function renderColumn(title, icon, items) {
            if (items.length === 0) {
                return `
                    <div class="outdated-column">
                        <div class="outdated-column-header"><span class="outdated-column-icon">${icon}</span><span>${title}</span><span class="outdated-column-count">0</span></div>
                        <div class="outdated-column-empty">暂无更新</div>
                    </div>
                `;
            }
            return `
                <div class="outdated-column">
                    <div class="outdated-column-header"><span class="outdated-column-icon">${icon}</span><span>${title}</span><span class="outdated-column-count">${items.length}</span></div>
                    <div class="outdated-column-items">
                        ${items.map(renderItem).join('')}
                    </div>
                </div>
            `;
        }

        list.innerHTML = `
            <div class="outdated-columns">
                ${renderColumn('Formulae', '🧪', formulae)}
                ${renderColumn('Casks', '🍏', casks)}
            </div>
        `;
        document.getElementById('stat-outdated').textContent = data.total;
    } catch (err) { list.innerHTML = '<div class="empty-state"><p>检查失败</p></div>'; }
}

function runUpdate() {
    if (!checkCanWrite('仓库更新')) return;
    openTerminal('brew update');
    streamCommand('/api/update', {}, (exitCode) => {
        showToast(exitCode === 0 ? '仓库更新完成' : '处理完成（查看终端详情）', exitCode === 0 ? 'success' : 'warning');
        loadDashboard();
    });
}

function runUpgradeAll() {
    if (!checkCanWrite('全部升级')) return;
    showConfirm('确认升级所有可更新的包吗？', () => {
        openTerminal('brew upgrade');
        streamCommand('/api/upgrade', {}, (exitCode) => {
            showToast(exitCode === 0 ? '升级完成' : '处理完成（查看终端详情）', exitCode === 0 ? 'success' : 'warning');
            loadDashboard();
            loadPackages();
        });
    });
}

function upgradePackage(name) {
    if (!checkCanWrite('升级')) return;
    showConfirm(`确认升级 <strong>${escapeHtml(name)}</strong> 吗？`, () => {
        openTerminal(`升级 ${name}`);
        streamCommand('/api/upgrade', { name }, (exitCode) => {
            showToast(exitCode === 0 ? `${name} 升级完成` : '处理完成（查看终端详情）', exitCode === 0 ? 'success' : 'warning');
            loadOutdated();
            loadDashboard();
        });
    });
}

// ===== Dependencies =====
function analyzeDeps() {
    const name = document.getElementById('deps-search-input').value.trim();
    if (!name) { showToast('请输入包名', 'warning'); return; }
    analyzeDepsFor(name);
}

async function analyzeDepsFor(name) {
    // Switch to deps tab first
    switchTab('deps');
    document.getElementById('deps-search-input').value = name;

    const container = document.getElementById('deps-result');
    container.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>分析依赖中...</p></div>';

    try {
        const res = await fetch(`/api/deps/${encodeURIComponent(name)}`);
        const data = await res.json();

        let html = `<div class="deps-header"><h2>${escapeHtml(name)}</h2></div>`;

        if (data.dep_tree) {
            html += `<h3 style="font-size:14px;font-weight:600;margin-bottom:8px;color:var(--text-secondary)">📦 依赖树</h3>`;
            html += `<pre class="dep-tree"><span class="dep-root">${escapeHtml(name)}</span>\n${escapeHtml(data.dep_tree)}</pre>`;
        } else {
            html += `<p style="color:var(--text-tertiary);margin-bottom:16px">无依赖或无数据</p>`;
        }

        if (data.dependents.length > 0) {
            html += `<h3 style="font-size:14px;font-weight:600;margin:16px 0 8px;color:var(--text-secondary)">⬆️ 被以下包依赖</h3>`;
            html += `<div class="dependents-list">${data.dependents.map(d => `<span class="dependent-tag" style="cursor:pointer" onclick="analyzeDepsFor('${escapeHtml(d)}')">${escapeHtml(d)}</span>`).join('')}</div>`;
        } else {
            html += `<p style="color:var(--text-tertiary);margin-top:16px">没有被任何已安装包依赖</p>`;
        }

        container.innerHTML = html;
    } catch (err) {
        container.innerHTML = `<div class="empty-state"><p>分析失败</p></div>`;
    }
}

function runAutoremove() {
    if (!checkCanWrite('清理依赖')) return;
    showConfirm('确认运行 brew autoremove 清理孤儿依赖吗？', () => {
        openTerminal('brew autoremove');
        streamCommand('/api/autoremove', {}, (exitCode) => {
            showToast(exitCode === 0 ? '清理完成' : '处理完成（查看终端详情）', exitCode === 0 ? 'success' : 'warning');
            loadDashboard();
        });
    });
}

// ===== Taps =====
async function loadTaps() {
    const list = document.getElementById('tap-list');
    list.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>加载中...</p></div>';
    try {
        const res = await fetch('/api/taps');
        const data = await res.json();
        if (data.taps.length === 0) {
            list.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><p>没有配置任何 tap 源</p></div>';
            return;
        }
        list.innerHTML = data.taps.map(t => `
            <div class="tap-item">
                <div class="tap-info"><span class="tap-name">${escapeHtml(t.name)}</span>${t.pinned ? '<span class="tap-pinned-badge">已固定</span>' : ''}</div>
                <div class="tap-actions">
                    <button class="pkg-action-btn" onclick="tapInfo('${escapeHtml(t.name)}')">详情</button>
                    <button class="pkg-action-btn danger" onclick="removeTap('${escapeHtml(t.name)}')">移除</button>
                </div>
            </div>
        `).join('');
    } catch (err) { list.innerHTML = '<div class="empty-state"><p>加载失败</p></div>'; }
}

async function searchTaps() { /* ... unchanged ... */
    const input = document.getElementById('tap-search-input');
    const query = input.value.trim();
    if (!query) { showToast('请输入搜索关键词', 'warning'); return; }
    const container = document.getElementById('tap-search-results');
    container.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>搜索 GitHub 中...</p></div>';
    container.style.display = 'block';
    try {
        const res = await fetch('/api/tap/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
        const data = await res.json();
        if (data.error) { container.innerHTML = `<div class="empty-state"><p>${escapeHtml(data.error)}</p></div>`; return; }
        if (data.results.length === 0) { container.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><p>未找到匹配的 tap 源</p></div>'; return; }
        container.innerHTML = `
            <div class="tap-results-header"><span>找到 <strong>${data.results.length}</strong> 个相关 tap 源</span><button class="tap-results-clear" onclick="clearTapSearch()">✕ 清除</button></div>
            ${data.results.map(r => `
                <div class="tap-result-item">
                    <div class="tap-result-info">
                        <a class="tap-result-name" href="${escapeHtml(r.html_url)}" target="_blank">${escapeHtml(r.tap_name)}</a>
                        <span class="tap-result-repo">${escapeHtml(r.full_name)}</span>
                        ${r.description ? `<span class="tap-result-desc">${escapeHtml(r.description)}</span>` : ''}
                        <span class="tap-result-meta">⭐ ${r.stars.toLocaleString()}</span>
                    </div>
                    <button class="tap-install-btn" onclick="installTap('${escapeHtml(r.tap_name)}')">安装</button>
                </div>
            `).join('')}
        `;
    } catch (err) { container.innerHTML = `<div class="empty-state"><p>搜索失败: ${escapeHtml(err.message)}</p></div>`; }
}

function clearTapSearch() {
    document.getElementById('tap-search-results').style.display = 'none';
    document.getElementById('tap-search-results').innerHTML = '';
    document.getElementById('tap-search-input').value = '';
}

function installTap(name) {
    if (!checkCanWrite('安装 tap')) return;
    openTerminal(`安装 tap: ${name}`);
    streamCommand('/api/tap/add', { name }, (exitCode) => {
        showToast(exitCode === 0 ? `tap ${name} 安装成功` : '处理完成（查看终端详情）', exitCode === 0 ? 'success' : 'warning');
        loadTaps();
        clearTapSearch();
    });
}

function removeTap(name) {
    if (!checkCanWrite('移除 tap')) return;
    showConfirm(`确认移除 tap <strong>${escapeHtml(name)}</strong> 吗？`, () => {
        openTerminal(`移除 tap: ${name}`);
        streamCommand('/api/tap/remove', { name }, (exitCode) => {
            showToast(exitCode === 0 ? `tap ${name} 已移除` : '处理完成（查看终端详情）', exitCode === 0 ? 'success' : 'warning');
            loadTaps();
        });
    });
}

function tapInfo(name) {
    openTerminal(`tap 信息: ${name}`);
    streamCommand('/api/command', { args: ['tap-info', name] }, (exitCode) => {
        showToast(exitCode === 0 ? '信息获取完成' : '完成（查看终端详情）', exitCode === 0 ? 'info' : 'warning');
    });
}

// ===== Disk Usage =====
async function loadDiskUsage() {
    const summary = document.getElementById('space-summary');
    const list = document.getElementById('pkg-size-list');
    summary.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>分析中...</p></div>';
    list.innerHTML = '';

    try {
        const res = await fetch('/api/disk-usage');
        const data = await res.json();

        summary.innerHTML = `
            <div class="space-card total"><div class="space-label">总计</div><div class="space-value">${data.total_human}</div></div>
            <div class="space-card"><div class="space-label">Cellar</div><div class="space-value">${data.cellar.human}</div></div>
            <div class="space-card"><div class="space-label">Caskroom</div><div class="space-value">${data.caskroom.human}</div></div>
            <div class="space-card"><div class="space-label">lib</div><div class="space-value">${data.lib.human}</div></div>
            <div class="space-card"><div class="space-label">share</div><div class="space-value">${data.share.human}</div></div>
            <div class="space-card"><div class="space-label">opt</div><div class="space-value">${data.opt.human}</div></div>
        `;

        if (data.packages.length > 0) {
            const maxSize = data.packages[0].size;
            list.innerHTML = data.packages.map((p, i) => `
                <div class="pkg-size-item">
                    <span class="pkg-size-rank">#${i + 1}</span>
                    <span class="pkg-size-name">${escapeHtml(p.name)}</span>
                    <span class="pkg-size-type ${p.type || 'formula'}">${p.type === 'cask' ? 'cask' : 'formula'}</span>
                    <span class="pkg-size-bar-bg"><span class="pkg-size-bar-fill" style="width:${(p.size / maxSize * 100).toFixed(0)}%"></span></span>
                    <span class="pkg-size-val">${p.size_human}</span>
                </div>
            `).join('');
        } else {
            list.innerHTML = '<div class="empty-state"><p>无数据</p></div>';
        }
    } catch (err) {
        summary.innerHTML = '<div class="empty-state"><p>分析失败</p></div>';
    }
}

// ===== Cache =====
async function loadCache() {
    const info = document.getElementById('cache-info');
    if (!info) return;
    try {
        const res = await fetch('/api/cache');
        const data = await res.json();
        info.innerHTML = `
            <div class="cache-stats">
                <div class="cache-stat"><div class="cache-stat-val">${data.size_human}</div><div class="cache-stat-label">缓存总大小</div></div>
                <div class="cache-stat"><div class="cache-stat-val">${data.file_count}</div><div class="cache-stat-label">文件数</div></div>
            </div>
            <div class="cache-path">📁 ${escapeHtml(data.path)}</div>
        `;
    } catch (err) { info.innerHTML = '<div class="empty-state"><p>加载失败</p></div>'; }
}

function clearCache() {
    if (!checkCanWrite('清理缓存')) return;
    showConfirm('确认清理 Homebrew 下载缓存吗？', () => {
        openTerminal('brew cleanup --prune=all');
        streamCommand('/api/cache/clear', {}, (exitCode) => {
            showToast(exitCode === 0 ? '缓存清理完成' : '处理完成（查看终端详情）', exitCode === 0 ? 'success' : 'warning');
            loadCache();
        });
    });
}

// ===== Brewfile =====
function getBrewfilePath() {
    const input = document.getElementById('brewfile-path').value.trim();
    return input || '';
}

async function exportBrewfile() {
    if (!checkCanWrite('导出 Brewfile')) return;
    const path = getBrewfilePath();
    try {
        const res = await fetch('/api/brewfile/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path }),
        });
        const data = await res.json();
        if (data.success) {
            showToast('Brewfile 导出成功', 'success');
            document.getElementById('brewfile-editor').value = data.content;
            document.getElementById('brewfile-path').value = data.path;
            document.getElementById('brewfile-stats').innerHTML = '';
        } else {
            showToast(data.error || '导出失败', 'error');
        }
    } catch (err) { showToast('导出失败', 'error'); }
}

async function previewBrewfile() {
    const path = getBrewfilePath();
    try {
        const res = await fetch('/api/brewfile/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path }),
        });
        const data = await res.json();
        if (data.error) { showToast(data.error, 'error'); return; }
        document.getElementById('brewfile-editor').value = data.content;
        document.getElementById('brewfile-path').value = data.path;
        document.getElementById('brewfile-stats').innerHTML = `<span>📦 ${data.count} 个包</span><span>📁 ${escapeHtml(data.path)}</span>`;
    } catch (err) { showToast('加载失败', 'error'); }
}

function installBrewfile() {
    if (!checkCanWrite('安装 Brewfile')) return;
    const path = getBrewfilePath();
    showConfirm('确认从 Brewfile 批量安装吗？这可能需要较长时间。', () => {
        openTerminal('brew bundle install');
        streamCommand('/api/brewfile/install', { path }, (exitCode) => {
            showToast(exitCode === 0 ? 'Brewfile 安装完成' : '处理完成（查看终端详情）', exitCode === 0 ? 'success' : 'warning');
            loadDashboard();
            loadPackages();
        });
    });
}

// ===== System Info =====
async function loadSystemInfo() {
    const card = document.getElementById('system-info-card');
    const grid = document.getElementById('info-grid');
    card.style.display = 'block';
    grid.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>加载中...</p></div>';
    try {
        const res = await fetch('/api/system-info');
        const data = await res.json();
        const labels = {
            macos_version: 'macOS 版本', arch: '芯片架构', processor: '处理器',
            brew_prefix: 'Homebrew 前缀', brew_path: 'Brew 路径',
            xcode_clt_installed: 'Xcode CLT', xcode_clt_path: 'CLT 路径',
            shell: 'Shell', python_version: 'Python 版本',
            homebrew_prefix: 'HOMEBREW_PREFIX', homebrew_cellar: 'HOMEBREW_CELLAR',
            homebrew_repository: 'HOMEBREW_REPOSITORY', homebrew_cache: 'HOMEBREW_CACHE',
            homebrew_temp: 'HOMEBREW_TEMP',
        };
        grid.innerHTML = Object.entries(data).map(([key, val]) => {
            if (key.startsWith('_')) return '';
            if (key === 'xcode_clt_installed') {
                val = val ? '已安装' : '未安装';
            }
            return `<div class="info-card"><div class="info-card-label">${labels[key] || key}</div><div class="info-card-value">${escapeHtml(String(val || '—'))}</div></div>`;
        }).join('');
    } catch (err) { grid.innerHTML = '<div class="empty-state"><p>加载失败</p></div>'; }
}

// ===== Search Recommendations =====
function loadSearchRecommendations() {
    const container = document.getElementById('recommend-tags');
    if (!container || container.dataset.loaded) return;
    container.dataset.loaded = '1';
    const recommendations = [
        { name: 'git', type: 'formula', desc: '分布式版本控制系统' },
        { name: 'node', type: 'formula', desc: 'JavaScript 运行环境' },
        { name: 'python', type: 'formula', desc: 'Python 编程语言' },
        { name: 'wget', type: 'formula', desc: '命令行下载工具' },
        { name: 'tree', type: 'formula', desc: '目录树显示工具' },
        { name: 'htop', type: 'formula', desc: '交互式进程查看器' },
        { name: 'rectangle', type: 'cask', desc: 'macOS 窗口管理工具' },
        { name: 'visual-studio-code', type: 'cask', desc: '代码编辑器' },
        { name: 'google-chrome', type: 'cask', desc: 'Chrome 浏览器' },
        { name: 'iina', type: 'cask', desc: '现代 macOS 视频播放器' },
        { name: 'firefox', type: 'cask', desc: 'Firefox 浏览器' },
        { name: 'docker', type: 'cask', desc: '容器化平台' },
    ];
    container.innerHTML = recommendations.map(r => {
        const badge = r.type === 'cask'
            ? '<span class="rec-badge cask">Cask</span>'
            : '<span class="rec-badge formula">Formula</span>';
        return `<button class="recommend-tag" onclick="doSearch('${escapeHtml(r.name)}'); document.getElementById('search-input').value='${escapeHtml(r.name)}'" title="${escapeHtml(r.desc)}">${escapeHtml(r.name)} ${badge}</button>`;
    }).join('');
}

// ===== History =====
async function loadHistory() {
    const list = document.getElementById('history-list');
    list.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>加载中...</p></div>';
    try {
        const res = await fetch('/api/history');
        const data = await res.json();
        if (data.history.length === 0) {
            list.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><p>暂无操作记录</p></div>';
            return;
        }
        list.innerHTML = data.history.map(h => {
            let opCls = 'other';
            if (h.operation.includes('安装')) opCls = 'install';
            else if (h.operation.includes('卸载')) opCls = 'uninstall';
            else if (h.operation.includes('升级')) opCls = 'upgrade';
            return `<div class="history-item">
                <span class="history-time">${escapeHtml(h.time)}</span>
                <span class="history-op ${opCls}">${escapeHtml(h.operation)}</span>
                <span class="history-pkg">${escapeHtml(h.package)}</span>
                <span class="history-result">${escapeHtml(h.result)}</span>
            </div>`;
        }).join('');
    } catch (err) { list.innerHTML = '<div class="empty-state"><p>加载失败</p></div>'; }
}

function clearHistory() {
    showConfirm('确认清空所有操作历史记录吗？', async () => {
        try {
            const res = await fetch('/api/history/clear', { method: 'POST' });
            await res.json();
            showToast('历史记录已清空', 'success');
            loadHistory();
        } catch (err) { showToast('清空失败', 'error'); }
    });
}

// ===== Services =====
async function loadServices() {
    const list = document.getElementById('services-list');
    if (!list) return;
    try {
        const res = await fetch('/api/services');
        const data = await res.json();
        if (data.services.length === 0) {
            list.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><p>没有运行中的服务</p></div>';
            return;
        }
        list.innerHTML = data.services.map(s => `
            <div class="service-item">
                <span class="service-name">${escapeHtml(s.name)}</span>
                <span class="service-status ${s.status}">${s.status}</span>
                <div class="service-actions">
                    ${s.status === 'started'
                        ? `<button class="service-btn" onclick="serviceAction('stop','${escapeHtml(s.name)}')">停止</button>
                           <button class="service-btn" onclick="serviceAction('restart','${escapeHtml(s.name)}')">重启</button>`
                        : `<button class="service-btn" onclick="serviceAction('start','${escapeHtml(s.name)}')">启动</button>`}
                </div>
            </div>
        `).join('');
    } catch (err) { list.innerHTML = '<div class="empty-state"><p>加载失败</p></div>'; }
}

function serviceAction(action, name) {
    openTerminal(`brew services ${action} ${name}`);
    streamCommand(`/api/service/${action}`, { name }, (exitCode) => {
        showToast(`服务 ${name} ${action} ${exitCode === 0 ? '完成' : '完成（查看终端）'}`, exitCode === 0 ? 'success' : 'warning');
        loadServices();
    });
}

function toggleServiceMonitor() {
    const checked = document.getElementById('service-auto-refresh')?.checked;
    if (checked) {
        startServiceMonitor();
    } else {
        stopServiceMonitor();
    }
}

function startServiceMonitor() {
    if (currentTab === 'services') {
        stopServiceMonitor();
        serviceMonitorInterval = setInterval(loadServices, 10000);
    }
}

function stopServiceMonitor() {
    if (serviceMonitorInterval) {
        clearInterval(serviceMonitorInterval);
        serviceMonitorInterval = null;
    }
}

// ===== Tools =====
function runDoctor() {
    openTerminal('brew doctor');
    streamCommand('/api/doctor', {}, (exitCode) => {
        showToast(exitCode === 0 ? '诊断完成' : '完成（查看终端详情）', exitCode === 0 ? 'info' : 'warning');
    });
}

function runCleanup(dryRun) {
    if (!dryRun && !checkCanWrite('清理')) return;
    const label = dryRun ? 'brew cleanup --dry-run（模拟）' : 'brew cleanup（实际清理）';
    if (!dryRun) {
        showConfirm('确认执行实际清理吗？这将删除旧版本文件。', () => {
            openTerminal(label);
            streamCommand('/api/cleanup', { dry_run: false }, (exitCode) => {
                showToast(exitCode === 0 ? '清理完成' : '完成（查看终端详情）', exitCode === 0 ? 'success' : 'warning');
                loadDashboard();
            });
        });
    } else {
        openTerminal(label);
        streamCommand('/api/cleanup', { dry_run: true }, (exitCode) => {
            showToast(exitCode === 0 ? '模拟清理完成' : '完成（查看终端详情）', exitCode === 0 ? 'info' : 'warning');
        });
    }
}

function runCommand(args) {
    const cmd = 'brew ' + args.join(' ');
    openTerminal(cmd);
    streamCommand('/api/command', { args }, (exitCode) => {
        showToast(exitCode === 0 ? '命令执行完成' : '完成（查看终端详情）', exitCode === 0 ? 'info' : 'warning');
    });
}

// ===== Force Interrupt =====
async function killProcess() {
    // Abort the streaming fetch first
    if (currentStreamController) {
        currentStreamController.abort();
        currentStreamController = null;
    }

    try {
        const res = await fetch('/api/kill', { method: 'POST' });
        if (!res.ok) {
            appendTerminal('中断请求失败 (HTTP ' + res.status + ')', 'error');
            setTerminalStatus('error');
            return;
        }
        const data = await res.json();
        if (data.success) {
            appendTerminal('⏹ ' + (data.message || '已发送中断信号'), 'warning');
            setTerminalStatus('done');
            showToast(data.message || '进程已中断', 'info');
        } else {
            appendTerminal('⏹ ' + (data.message || '无法中断'), 'warning');
            setTerminalStatus('done');
        }
    } catch (err) {
        appendTerminal('中断失败: 无法连接服务器（可能进程已退出）', 'error');
        setTerminalStatus('done');
    }
}

// ===== Shutdown Server =====
function shutdownServer() {
    showConfirm(
        '确认<strong>关闭 BrewMaster 后台进程</strong>吗？<br><span style="color:var(--text-tertiary);font-size:13px">关闭后页面将无法继续操作，需要重新运行 ./run.sh 启动服务。</span>',
        () => {
            // 先中止正在进行的流式请求
            if (currentStreamController) {
                currentStreamController.abort();
                currentStreamController = null;
            }
            const btn = document.getElementById('shutdown-btn');
            if (btn) { btn.disabled = true; btn.classList.add('shutting-down'); }

            appendTerminal('🔌 正在关闭 BrewMaster 后台进程...', 'warning');
            toggleTerminal(true);

            fetch('/api/shutdown', { method: 'POST' })
                .then(r => r.json())
                .then(data => {
                    showToast(data.message || '服务正在关闭...', 'success');
                })
                .catch(() => {
                    // 请求失败说明服务已退出，属于预期行为
                })
                .finally(() => {
                    // 短暂等待后切换到离线状态
                    setTimeout(showOfflineScreen, 800);
                });
        }
    );
}

function showOfflineScreen() {
    const overlay = document.createElement('div');
    overlay.className = 'offline-overlay';
    overlay.innerHTML = `
        <div class="offline-card">
            <div class="offline-icon">🍺</div>
            <h2>BrewMaster 已停止运行</h2>
            <p>后台服务已关闭，页面无法继续操作。</p>
            <p class="offline-hint">如需重新使用，请在终端中运行：</p>
            <code class="offline-cmd">cd brew-gui && ./run.sh</code>
            <button class="action-btn" onclick="location.reload()">尝试重新连接</button>
        </div>
    `;
    document.body.appendChild(overlay);
}

// ===== Terminal Management =====
function openTerminal(title) {
    const panel = document.getElementById('terminal-panel');
    panel.classList.remove('minimized');
    document.getElementById('terminal-title-text').textContent = title;
    document.getElementById('terminal-body').innerHTML = '';
    document.getElementById('terminal-status').textContent = '运行中...';
    document.getElementById('terminal-stop-btn').classList.add('visible');
    const dot = document.querySelector('.terminal-dot');
    dot.classList.add('running');
    dot.classList.remove('error');
}

function appendTerminal(text, className = '') {
    const body = document.getElementById('terminal-body');
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text + '\n';
    body.appendChild(span);
    body.scrollTop = body.scrollHeight;
}

function clearTerminal() {
    document.getElementById('terminal-body').innerHTML = '<span class="dim">已清空</span>\n';
}

function toggleTerminal(forceOpen = null) {
    const panel = document.getElementById('terminal-panel');
    if (forceOpen === true) panel.classList.remove('minimized');
    else if (forceOpen === false) panel.classList.add('minimized');
    else panel.classList.toggle('minimized');

    const btn = document.getElementById('terminal-toggle');
    const isMin = panel.classList.contains('minimized');
    btn.textContent = isMin ? '+' : '—';
}

function setTerminalStatus(status) {
    const statusEl = document.getElementById('terminal-status');
    const dot = document.querySelector('.terminal-dot');
    const stopBtn = document.getElementById('terminal-stop-btn');

    if (status === 'running') {
        statusEl.textContent = '运行中...';
        dot.classList.add('running');
        dot.classList.remove('error');
        stopBtn.classList.add('visible');
    } else if (status === 'done') {
        statusEl.textContent = '完成';
        dot.classList.remove('running', 'error');
        stopBtn.classList.remove('visible');
    } else if (status === 'error') {
        statusEl.textContent = '错误';
        dot.classList.remove('running');
        dot.classList.add('error');
        stopBtn.classList.remove('visible');
    } else if (status === 'warning') {
        statusEl.textContent = '完成（含警告）';
        dot.classList.remove('running', 'error');
        stopBtn.classList.remove('visible');
    }
}

// ===== Streaming =====
function streamCommand(url, body, onComplete) {
    if (currentStreamController) currentStreamController.abort();
    currentStreamController = new AbortController();
    setTerminalStatus('running');
    let exitCode = 0;

    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: currentStreamController.signal,
    }).then(response => {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        function processChunk({ done, value }) {
            if (done) {
                setTerminalStatus(exitCode === 0 ? 'done' : 'warning');
                currentStreamController = null;
                if (onComplete) onComplete(exitCode);
                return;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') {
                        setTerminalStatus(exitCode === 0 ? 'done' : 'warning');
                        currentStreamController = null;
                        if (onComplete) onComplete(exitCode);
                        return;
                    }
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.line) {
                            const txt = parsed.line;
                            const exitMatch = txt.match(/^__EXIT_CODE__:(-?\d+)$/);
                            if (exitMatch) {
                                exitCode = parseInt(exitMatch[1], 10);
                                continue;
                            }
                            let cls = '';
                            if (txt.includes('Error') || txt.includes('error') || txt.includes('FAILED') || txt.startsWith('ERROR:')) cls = 'error';
                            else if (txt.includes('Warning') || txt.includes('warning')) cls = 'warning';
                            else if (txt.includes('==>') || txt.includes('🍺') || txt.includes('already')) cls = 'info';
                            appendTerminal(txt, cls);
                        }
                    } catch (e) { /* skip */ }
                }
            }
            reader.read().then(processChunk);
        }
        reader.read().then(processChunk);
    }).catch(err => {
        if (err.name !== 'AbortError') {
            appendTerminal('Connection error: ' + err.message, 'error');
            setTerminalStatus('error');
            currentStreamController = null;
        }
    });
}

// ===== Confirm Dialog =====
let confirmCallback = null;

function showConfirm(message, onConfirm, detailList = null) {
    confirmCallback = onConfirm;
    const modal = document.getElementById('confirm-modal');
    const msgEl = document.getElementById('confirm-message');
    const detailEl = document.getElementById('confirm-detail-list');
    const okBtn = document.getElementById('confirm-ok-btn');

    msgEl.innerHTML = message;
    okBtn.textContent = '确认';

    if (detailList && detailList.length > 0) {
        detailEl.style.display = 'block';
        detailEl.innerHTML = detailList.map(item => 
            `<div class="confirm-detail-item">${escapeHtml(String(item))}</div>`
        ).join('');
    } else {
        detailEl.style.display = 'none';
    }

    okBtn.onclick = () => {
        const cb = confirmCallback;
        closeConfirm();
        if (cb) cb();
    };

    modal.style.display = 'flex';
}

function closeConfirm() {
    const modal = document.getElementById('confirm-modal');
    modal.style.display = 'none';
    confirmCallback = null;
}

document.getElementById('confirm-cancel-btn').addEventListener('click', closeConfirm);
document.getElementById('confirm-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('confirm-modal')) closeConfirm();
});

// ===== Toast =====
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// ===== Utilities =====
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ===== Keyboard Shortcuts =====
document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        switchTab('search');
        document.getElementById('search-input')?.focus();
    }
    if (e.key === 'Escape') closeModal();
});

// ===== 终端面板拖拽调整高度 =====
(function initTerminalResize() {
    const handle = document.getElementById('terminal-resize-handle');
    const panel = document.getElementById('terminal-panel');
    const body = document.getElementById('terminal-body');
    if (!handle || !panel || !body) return;

    let startY = 0;
    let startHeight = 0;

    function onDragStart(e) {
        if (panel.classList.contains('minimized')) return;
        e.preventDefault();
        startY = e.touches ? e.touches[0].clientY : e.clientY;
        startHeight = body.offsetHeight;
        panel.classList.add('dragging');
    }

    function onDragMove(e) {
        if (!panel.classList.contains('dragging')) return;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const deltaY = clientY - startY; // 正=向下拖(缩小), 负=向上拖(放大)
        const newHeight = Math.max(120, Math.min(700, startHeight - deltaY));
        body.style.maxHeight = newHeight + 'px';
    }

    function onDragEnd() {
        if (!panel.classList.contains('dragging')) return;
        panel.classList.remove('dragging');
    }

    handle.addEventListener('mousedown', onDragStart);
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
    handle.addEventListener('touchstart', onDragStart, { passive: false });
    document.addEventListener('touchmove', onDragMove, { passive: false });
    document.addEventListener('touchend', onDragEnd);
})();
