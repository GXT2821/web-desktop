// 渲染进程：文档库主体（侧栏视图、文件夹树、标签、搜索、列表、增删改弹窗）
//
// 与 shell.js 的分工：
//   library.js  管理"收藏数据"的展示与编辑，所有写操作都走主进程 IPC；
//   shell.js    管理标签页与 webview（打开文档、网页工具条）。
// 两者通过 init 时传入的 hooks 通信，数据变更后由本模块统一广播快照。

(function () {
  'use strict';

  // ==================== 图标（静态 SVG，仅用于 innerHTML） ====================
  const ICONS = {
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/>',
    close: '<path d="M18 6L6 18M6 6l12 12"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h3.7l1.8 2.2h9A1.5 1.5 0 0 1 20.5 9.7v7.8A1.5 1.5 0 0 1 19 19H4.5A1.5 1.5 0 0 1 3 17.5z"/>',
    'folder-plus': '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h3.7l1.8 2.2h9A1.5 1.5 0 0 1 20.5 9.7v7.8A1.5 1.5 0 0 1 19 19H4.5A1.5 1.5 0 0 1 3 17.5z"/><path d="M11.8 15.4v-4M9.8 13.4h4" stroke-width="1.5"/>',
    caret: '<path d="M6 9.5l6 6 6-6"/>',
    star: '<path d="M12 3.7l2.55 5.2 5.7.83-4.13 4.03.98 5.68L12 16.76l-5.1 2.68.98-5.68L3.75 9.73l5.7-.83z"/>',
    external: '<path d="M13.5 4.5H20v6.5"/><path d="M20 4.5l-8.5 8.5"/><path d="M18 14.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.5"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M15 6.5V5.2A2.2 2.2 0 0 0 12.8 3H5.2A2.2 2.2 0 0 0 3 5.2v7.6A2.2 2.2 0 0 0 5.2 15h1.3"/>',
    edit: '<path d="M4 20h4l10.2-10.2-4-4L4 16z"/><path d="M14.2 5.8l4 4"/>',
    trash: '<path d="M4 7h16"/><path d="M10 11v5.5M14 11v5.5"/><path d="M6.5 7l.9 11.2A2 2 0 0 0 9.4 20h5.2a2 2 0 0 0 2-1.8L17.5 7"/><path d="M9.5 7V5.2A2.2 2.2 0 0 1 11.7 3h.6a2.2 2.2 0 0 1 2.2 2.2V7"/>',
    back: '<path d="M15 18.5l-6.5-6.5L15 5.5"/>',
    reload: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4.6V10h-5.4"/>',
    book: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10v16H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M10 4h8.5A1.5 1.5 0 0 1 20 5.5v13A1.5 1.5 0 0 1 18.5 20H10"/>',
    globe: '<circle cx="12" cy="12" r="8.2"/><path d="M3.8 12h16.4"/><ellipse cx="12" cy="12" rx="3.6" ry="8.2"/>',
    clock: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.4V12l3.2 2"/>',
    inbox: '<path d="M3.5 12.5h4l1 2.2h7l1-2.2h4"/><path d="M4.8 5.6h14.4l1.3 6.9v4.4a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2v-4.4z"/>',
    alert: '<path d="M12 4.5l8.5 15h-17z"/><path d="M12 10v4"/><path d="M12 17.2v.1"/>',
    'book-open': '<path d="M12 6.6C10.2 5 7.9 4.4 4.5 4.5v12.6c3.4-.1 5.7.5 7.5 2.1 1.8-1.6 4.1-2.2 7.5-2.1V4.5C16.1 4.4 13.8 5 12 6.6z"/><path d="M12 6.6v12.6"/>',
    filter: '<path d="M4 6h16"/><path d="M7 12h10"/><path d="M10 18h4"/>',
    sidebar: '<rect x="3" y="4.6" width="18" height="14.8" rx="2.6"/><path d="M9.4 4.6v14.8"/>',
    download: '<path d="M12 4.2v10.2"/><path d="M7.8 10.4L12 14.6l4.2-4.2"/><path d="M4.6 17.6v1.2a1.8 1.8 0 0 0 1.8 1.8h11.2a1.8 1.8 0 0 0 1.8-1.8v-1.2"/>',
    folderOpen: '<path d="M3.2 8.2V6.4A1.6 1.6 0 0 1 4.8 4.8h3.5l1.7 2.1h7.4a1.6 1.6 0 0 1 1.6 1.6v.4"/><path d="M3.2 8.2h16.2l1.4 4.6a1.7 1.7 0 0 1-.6 1.9l-2.1 1.5a2 2 0 0 1-1.1.4H6.1a2 2 0 0 1-1.2-.4l-2-1.5a1.7 1.7 0 0 1-.6-2z"/>',
  };

  // 用 hasOwn 而不是直接取值：'__proto__'/'constructor' 之类在原型链上也能取到真值
  const svgMarkup = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${Object.hasOwn(ICONS, name) ? ICONS[name] : ''}</svg>`;

  function iconNode(name) {
    const template = document.createElement('template');
    template.innerHTML = svgMarkup(name);
    return template.content.firstElementChild;
  }

  // 把 HTML 里 <span data-icon="xx"> 的占位替换成真正的图标
  function hydrateIcons(root) {
    root.querySelectorAll('[data-icon]').forEach((holder) => {
      const name = holder.getAttribute('data-icon');
      if (!name || !Object.hasOwn(ICONS, name)) return;
      holder.removeAttribute('data-icon');
      holder.prepend(iconNode(name));
    });
  }

  window.Icons = { node: iconNode, svg: svgMarkup, hydrate: hydrateIcons };

  // ==================== 小工具 ====================
  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        // 有意不提供 innerHTML 入口：外壳里的所有内容都走 textContent，
        // 这样文档标题/备注/网页标题等外部字符串永远无法变成 HTML。
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (value === true) node.setAttribute(key, '');
        else node.setAttribute(key, String(value));
      }
    }
    for (const child of [].concat(children || [])) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const clear = (node) => {
    while (node.firstChild) node.removeChild(node.firstChild);
  };

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  // 同域名 → 同色，让卡片有稳定的视觉标识
  function hueOf(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 360;
    return hash;
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const minute = 60000;
    const hour = 3600000;
    const day = 86400000;
    if (diff < minute) return '刚刚';
    if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
    if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
    if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  const readPref = (key, fallback) => {
    try {
      const raw = localStorage.getItem(`docvault.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  };
  const writePref = (key, value) => {
    try {
      localStorage.setItem(`docvault.${key}`, JSON.stringify(value));
    } catch {
      /* localStorage 不可用时忽略 */
    }
  };

  // 供 shell.js 复用（同一套 DOM 构造方式，避免两份实现）
  window.Dom = { el, clear, hostOf };

  // ==================== 状态 ====================
  const SORTS = {
    created_desc: (a, b) => b.createdAt - a.createdAt,
    created_asc: (a, b) => a.createdAt - b.createdAt,
    opened_desc: (a, b) => (b.openedAt || 0) - (a.openedAt || 0) || b.createdAt - a.createdAt,
    title_asc: (a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'),
  };

  const state = {
    lib: { folders: [], docs: [], dataFile: '', backupFile: '' },
    info: null,
    view: { type: 'all', id: null },
    tags: new Set(),
    query: '',
    sort: SORTS[readPref('sort', 'created_desc')] ? readPref('sort', 'created_desc') : 'created_desc',
    collapsed: new Set(readPref('collapsed', [])),
  };

  let hooks = {};
  let dom = {};

  // ==================== 数据查询 ====================
  const docsById = () => new Map(state.lib.docs.map((d) => [d.id, d]));
  const folderById = (id) => state.lib.folders.find((f) => f.id === id) || null;

  function childFolders(parentId) {
    return state.lib.folders
      .filter((f) => (f.parentId || null) === (parentId || null))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }

  // 文件夹及其所有子孙的 id（父文件夹视图包含子文件夹内容）
  function folderScope(folderId) {
    const ids = new Set([folderId]);
    let frontier = [folderId];
    while (frontier.length) {
      frontier = state.lib.folders.filter((f) => frontier.includes(f.parentId)).map((f) => f.id);
      frontier = frontier.filter((id) => !ids.has(id));
      frontier.forEach((id) => ids.add(id));
    }
    return ids;
  }

  function allTags() {
    const counter = new Map();
    for (const doc of state.lib.docs) {
      for (const tag of doc.tags) {
        const key = tag.toLowerCase();
        const entry = counter.get(key) || { name: tag, count: 0 };
        entry.count += 1;
        counter.set(key, entry);
      }
    }
    return [...counter.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }

  function matchesQuery(doc, query) {
    if (!query) return true;
    const haystack = `${doc.title}\n${doc.url}\n${doc.note}\n${doc.tags.join(' ')}`.toLowerCase();
    return query
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((word) => haystack.includes(word));
  }

  function matchesTags(doc) {
    if (state.tags.size === 0) return true;
    const owned = new Set(doc.tags.map((t) => t.toLowerCase()));
    for (const tag of state.tags) if (!owned.has(tag)) return false; // 多标签 = 同时满足
    return true;
  }

  function baseDocs() {
    const { type, id } = state.view;
    if (type === 'star') return state.lib.docs.filter((d) => d.star);
    if (type === 'recent') return state.lib.docs.filter((d) => d.openedAt);
    if (type === 'unfiled') return state.lib.docs.filter((d) => !d.folderId);
    if (type === 'folder') {
      const scope = folderScope(id);
      return state.lib.docs.filter((d) => d.folderId && scope.has(d.folderId));
    }
    return state.lib.docs.slice();
  }

  function visibleDocs() {
    const sorter = SORTS[state.sort] || SORTS.created_desc;
    return baseDocs()
      .filter((doc) => matchesTags(doc) && matchesQuery(doc, state.query))
      .sort(sorter);
  }

  // 文件夹视图下，把同一个子孙文件夹的文档分组？——不分组，但用"未分类"标记区分根目录文档
  function viewTitle() {
    const { type, id } = state.view;
    if (type === 'star') return '星标';
    if (type === 'recent') return '最近打开';
    if (type === 'unfiled') return '未分类';
    if (type === 'folder') {
      const folder = folderById(id);
      if (folder) return folder.name;
    }
    return '全部文档';
  }

  function folderPath(folderId) {
    const parts = [];
    let cursor = folderById(folderId);
    let guard = 0;
    while (cursor && guard < 32) {
      parts.unshift(cursor.name);
      cursor = cursor.parentId ? folderById(cursor.parentId) : null;
      guard += 1;
    }
    return parts.join(' / ');
  }

  // ==================== 渲染：侧栏 ====================
  function renderSidenav() {
    const docs = state.lib.docs;
    const items = [
      { type: 'all', label: '全部文档', icon: 'book-open', count: docs.length },
      { type: 'star', label: '星标', icon: 'star', count: docs.filter((d) => d.star).length },
      { type: 'recent', label: '最近打开', icon: 'clock', count: docs.filter((d) => d.openedAt).length },
      { type: 'unfiled', label: '未分类', icon: 'inbox', count: docs.filter((d) => !d.folderId).length },
    ];

    clear(dom.sidenav);
    for (const item of items) {
      const active = state.view.type === item.type;
      dom.sidenav.append(
        el('button', {
            class: `side-item${active ? ' active' : ''}`,
            type: 'button',
            title: item.label,
            onclick: () => setView(item.type),
          }, [
          iconNode(item.icon),
          el('span', { class: 'label', text: item.label }),
          el('span', { class: 'count', text: String(item.count) }),
        ])
      );
    }
  }

  function renderTree() {
    clear(dom.folderTree);
    const roots = childFolders(null);
    if (roots.length === 0) {
      dom.folderTree.append(el('p', { class: 'tree-empty', text: '还没有文件夹，点右上角 ＋ 新建' }));
      return;
    }
    for (const folder of roots) dom.folderTree.append(treeBranch(folder, 0));
  }

  function treeBranch(folder, depth) {
    const children = childFolders(folder.id);
    const collapsed = state.collapsed.has(folder.id);
    const scope = folderScope(folder.id);
    const count = state.lib.docs.filter((d) => d.folderId && scope.has(d.folderId)).length;
    const active = state.view.type === 'folder' && state.view.id === folder.id;

    const caret = el('span', { class: `caret${children.length ? '' : ' placeholder'}` });
    if (children.length) {
      caret.append(iconNode('caret'));
      caret.addEventListener('click', (event) => {
        event.stopPropagation();
        if (collapsed) state.collapsed.delete(folder.id);
        else state.collapsed.add(folder.id);
        writePref('collapsed', [...state.collapsed]);
        renderTree();
      });
    }

    const ops = el('span', { class: 'row-ops' }, [
      el('button', { class: 'icon-btn', type: 'button', title: '新建子文件夹', onclick: (e) => { e.stopPropagation(); newFolderDialog(folder.id); } }, [iconNode('folder-plus')]),
      el('button', { class: 'icon-btn', type: 'button', title: '重命名', onclick: (e) => { e.stopPropagation(); renameFolderDialog(folder); } }, [iconNode('edit')]),
      el('button', { class: 'icon-btn danger', type: 'button', title: '删除文件夹', onclick: (e) => { e.stopPropagation(); deleteFolderDialog(folder); } }, [iconNode('trash')]),
    ]);

    const row = el('div', {
      class: `tree-item${active ? ' active' : ''}${collapsed ? ' collapsed' : ''}`,
      role: 'button',
      tabindex: '0',
      title: folderPath(folder.id),
      onclick: () => setView('folder', folder.id),
      onkeydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          setView('folder', folder.id);
        }
      },
    }, [
      caret,
      el('span', { class: 'folder-icon' }, [iconNode(children.length && collapsed ? 'folder' : 'folder')]),
      el('span', { class: 'name', text: folder.name }),
      el('span', { class: 'count', text: String(count) }),
      ops,
    ]);
    row.style.setProperty('--depth', String(depth));

    const wrap = el('div', {}, [row]);
    if (!collapsed) for (const child of children) wrap.append(treeBranch(child, depth + 1));
    return wrap;
  }

  function renderTags() {
    const tags = allTags();
    clear(dom.tagList);
    dom.clearTagsBtn.hidden = state.tags.size === 0;

    if (tags.length === 0) {
      dom.tagList.append(el('span', { class: 'tag-empty', text: '暂无标签' }));
      return;
    }
    for (const tag of tags) {
      const active = state.tags.has(tag.name.toLowerCase());
      dom.tagList.append(
        el('button', {
          class: `tag-chip${active ? ' active' : ''}`,
          type: 'button',
          text: tag.name,
          onclick: () => toggleTag(tag.name),
        }, [el('span', { class: 'n', text: String(tag.count) })])
      );
    }
  }

  function renderFoot() {
    const { docs, folders } = state.lib;
    clear(dom.sideFoot);

    const info = state.info || {};
    dom.sideFoot.append(
      el('div', { text: `${docs.length} 条记录 · ${folders.length} 个文件夹` }),
      el('div', {}, [
        el('button', {
          type: 'button',
          title: state.lib.dataFile,
          text: '打开数据文件位置',
          onclick: async () => {
            try {
              await window.api.revealDataFile();
            } catch (err) {
              toast(err.message, true);
            }
          },
        }),
        ` · v${info.appVersion || '1.0.0'}`,
      ])
    );
  }

  // ==================== 渲染：列表 ====================
  function renderList() {
    if (state.view.type === 'folder' && !folderById(state.view.id)) state.view = { type: 'all', id: null };

    const docs = visibleDocs();
    const total = baseDocs().length;

    dom.listTitle.textContent = viewTitle();
    const parts = [`${docs.length} 条`];
    if (docs.length !== total) parts.push(`（共 ${total} 条）`);
    if (!state.lib.docs.some((d) => d.openedAt) && state.lib.docs.length) parts.push('· 点开文档会记录"最近打开"');
    dom.listSub.textContent = parts.join(' ');

    // 筛选栏
    const filtering = state.tags.size > 0 || state.query.trim() !== '';
    dom.filterBar.hidden = !filtering;
    clear(dom.filterBar);
    if (filtering) {
      dom.filterBar.append(el('span', { class: 'filter-label' }, [iconNode('filter'), ' 筛选：']));
      if (state.query.trim()) {
        dom.filterBar.append(el('span', { class: 'tag-chip active', text: `“${state.query.trim()}”` }));
      }
      for (const tag of state.tags) {
        dom.filterBar.append(el('span', { class: 'tag-chip active', text: `#${tag}` }));
      }
      dom.filterBar.append(el('button', { class: 'link-btn', type: 'button', text: '清除筛选', onclick: clearFilters }));
    }

    const list = el('div', { class: 'doclist' });
    if (state.lib.docs.length === 0) {
      clear(dom.docList);
      dom.docList.append(emptyState('还没有收藏任何文档', '把常用的在线文档链接存在这里，就不会随浏览器标签一起丢失。也可以随时用顶部搜索框快速找回。', true));
      return;
    }
    if (docs.length === 0) {
      clear(dom.docList);
      dom.docList.append(emptyState('没有匹配的文档', '换个关键词，或清除当前的筛选条件。', false));
      return;
    }
    for (const doc of docs) list.append(docCard(doc));

    const scrollTop = dom.docList.scrollTop;
    clear(dom.docList);
    while (list.firstChild) dom.docList.append(list.firstChild);
    dom.docList.scrollTop = scrollTop;
  }

  function emptyState(title, desc, withAdd) {
    const actions = el('div', { class: 'empty-actions' });
    if (withAdd) {
      actions.append(el('button', { class: 'btn-primary', type: 'button', onclick: () => addDocDialog() }, [iconNode('plus'), '添加第一条文档']));
    } else {
      actions.append(el('button', { class: 'btn-ghost', type: 'button', text: '清除筛选', onclick: clearFilters }));
    }
    return el('div', { class: 'empty' }, [
      el('span', { class: 'empty-icon' }, [iconNode('book-open')]),
      el('h2', { text: title }),
      el('p', { text: desc }),
      actions,
    ]);
  }

  function docCard(doc) {
    const host = hostOf(doc.url);
    const avatar = el('span', { class: 'avatar', text: (host.charAt(0) || '?').toUpperCase() });
    avatar.style.setProperty('--hue', String(hueOf(host)));

    const meta = [`添加于 ${fmtTime(doc.createdAt)}`];
    meta.push(doc.openedAt ? `上次打开 ${fmtTime(doc.openedAt)}` : '还没打开过');

    const hostLine = el('div', { class: 'doc-host' }, [host]);
    if (!doc.folderId) hostLine.append(el('span', { class: 'badge-unfiled', text: '未分类' }));

    const card = el('article', {
      class: 'doc-card',
      tabindex: '0',
      dataset: { id: doc.id },
      // 卡片空间有限，完整信息放 tooltip
      title: `${doc.title}\n${doc.url}\n添加于 ${fmtTime(doc.createdAt)} · 打开 ${doc.openCount} 次${doc.openedAt ? ` · 上次打开 ${fmtTime(doc.openedAt)}` : ''}`,
    }, [
      el('div', { class: 'doc-top' }, [
        avatar,
        el('div', { class: 'doc-head' }, [
          el('h3', { class: 'doc-title', text: doc.title }),
          hostLine,
        ]),
        el('button', {
          class: `doc-star${doc.star ? ' on' : ''}`,
          type: 'button',
          title: doc.star ? '取消星标' : '加星标',
          dataset: { act: 'star' },
        }, [iconNode('star')]),
      ]),
      doc.note ? el('p', { class: 'doc-note', text: doc.note }) : null,
      doc.tags.length
        ? el('div', { class: 'doc-tags' }, doc.tags.map((tag) => el('button', {
            class: 'tag-chip',
            type: 'button',
            text: tag,
            dataset: { tag },
            title: `按标签 #${tag} 筛选`,
          })))
        : null,
      el('div', { class: 'doc-foot' }, [
        el('span', { class: 'doc-meta', text: meta.join(' · ') }),
        el('span', { class: 'doc-ops' }, [
          // 整张卡片点击即"应用内打开"，这里不再重复放一个打开按钮
          el('button', { class: 'icon-btn', type: 'button', title: '用系统浏览器打开', dataset: { act: 'external' } }, [iconNode('external')]),
          el('button', { class: 'icon-btn', type: 'button', title: '复制链接', dataset: { act: 'copy' } }, [iconNode('copy')]),
          el('button', { class: 'icon-btn', type: 'button', title: '编辑', dataset: { act: 'edit' } }, [iconNode('edit')]),
          el('button', { class: 'icon-btn danger', type: 'button', title: '删除', dataset: { act: 'delete' } }, [iconNode('trash')]),
        ]),
      ]),
    ]);

    card.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      hooks.openDoc(doc);
    });
    card.addEventListener('keydown', (event) => {
      if (event.target.closest('button')) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        hooks.openDoc(doc);
      }
    });
    return card;
  }

  function renderAll() {
    renderSidenav();
    renderTree();
    renderTags();
    renderList();
    renderFoot();
  }

  // ==================== 视图/筛选操作 ====================
  function setView(type, id = null) {
    state.view = { type, id };
    if (type === 'recent') {
      state.sort = 'opened_desc';
      dom.sortSelect.value = 'opened_desc';
      writePref('sort', state.sort);
    }
    renderAll();
    hooks.showLibrary && hooks.showLibrary();
  }

  function toggleTag(name) {
    const key = name.toLowerCase();
    if (state.tags.has(key)) state.tags.delete(key);
    else state.tags.add(key);
    renderTags();
    renderList();
    hooks.showLibrary && hooks.showLibrary();
  }

  function clearFilters() {
    state.tags.clear();
    state.query = '';
    dom.search.value = '';
    dom.searchClear.hidden = true;
    renderTags();
    renderList();
  }

  // ==================== 弹窗基座 ====================
  function openModal(node) {
    clear(dom.modalBox);
    dom.modalBox.append(node);
    dom.modalRoot.hidden = false;
    const target = dom.modalBox.querySelector('[data-autofocus]') || dom.modalBox.querySelector('input, textarea, select, button');
    if (target) target.focus();
    if (target && target.select && target.tagName === 'INPUT') target.select();
  }

  function closeModal() {
    dom.modalRoot.hidden = true;
    clear(dom.modalBox);
  }

  const isModalOpen = () => !dom.modalRoot.hidden;

  // 添加 / 编辑文档
  function addDocDialog(prefill = {}) {
    const editing = prefill.doc || null;
    const draft = editing || {
      url: '',
      title: '',
      note: '',
      tags: [],
      folderId: prefill.folderId || (state.view.type === 'folder' ? state.view.id : null),
    };

    const urlInput = el('input', { type: 'text', spellcheck: 'false', placeholder: 'https://example.com/doc/123', value: draft.url || '', 'data-autofocus': editing ? null : true });
    const titleInput = el('input', { type: 'text', placeholder: '留空则取网页标题', value: draft.title || '' });
    const noteInput = el('textarea', { placeholder: '记一句"为什么收藏它"，以后更容易想起来', text: draft.note || '' });
    const tagInput = el('input', { type: 'text', placeholder: '多个标签用逗号或空格分隔', value: (draft.tags || []).join(', ') });

    const folderSelect = el('select', {}, [
      el('option', { value: '', text: '未分类', selected: !draft.folderId }),
      ...flattenFolders().map(({ folder, depth }) =>
        el('option', { value: folder.id, text: `${'　'.repeat(depth)}${folder.name}`, selected: draft.folderId === folder.id })
      ),
    ]);

    const errorText = el('p', { class: 'error', hidden: true });

    // 已有标签一键补全
    const hints = allTags().slice(0, 12);
    const hintRow = hints.length
      ? el('div', { class: 'tag-hints' }, hints.map((tag) => el('button', {
          class: 'tag-chip',
          type: 'button',
          text: tag.name,
          onclick: () => {
            const current = tagInput.value.split(/[,，\s]+/).filter(Boolean);
            if (!current.some((t) => t.toLowerCase() === tag.name.toLowerCase())) current.push(tag.name);
            tagInput.value = current.join(', ');
          },
        })))
      : null;

    const form = el('form', { class: 'modal-form' }, [
      el('h2', { text: editing ? '编辑文档' : '添加文档' }),
      el('p', { class: 'modal-desc', text: editing ? '修改后立即保存到本地数据文件。' : '只记录链接与备注，不会抓取网页内容。' }),
      el('div', { class: 'field' }, [el('label', { text: '链接' }), urlInput]),
      el('div', { class: 'field' }, [el('label', { text: '标题' }), titleInput, el('span', { class: 'hint', text: '留空时先用域名占位，第一次打开后自动补全为网页标题。' })]),
      el('div', { class: 'field-row' }, [
        el('div', { class: 'field' }, [el('label', { text: '文件夹' }), folderSelect]),
      ]),
      el('div', { class: 'field' }, [el('label', { text: '标签' }), tagInput, hintRow]),
      el('div', { class: 'field' }, [el('label', { text: '备注' }), noteInput]),
      errorText,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn-ghost', type: 'button', text: '取消', onclick: closeModal }),
        el('button', { class: 'btn-primary', type: 'submit', text: editing ? '保存' : '添加' }),
      ]),
    ]);

    const showError = (message) => {
      errorText.textContent = message;
      errorText.hidden = false;
    };

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = {
        url: urlInput.value.trim(),
        title: titleInput.value.trim(),
        folderId: folderSelect.value || null,
        tags: tagInput.value.split(/[,，\s]+/).filter(Boolean),
        note: noteInput.value.trim(),
      };
      if (!payload.url) {
        showError('请填写文档链接');
        urlInput.focus();
        return;
      }
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        const lib = editing
          ? await window.api.updateDoc(editing.id, payload)
          : await window.api.addDoc(payload);
        absorb(lib);
        closeModal();
        toast(editing ? '已保存修改' : '已添加文档');
      } catch (err) {
        showError(err.message);
        submit.disabled = false;
      }
    });

    openModal(form);
  }

  function confirmDialog({ title, desc, confirmText = '删除', onConfirm }) {
    const box = el('div', {}, [
      el('h2', { text: title }),
      el('p', { class: 'modal-desc', text: desc }),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn-ghost', type: 'button', text: '取消', onclick: closeModal }),
        el('button', {
          class: 'btn-ghost danger',
          type: 'button',
          text: confirmText,
          onclick: async (event) => {
            event.target.disabled = true;
            try {
              await onConfirm();
              closeModal();
            } catch (err) {
              toast(err.message, true);
              event.target.disabled = false;
            }
          },
        }),
      ]),
    ]);
    openModal(box);
  }

  // 新建 / 重命名文件夹
  function newFolderDialog(parentId) {
    const input = el('input', { type: 'text', placeholder: '例如：工作 / 学习 / 团队文档', 'data-autofocus': true });
    const errorText = el('p', { class: 'error', hidden: true });
    const parent = parentId ? folderById(parentId) : null;

    const form = el('form', {}, [
      el('h2', { text: parent ? `在「${parent.name}」下新建文件夹` : '新建文件夹' }),
      el('p', { class: 'modal-desc', text: '文件夹可以嵌套，用来做分类；标签用于跨分类标记。' }),
      el('div', { class: 'field' }, [el('label', { text: '名称' }), input]),
      errorText,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn-ghost', type: 'button', text: '取消', onclick: closeModal }),
        el('button', { class: 'btn-primary', type: 'submit', text: '创建' }),
      ]),
    ]);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (!name) {
        errorText.textContent = '请填写文件夹名称';
        errorText.hidden = false;
        return;
      }
      try {
        absorb(await window.api.addFolder(name, parentId || null));
        closeModal();
        toast(`已创建文件夹「${name}」`);
      } catch (err) {
        errorText.textContent = err.message;
        errorText.hidden = false;
      }
    });
    openModal(form);
  }

  function renameFolderDialog(folder) {
    const input = el('input', { type: 'text', value: folder.name, 'data-autofocus': true });
    const errorText = el('p', { class: 'error', hidden: true });

    const form = el('form', {}, [
      el('h2', { text: '重命名文件夹' }),
      el('p', { class: 'modal-desc', text: folderPath(folder.id) }),
      el('div', { class: 'field' }, [el('label', { text: '名称' }), input]),
      errorText,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn-ghost', type: 'button', text: '取消', onclick: closeModal }),
        el('button', { class: 'btn-primary', type: 'submit', text: '保存' }),
      ]),
    ]);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (!name) {
        errorText.textContent = '请填写文件夹名称';
        errorText.hidden = false;
        return;
      }
      try {
        absorb(await window.api.renameFolder(folder.id, name));
        closeModal();
        toast('已重命名');
      } catch (err) {
        errorText.textContent = err.message;
        errorText.hidden = false;
      }
    });
    openModal(form);
  }

  function deleteFolderDialog(folder) {
    const scope = folderScope(folder.id);
    const docs = state.lib.docs.filter((d) => d.folderId && scope.has(d.folderId));
    const subFolders = state.lib.folders.filter((f) => scope.has(f.id) && f.id !== folder.id);
    const detail = `包含 ${subFolders.length} 个子文件夹、${docs.length} 条文档。`;

    const box = el('div', {}, [
      el('h2', { text: `删除文件夹「${folder.name}」` }),
      el('p', { class: 'modal-desc', text: detail }),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn-ghost', type: 'button', text: '取消', onclick: closeModal }),
        el('button', {
          class: 'btn-ghost',
          type: 'button',
          text: '仅删文件夹',
          title: '文档移到未分类，子文件夹上提一级',
          onclick: async (event) => {
            event.target.disabled = true;
            try {
              absorb(await window.api.deleteFolder(folder.id, 'keep'));
              closeModal();
              toast('已删除文件夹，文档保留在未分类');
            } catch (err) {
              toast(err.message, true);
              event.target.disabled = false;
            }
          },
        }),
        el('button', {
          class: 'btn-ghost danger',
          type: 'button',
          text: '连同文档删除',
          onclick: async (event) => {
            event.target.disabled = true;
            try {
              absorb(await window.api.deleteFolder(folder.id, 'cascade'));
              closeModal();
              toast('已连同内容一起删除');
            } catch (err) {
              toast(err.message, true);
              event.target.disabled = false;
            }
          },
        }),
      ]),
    ]);
    openModal(box);
  }

  function deleteDocDialog(doc) {
    confirmDialog({
      title: `删除「${doc.title}」`,
      desc: '只从本地记录中移除，不会影响原网页。此操作不可撤销。',
      confirmText: '删除记录',
      onConfirm: async () => {
        absorb(await window.api.deleteDoc(doc.id));
        toast('已删除记录');
      },
    });
  }

  // 文件夹下拉用的扁平列表（带层级缩进）
  function flattenFolders() {
    const out = [];
    const walk = (parentId, depth) => {
      for (const folder of childFolders(parentId)) {
        out.push({ folder, depth });
        walk(folder.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }

  // ==================== 轻提示 ====================
  let toastTimer = null;
  function toast(message, isError = false) {
    clear(dom.toastWrap);
    dom.toastWrap.append(el('div', { class: `toast${isError ? ' error' : ''}`, text: message }));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => clear(dom.toastWrap), isError ? 4200 : 2000);
  }

  // ==================== 广播 ====================
  function absorb(lib) {
    state.lib = lib;
    renderAll();
    hooks.onLibrary && hooks.onLibrary(lib);
  }

  // ==================== 事件绑定 ====================
  function bindEvents() {
    const onSearch = debounce((value) => {
      state.query = value;
      renderList();
      if (value.trim()) hooks.showLibrary && hooks.showLibrary();
    }, 130);

    dom.search.addEventListener('input', () => {
      dom.searchClear.hidden = dom.search.value === '';
      onSearch(dom.search.value);
    });

    dom.searchClear.addEventListener('click', () => {
      dom.search.value = '';
      dom.searchClear.hidden = true;
      state.query = '';
      renderList();
      dom.search.focus();
    });

    dom.clearTagsBtn.addEventListener('click', () => {
      state.tags.clear();
      renderTags();
      renderList();
    });

    dom.addFolderBtn.addEventListener('click', () => newFolderDialog(null));

    dom.addDocBtn.addEventListener('click', () =>
      addDocDialog({ folderId: state.view.type === 'folder' ? state.view.id : null })
    );

    dom.sortSelect.addEventListener('change', () => {
      state.sort = dom.sortSelect.value;
      writePref('sort', state.sort);
      renderList();
    });

    // 文档卡片上的操作统一在这里分发
    dom.docList.addEventListener('click', (event) => {
      const tagChip = event.target.closest('[data-tag]');
      if (tagChip) {
        event.stopPropagation();
        toggleTag(tagChip.dataset.tag);
        return;
      }
      const action = event.target.closest('[data-act]');
      if (!action) return;
      event.stopPropagation();
      const card = action.closest('.doc-card');
      const doc = card && docsById().get(card.dataset.id);
      if (!doc) return;

      switch (action.dataset.act) {
        case 'star':
          window.api.updateDoc(doc.id, { star: !doc.star }).then(absorb).catch((err) => toast(err.message, true));
          break;
        case 'external':
          window.api.openExternal(doc.url).catch((err) => toast(err.message, true));
          break;
        case 'copy':
          window.api
            .copyText(doc.url)
            .then(() => toast('链接已复制'))
            .catch((err) => toast(err.message, true));
          break;
        case 'edit':
          addDocDialog({ doc });
          break;
        case 'delete':
          deleteDocDialog(doc);
          break;
        default:
          break;
      }
    });

    // Esc 关闭弹窗；点遮罩也关闭
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isModalOpen()) {
        event.preventDefault();
        closeModal();
      }
    });
    dom.modalBackdrop.addEventListener('click', closeModal);
  }

  function cacheDom() {
    dom = {
      sidenav: document.getElementById('sidenav'),
      folderTree: document.getElementById('folderTree'),
      tagList: document.getElementById('tagList'),
      clearTagsBtn: document.getElementById('clearTagsBtn'),
      addFolderBtn: document.getElementById('addFolderBtn'),
      sideFoot: document.getElementById('sideFoot'),
      search: document.getElementById('search'),
      searchClear: document.getElementById('searchClear'),
      sortSelect: document.getElementById('sortSelect'),
      addDocBtn: document.getElementById('addDocBtn'),
      listTitle: document.getElementById('listTitle'),
      listSub: document.getElementById('listSub'),
      filterBar: document.getElementById('filterBar'),
      docList: document.getElementById('docList'),
      modalRoot: document.getElementById('modalRoot'),
      modalBox: document.getElementById('modalBox'),
      modalBackdrop: document.getElementById('modalBackdrop'),
      toastWrap: document.getElementById('toastWrap'),
    };
  }

  // ==================== 对外接口 ====================
  async function init(userHooks = {}) {
    hooks = userHooks;
    cacheDom();
    bindEvents();
    dom.sortSelect.value = state.sort;
    try {
      const [lib, info] = await Promise.all([window.api.getLibrary(), window.api.getInfo()]);
      state.lib = lib;
      state.info = info;
    } catch (err) {
      toast(`读取本地数据失败：${err.message}`, true);
    }
    renderAll();
    hooks.onLibrary && hooks.onLibrary(state.lib);
  }

  window.Library = {
    init,
    absorb,
    toast,
    addDocDialog,
    newFolderDialog,
    focusSearch: () => {
      dom.search.focus();
      dom.search.select();
    },
    // 供 shell 在打开文档后同步"最近打开"状态
    getDoc: (id) => docsById().get(id) || null,
    openUnfiledView: () => setView('unfiled'),
  };
})();