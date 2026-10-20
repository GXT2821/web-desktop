// 渲染进程：标签页与 webview 管理
//
// 只负责"打开/切换/关闭网页"，收藏数据的增删改在 library.js。
// 第一个标签是固定的「文档库」列表页，其余标签各对应一个 <webview>。
// 隐藏标签用 display:none（配合主进程的后台节流），未激活的页面不渲染。

(function () {
  'use strict';

  const Icons = window.Icons;
  const { el, clear, hostOf } = window.Dom;

  const dom = {};
  const tabs = [];
  let libraryTab = null;
  let activeTab = null;
  let lib = { folders: [], docs: [] };

  const docsById = () => new Map(lib.docs.map((doc) => [doc.id, doc]));

  // ==================== 标签页 ====================
  function createLibraryTab() {
    const label = el('span', { class: 'tab-label', text: '文档库' });
    const tabEl = el('div', { class: 'tab tab-fixed active', role: 'tab', tabindex: '0', title: '收藏列表（固定标签）' }, [
      el('span', { class: 'tab-icon' }, [Icons.node('book')]),
      label,
    ]);
    tabEl.addEventListener('click', () => activate(libraryTab));
    tabEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate(libraryTab);
      }
    });

    libraryTab = { kind: 'library', id: 'library', title: '文档库', tabEl, viewEl: dom.libraryView, webview: null };
    tabs.push(libraryTab);
    dom.tabbar.append(tabEl);
  }

  function createWebTab({ url, title, docId }) {
    const webview = document.createElement('webview');
    webview.setAttribute('src', url);
    // 允许 popup 才能让 window.open 走到主进程的 setWindowOpenHandler（改为应用内新标签）
    webview.setAttribute('allowpopups', '');

    const loadbar = el('div', { class: 'loadbar', hidden: true });
    const errorBox = el('div', { class: 'view-error', hidden: true });
    const viewEl = el('div', { class: 'view webview-wrap' }, [webview, loadbar, errorBox]);

    const label = el('span', { class: 'tab-label', text: title || hostOf(url) });
    const tabEl = el('div', { class: 'tab', role: 'tab', tabindex: '0', title: url }, [
      el('span', { class: 'tab-icon' }, [Icons.node('globe')]),
      label,
      el('button', { class: 'tab-close', type: 'button', title: '关闭标签' }, [Icons.node('close')]),
    ]);

    const item = {
      kind: 'web',
      id: `web_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      title: title || hostOf(url),
      url,
      currentUrl: url,
      docId: docId || null,
      ready: false,
      tabEl,
      viewEl,
      webview,
      loadbar,
      errorBox,
      label,
    };

    tabEl.addEventListener('click', (event) => {
      if (event.target.closest('.tab-close')) {
        event.stopPropagation();
        closeTab(item);
        return;
      }
      activate(item);
    });
    tabEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate(item);
      }
    });

    // ---- 网页事件 ----
    webview.addEventListener('dom-ready', () => {
      item.ready = true;
      updateToolbar();
    });

    webview.addEventListener('did-start-loading', () => {
      item.loadbar.hidden = false;
      tabEl.classList.add('busy');
      if (!errorBox.hidden) errorBox.hidden = true; // 重试时先收起错误页
    });

    webview.addEventListener('did-stop-loading', () => {
      item.loadbar.hidden = true;
      tabEl.classList.remove('busy');
      updateToolbar();
    });

    const syncUrl = (event) => {
      if (!event || !event.url) return;
      item.currentUrl = event.url;
      tabEl.title = event.url;
      if (activeTab === item) updateToolbar();
    };
    webview.addEventListener('did-navigate', syncUrl);
    webview.addEventListener('did-navigate-in-page', syncUrl);

    webview.addEventListener('page-title-updated', (event) => {
      const pageTitle = (event.title || '').trim();
      if (!pageTitle) return;
      if (item.docId) {
        // 标题还是自动占位时，用网页真实标题补全一次；标签文字仍跟随库里的标题，保持稳定
        const doc = docsById().get(item.docId);
        if (doc && doc.titleAuto) {
          window.api.autoTitle(item.docId, pageTitle).then(Library.absorb).catch(() => {});
        }
        return;
      }
      item.title = pageTitle;
      item.label.textContent = pageTitle;
      tabEl.title = item.currentUrl;
    });

    webview.addEventListener('did-fail-load', (event) => {
      if (event.isMainFrame === false) return;
      if (event.errorCode === -3) return; // -3 = ABORTED，通常是用户主动打断，忽略
      showLoadError(item, event);
    });

    tabs.push(item);
    dom.tabbar.append(tabEl);
    dom.content.append(viewEl);
    return item;
  }

  function showLoadError(item, event) {
    const url = event.validatedURL || item.currentUrl;
    clear(item.errorBox);
    item.errorBox.append(
      el('span', { class: 'err-icon' }, [Icons.node('alert')]),
      el('h2', { text: '页面加载失败' }),
      el('p', { text: `${event.errorDescription || '未知错误'}（${event.errorCode}）` }),
      el('p', { text: url }),
      el('div', { class: 'err-actions' }, [
        el('button', {
          class: 'btn-primary',
          type: 'button',
          text: '重试',
          onclick: () => {
            item.errorBox.hidden = true;
            try {
              item.webview.reload();
            } catch {
              item.webview.setAttribute('src', url);
            }
          },
        }),
        el('button', {
          class: 'btn-ghost',
          type: 'button',
          text: '用浏览器打开',
          onclick: () => window.api.openExternal(url).catch((err) => Library.toast(err.message, true)),
        }),
        el('button', {
          class: 'btn-ghost',
          type: 'button',
          text: '复制链接',
          onclick: () =>
            window.api.copyText(url).then(() => Library.toast('链接已复制')).catch((err) => Library.toast(err.message, true)),
        }),
      ])
    );
    item.errorBox.hidden = false;
    item.loadbar.hidden = true;
    item.tabEl.classList.remove('busy');
    if (activeTab === item) updateToolbar();
  }

  function activate(item) {
    if (!item) return;
    activeTab = item;
    for (const tab of tabs) {
      tab.tabEl.classList.toggle('active', tab === item);
      tab.viewEl.classList.toggle('active', tab === item);
    }
    updateToolbar();
    if (item.kind === 'web') {
      try {
        item.webview.focus();
      } catch {
        /* guest 还没准备好时忽略 */
      }
    }
    item.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function closeTab(item) {
    if (!item || item.kind === 'library') return;
    const idx = tabs.indexOf(item);
    if (idx === -1) return;
    tabs.splice(idx, 1);
    item.tabEl.remove();
    item.viewEl.remove(); // 移除 <webview> 会销毁对应 guest，链接与登录态仍留在 session 里
    if (activeTab === item) activate(tabs[Math.min(idx, tabs.length - 1)] || libraryTab);
  }

  // 打开已收藏的文档（同一个文档只开一个标签）
  function openDoc(doc) {
    if (!doc) return;
    const existing = tabs.find((tab) => tab.docId === doc.id);
    if (existing) {
      activate(existing);
      return;
    }
    const item = createWebTab({ url: doc.url, title: doc.title, docId: doc.id });
    activate(item);
    window.api.touchDoc(doc.id).then(Library.absorb).catch(() => {});
  }

  // 打开一个普通链接（来自网页里的 window.open / target=_blank）
  function openUrl(url, title) {
    if (!url) return;
    const existing = tabs.find((tab) => tab.kind === 'web' && tab.currentUrl === url);
    if (existing) {
      activate(existing);
      return;
    }
    activate(createWebTab({ url, title: title || hostOf(url), docId: null }));
  }

  // ==================== 网页工具条 ====================
  function updateToolbar() {
    const isWeb = activeTab && activeTab.kind === 'web';
    dom.webtoolbar.hidden = !isWeb;
    if (!isWeb) return;

    const url = activeTab.currentUrl || activeTab.url;
    dom.addr.textContent = url;
    dom.addr.title = url;

    let canGoBack = false;
    try {
      canGoBack = activeTab.ready && activeTab.webview.canGoBack();
    } catch {
      canGoBack = false;
    }
    dom.navBack.disabled = !canGoBack;
  }

  function bindToolbar() {
    dom.navBack.addEventListener('click', () => {
      if (!activeTab || activeTab.kind !== 'web') return;
      try {
        activeTab.webview.goBack();
      } catch {
        /* 忽略 */
      }
    });

    dom.navReload.addEventListener('click', () => {
      if (!activeTab || activeTab.kind !== 'web') return;
      try {
        activeTab.webview.reload();
      } catch {
        /* 忽略 */
      }
    });

    dom.navCopy.addEventListener('click', () => {
      if (!activeTab || activeTab.kind !== 'web') return;
      const url = activeTab.currentUrl || activeTab.url;
      window.api.copyText(url).then(() => Library.toast('链接已复制')).catch((err) => Library.toast(err.message, true));
    });

    dom.navExternal.addEventListener('click', () => {
      if (!activeTab || activeTab.kind !== 'web') return;
      const url = activeTab.currentUrl || activeTab.url;
      window.api.openExternal(url).catch((err) => Library.toast(err.message, true));
    });
  }

  // 库里标题变化时，同步更新对应标签的文字
  function syncTabLabels() {
    const map = docsById();
    for (const tab of tabs) {
      if (!tab.docId) continue;
      const doc = map.get(tab.docId);
      if (doc && doc.title !== tab.title) {
        tab.title = doc.title;
        tab.label.textContent = doc.title;
      }
    }
  }

  // ==================== 侧栏折叠 ====================
  const SIDEBAR_KEY = 'docvault.sidebarCollapsed';

  function setSidebarCollapsed(collapsed, { persist = true } = {}) {
    dom.app.classList.toggle('collapsed', collapsed);
    dom.collapseBtn.title = collapsed ? '展开侧栏' : '折叠侧栏';
    dom.collapseBtn.setAttribute('aria-label', dom.collapseBtn.title);
    dom.collapseBtn.setAttribute('aria-expanded', String(!collapsed));
    if (persist) {
      try {
        localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
      } catch {
        /* 隐私模式等场景下写不了，忽略 */
      }
    }
  }

  function bindSidebar() {
    dom.app = document.querySelector('.app');
    dom.collapseBtn = document.getElementById('collapseBtn');
    dom.collapseBtn.addEventListener('click', () => {
      setSidebarCollapsed(!dom.app.classList.contains('collapsed'));
    });

    let stored = null;
    try {
      stored = localStorage.getItem(SIDEBAR_KEY);
    } catch {
      /* 忽略 */
    }
    setSidebarCollapsed(stored === '1', { persist: false });
  }

  // ==================== 快捷键 ====================
  function handleShortcut(key) {
    if (key === 'n') {
      Library.addDocDialog({ folderId: null });
    } else if (key === 'f') {
      activate(libraryTab);
      // 侧栏收起时搜索框不可见，先展开再聚焦，否则键盘聚焦会落空
      if (dom.app.classList.contains('collapsed')) setSidebarCollapsed(false);
      Library.focusSearch();
    } else if (key === 'w') {
      if (activeTab && activeTab.kind === 'web') closeTab(activeTab);
    } else if (key === 'r') {
      if (activeTab && activeTab.kind === 'web') {
        try {
          activeTab.webview.reload();
        } catch {
          /* 忽略 */
        }
      }
    } else if (/^[1-9]$/.test(key)) {
      const target = tabs[Number(key) - 1];
      if (target) activate(target);
    }
  }

  function onModKey(event) {
    if (!event.metaKey && !event.ctrlKey) return;
    const key = String(event.key || '').toLowerCase();
    if (!/^([1-9]|w|n|f|r)$/.test(key)) return;
    event.preventDefault();
    handleShortcut(key);
  }

  // ==================== 启动 ====================
  function cacheDom() {
    dom.tabbar = document.getElementById('tabbar');
    dom.content = document.getElementById('content');
    dom.libraryView = document.getElementById('libraryView');
    dom.webtoolbar = document.getElementById('webtoolbar');
    dom.addr = document.getElementById('addr');
    dom.navBack = document.getElementById('navBack');
    dom.navReload = document.getElementById('navReload');
    dom.navCopy = document.getElementById('navCopy');
    dom.navExternal = document.getElementById('navExternal');
  }

  async function boot() {
    cacheDom();
    Icons.hydrate(document);
    bindSidebar();
    createLibraryTab();
    activate(libraryTab);
    bindToolbar();
    document.addEventListener('keydown', onModKey);

    // 主进程拦截到网页弹窗 → 在应用内开新标签
    window.api.onOpenTab((url) => openUrl(url));
    // 网页标签获得焦点时，快捷键由主进程转发过来
    window.api.onShortcut((key) => handleShortcut(key));

    await Library.init({
      openDoc,
      showLibrary: () => activate(libraryTab),
      onLibrary: (snapshot) => {
        lib = snapshot;
        syncTabLabels();
      },
    });
  }

  boot();
})();