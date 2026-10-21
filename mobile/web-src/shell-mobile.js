// Android 端的"外壳"：没有标签页、没有内嵌浏览器，文档一律交给系统浏览器打开
//
// 桌面端 shell.js 负责标签页 / webview / 下载面板；Android 上这些都不存在，
// 所以只保留三件事：打开文档、折叠侧栏、导入（导出放在桌面端做）。

(function () {
  'use strict';

  const { el, clear } = window.Dom;

  const modalRoot = document.getElementById('modalRoot');
  const modalBox = document.getElementById('modalBox');
  const modalBackdrop = document.getElementById('modalBackdrop');
  const importFile = document.getElementById('importFile');

  function openModal(node) {
    clear(modalBox);
    modalBox.append(node);
    modalRoot.hidden = false;
    const focusTarget =
      modalBox.querySelector('[data-autofocus]') || modalBox.querySelector('input, textarea, button');
    if (focusTarget) focusTarget.focus();
  }

  function closeModal() {
    modalRoot.hidden = true;
    clear(modalBox);
  }

  modalBackdrop.addEventListener('click', closeModal);

  // ---------- 打开文档 ----------

  function openDoc(doc) {
    if (!doc) return;
    if (isNarrow()) setDrawer(false);
    // 先记一笔"最近打开"，再交给系统浏览器；打不开就提示，不让界面假装成功
    window.api
      .touchDoc(doc.id)
      .then((lib) => window.Library.absorb(lib))
      .catch(() => {});
    window.api.openExternal(doc.url).catch((err) => {
      window.Library.toast(`打不开这个链接：${err.message}`, true);
    });
  }

  // ---------- 侧栏折叠 ----------

  const SIDEBAR_KEY = 'docvault.sidebarCollapsed';
  const DRAWER_BREAKPOINT = 640; // 小于等于这个宽度（竖屏手机/窄窗口）侧栏改抽屉

  const app = () => document.querySelector('.app');
  const isNarrow = () => window.innerWidth <= DRAWER_BREAKPOINT;
  const drawerOpen = () => app().classList.contains('drawer-open');

  function setDrawer(open) {
    app().classList.toggle('drawer-open', open);
  }

  function setSidebarCollapsed(collapsed) {
    // 和桌面端同一套 class（shell.css 里是 .app.collapsed）
    const root = app();
    if (root) root.classList.toggle('collapsed', collapsed);
    const btn = document.getElementById('collapseBtn');
    if (btn) {
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      btn.setAttribute('aria-label', collapsed ? '展开侧栏' : '折叠侧栏');
      btn.title = collapsed ? '展开侧栏' : '折叠侧栏';
    }
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
    } catch {
      /* 存不了就算了，不影响使用 */
    }
  }

  // 横竖屏切换时：宽屏恢复内联侧栏，窄屏不保留"图标栏"形态
  function handleViewportChange() {
    if (isNarrow()) {
      app().classList.remove('collapsed');
    } else {
      setDrawer(false);
      let remembered = null;
      try {
        remembered = localStorage.getItem(SIDEBAR_KEY);
      } catch {
        /* 忽略 */
      }
      setSidebarCollapsed(remembered === '1');
    }
  }

  function bindSidebar() {
    const collapseBtn = document.getElementById('collapseBtn');
    const menuBtn = document.getElementById('menuBtn');
    const backdrop = document.getElementById('drawerBackdrop');

    if (collapseBtn) {
      collapseBtn.addEventListener('click', () => {
        // 窄屏：这个按钮用来关抽屉；宽屏：折叠成图标栏
        if (isNarrow()) {
          setDrawer(false);
          return;
        }
        setSidebarCollapsed(!app().classList.contains('collapsed'));
      });
    }

    if (menuBtn) menuBtn.addEventListener('click', () => setDrawer(!drawerOpen()));
    if (backdrop) backdrop.addEventListener('click', () => setDrawer(false));

    // 在抽屉里选了视图/文件夹/标签后自动收起，别挡着列表
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) {
      sidebar.addEventListener('click', (event) => {
        if (!isNarrow() || !drawerOpen()) return;
        if (event.target.closest('#collapseBtn')) return;
        if (event.target.closest('.side-item, .tree-row, .tag-chip, .side-foot')) {
          setTimeout(() => setDrawer(false), 120);
        }
      });
    }

    let remembered = null;
    try {
      remembered = localStorage.getItem(SIDEBAR_KEY);
    } catch {
      /* 忽略 */
    }

    if (isNarrow()) {
      app().classList.remove('collapsed');
    } else {
      setSidebarCollapsed(remembered === '1');
    }

    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('orientationchange', () => setTimeout(handleViewportChange, 150));
  }

  // ---------- 导入 ----------

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.readAsText(file, 'utf-8');
    });
  }

  // 导入：既可以选文件，也可以直接粘贴 JSON
  function importDialog() {
    const area = el('textarea', {
      class: 'io-area',
      spellcheck: 'false',
      placeholder: '把桌面版导出的 JSON 粘贴到这里，或者点下面的「选择文件」',
      'data-autofocus': true,
    });

    const errorText = el('p', { class: 'error', hidden: true });
    const showError = (message) => {
      errorText.textContent = message;
      errorText.hidden = false;
    };

    let mode = 'merge';

    const runImport = async (text) => {
      try {
        const lib = await window.api.importLibrary(text, mode);
        window.Library.absorb(lib);
        closeModal();
        const docs = lib.docs.length;
        window.Library.toast(`已导入，当前共 ${docs} 条文档`);
      } catch (err) {
        showError(err.message);
      }
    };

    const pickBtn = el('button', {
      class: 'btn-ghost',
      type: 'button',
      text: '选择文件…',
      onclick: () => importFile.click(),
    });

    importFile.onchange = async () => {
      const file = importFile.files && importFile.files[0];
      importFile.value = '';
      if (!file) return;
      try {
        const text = await readFile(file);
        area.value = text;
        await runImport(text);
      } catch (err) {
        showError(err.message);
      }
    };

    const modeRow = el('div', { class: 'io-modes' }, [
      el('button', {
        class: 'seg is-active',
        type: 'button',
        text: '合并（保留现有）',
        onclick: (event) => {
          mode = 'merge';
          for (const node of modeRow.children) node.classList.toggle('is-active', node === event.currentTarget);
        },
      }),
      el('button', {
        class: 'seg',
        type: 'button',
        text: '覆盖（清空后导入）',
        onclick: (event) => {
          mode = 'replace';
          for (const node of modeRow.children) node.classList.toggle('is-active', node === event.currentTarget);
        },
      }),
    ]);

    const form = el('form', { class: 'modal-form' }, [
      el('h2', { text: '导入文档' }),
      el('p', {
        class: 'modal-desc',
        text: '在电脑上点「导出」得到一个 JSON，传到平板后在这里选文件导入。合并只补新增，覆盖会用文件内容替换整库。',
      }),
      el('div', { class: 'field' }, [el('label', { text: '导入方式' }), modeRow]),
      el('div', { class: 'field' }, [el('label', { text: 'JSON 内容' }), area]),
      errorText,
      el('div', { class: 'modal-actions' }, [
        pickBtn,
        el('button', { class: 'btn-ghost', type: 'button', text: '取消', onclick: closeModal }),
        el('button', {
          class: 'btn-primary',
          type: 'submit',
          text: '导入',
        }),
      ]),
    ]);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      errorText.hidden = true;
      runImport(area.value);
    });

    openModal(form);
  }

  function bindIo() {
    const importBtn = document.getElementById('importBtn');
    if (importBtn) importBtn.addEventListener('click', importDialog);
  }

  // ---------- 启动 ----------

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modalRoot.hidden) closeModal();
  });

  // 静态 HTML 里的 <span data-icon> 占位要换成真正的图标（桌面端在 shell.js 里做）
  window.Icons.hydrate(document);

  bindSidebar();
  bindIo();

  window.Library.init({
    openDoc,
    // Android 版没有"标签页"，切回列表时什么都不用做
    showLibrary: () => {},
    onLibrary: () => {},
  }).catch((err) => {
    window.Library.toast(`初始化失败：${err.message}`, true);
  });
})();