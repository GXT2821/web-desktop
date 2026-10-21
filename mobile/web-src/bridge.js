// Android 端的 window.api：用 localStorage 替代 Electron 主进程的 library.json
//
// 桌面端的渲染层（library.js）只认 window.api 这一层接口，所以这里按同一套契约实现：
// - 查询返回快照，写操作返回写完之后的新快照（调用方直接 absorb）
// - 失败抛 Error（渲染层会把 message 弹成 toast）
// - 校验规则来自 store-core.js —— 和桌面端同一份代码，两端清洗结果一致
//
// 存储：localStorage 存整个库的 JSON（元数据只有几十 KB），写入前留一份 .bak，
// 读取时先认主副本、再认备份，两份都坏才重建（和桌面端的思路一致）。

(function () {
  'use strict';

  const core = window.DocVaultStore;
  const KEY = 'docvault.library.v1';
  const BACKUP_KEY = 'docvault.library.v1.bak';

  const tauri = window.__TAURI__ || null;
  // 注意：不能写成 `const invoke = tauri.core.invoke`——那样会丢掉 this，
  // 调用时抛 "Illegal invocation"，表现为版本号取不到、点文档打不开浏览器。
  const invoke =
    tauri && tauri.core && typeof tauri.core.invoke === 'function'
      ? (cmd, args) => tauri.core.invoke(cmd, args)
      : null;

  // ---------- 存储 ----------

  class LocalStore extends core.LibraryStore {
    save() {
      const next = JSON.stringify(this.data);
      try {
        const previous = localStorage.getItem(KEY);
        if (previous && previous !== next) localStorage.setItem(BACKUP_KEY, previous);
        localStorage.setItem(KEY, next);
      } catch (err) {
        // 空间不足等：明确告诉用户，而不是静默丢失
        throw new Error(`保存失败：${err && err.message ? err.message : '本机存储不可写'}`);
      }
    }
  }

  const store = new LocalStore(core.emptyLibrary());

  function parse(raw) {
    if (!raw) return null;
    const data = JSON.parse(raw);
    return core.sanitizeLibrary(data);
  }

  function load() {
    let primary = null;
    let backup = null;
    try {
      primary = localStorage.getItem(KEY);
      backup = localStorage.getItem(BACKUP_KEY);
    } catch {
      /* 隐私模式等场景，按空库处理 */
    }

    for (const raw of [primary, backup]) {
      try {
        const data = parse(raw);
        if (data) {
          store.data = data;
          return;
        }
      } catch {
        /* 换下一份 */
      }
    }
    store.data = core.emptyLibrary();
  }

  const snapshot = () => store.snapshot();

  async function appVersion() {
    if (!invoke) return 'web';
    try {
      return await invoke('app_version');
    } catch {
      return 'unknown';
    }
  }

  // ---------- 打开外部浏览器 ----------

  function assertHttpUrl(url) {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      throw new Error('链接格式不正确');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('只支持 http/https 链接');
    }
    return parsed.href;
  }

  async function openExternal(url) {
    const target = assertHttpUrl(url);
    if (invoke) {
      await invoke('open_url', { url: target });
      return true;
    }
    // 没有 Tauri（比如在桌面浏览器里调试页面）时的兜底
    window.open(target, '_blank', 'noopener');
    return true;
  }

  // ---------- 剪贴板 ----------

  async function copyText(text) {
    const value = String(text == null ? '' : text).slice(0, 200 * 1024);
    if (!value) throw new Error('没有可复制的内容');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {
      /* 落到下面的兜底 */
    }
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand && document.execCommand('copy');
    area.remove();
    if (!ok) throw new Error('复制失败，请长按手动选择文本');
    return true;
  }

  // ---------- 导入 / 导出 ----------

  // 导出成可以贴到别处、也能被桌面版直接读入的 JSON
  function exportText() {
    const payload = {
      version: store.data.version,
      folders: store.data.folders,
      docs: store.data.docs,
    };
    return JSON.stringify(payload, null, 2);
  }

  // mode: 'merge' 只补不覆盖（同 id 或同链接视为已存在）；'replace' 整个替换
  function importText(text, mode = 'merge') {
    const raw = String(text || '').trim();
    if (!raw) throw new Error('内容为空，没有可导入的数据');

    let parsedJson;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new Error('不是合法的 JSON，请检查是否复制完整');
    }

    const incoming = core.sanitizeLibrary(parsedJson);
    if (!incoming.docs.length && !incoming.folders.length) {
      throw new Error('文件里没有可导入的文档或文件夹');
    }

    if (mode === 'replace') {
      store.data = incoming;
      store.save();
      return snapshot();
    }

    // 合并：文件夹按 id 去重，文档按 id 或链接去重
    const folderIds = new Set(store.data.folders.map((f) => f.id));
    const docIds = new Set(store.data.docs.map((d) => d.id));
    const docUrls = new Set(store.data.docs.map((d) => d.url));

    let addedFolders = 0;
    for (const folder of incoming.folders) {
      if (folderIds.has(folder.id)) continue;
      // 父文件夹没跟着进来时挂到根目录
      const parentId = folder.parentId && folderIds.has(folder.parentId) ? folder.parentId : null;
      store.data.folders.push({ ...folder, parentId });
      folderIds.add(folder.id);
      addedFolders += 1;
    }

    let addedDocs = 0;
    for (const doc of incoming.docs) {
      if (docIds.has(doc.id) || docUrls.has(doc.url)) continue;
      store.data.docs.push({
        ...doc,
        folderId: doc.folderId && folderIds.has(doc.folderId) ? doc.folderId : null,
      });
      docIds.add(doc.id);
      docUrls.add(doc.url);
      addedDocs += 1;
    }

    if (!addedDocs && !addedFolders) throw new Error('这些文档都已经在库里了，没有新增');

    store.save();
    return snapshot();
  }

  // ---------- 对渲染层暴露的接口（与 Electron preload 同名同形） ----------

  window.api = {
    getLibrary: async () => snapshot(),

    getInfo: async () => ({
      // 版本号从 Rust 侧取（Cargo.toml 是单一来源），取不到时退回占位
      appVersion: await appVersion(),
      electron: '-',
      chrome: navigator.userAgent,
      node: '-',
      platform: 'android',
      dataDir: '本机存储',
      dataFile: 'localStorage',
    }),

    addDoc: async (input) => {
      store.addDoc(input || {});
      return snapshot();
    },

    updateDoc: async (id, patch) => {
      store.updateDoc(id, patch || {});
      return snapshot();
    },

    deleteDoc: async (id) => {
      store.deleteDoc(id);
      return snapshot();
    },

    touchDoc: async (id) => {
      store.touchDoc(id);
      return snapshot();
    },

    autoTitle: async (id, title) => {
      store.updateDoc(id, { autoTitle: title });
      return snapshot();
    },

    addFolder: async (name, parentId) => {
      store.addFolder(name, parentId);
      return snapshot();
    },

    renameFolder: async (id, name) => {
      store.renameFolder(id, name);
      return snapshot();
    },

    deleteFolder: async (id, mode) => {
      store.deleteFolder(id, mode);
      return snapshot();
    },

    openExternal,
    copyText,
    revealDataFile: async () => {
      throw new Error('Android 版没有数据文件，可以用「导出」把数据带走');
    },

    // Android 端扩展（桌面端没有下载管理，这几个只看不用）
    exportLibrary: async () => exportText(),
    importLibrary: async (text, mode) => importText(text, mode),
  };

  load();
})();