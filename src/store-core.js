// 数据层核心（不碰文件系统）：字段校验 + 库的所有增删改逻辑
//
// 为什么单独抽出来：桌面端（Electron，写 library.json）和 Android 端（Tauri，写 localStorage）
// 必须用同一套校验规则，否则同一份数据在两端的清洗结果会不一致。
// 这里用 UMD 写法：Node 里 require，浏览器里挂到 window.DocVaultStore。
//
// 约定：
// - 只存链接与元数据（标题、备注、标签、文件夹、星标、打开记录），不抓取网页内容；
// - 所有外部输入（IPC、导入的 JSON）都先过 sanitizeLibrary / normalizeUrl；
// - 子类只负责 save()（持久化），其余方法都在这里。

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DocVaultStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 1;

  const LIMITS = {
    title: 200,
    url: 2000,
    note: 2000,
    tag: 40,
    tags: 30,
    folderName: 60,
  };

  // ---------- 工具 ----------

  function makeId(prefix) {
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}_${Date.now().toString(36)}${rand}`;
  }

  // 去掉控制字符、首尾空白，并按上限截断
  function cleanText(value, max) {
    if (typeof value !== 'string') return '';
    return value
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, max);
  }

  // 只接受 http/https；允许用户只粘贴 "www.example.com/x"
  function normalizeUrl(raw) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) throw new Error('链接不能为空');

    let candidate = text;
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) candidate = `https://${candidate}`;

    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error('链接格式不正确，请检查是否复制完整');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('只支持 http/https 链接');
    }
    if (!parsed.hostname) throw new Error('链接缺少域名');
    return parsed.href.slice(0, LIMITS.url);
  }

  // 由链接推导一个可读的默认标题（域名 + 路径尾段）
  function fallbackTitle(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, '');
      const seg = u.pathname.split('/').filter(Boolean).pop();
      const tail = seg && !/^\d+$/.test(seg) ? ` / ${decodeURIComponent(seg).slice(0, 40)}` : '';
      return `${host}${tail}`.slice(0, LIMITS.title);
    } catch {
      return url.slice(0, LIMITS.title);
    }
  }

  function normalizeTags(input) {
    if (!Array.isArray(input)) return [];
    const seen = new Set();
    const out = [];
    for (const item of input) {
      const tag = cleanText(item, LIMITS.tag).replace(/^#/, '');
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
      if (out.length >= LIMITS.tags) break;
    }
    return out;
  }

  // 收集文件夹及其所有子文件夹的 id
  function collectFolderIds(folders, rootId) {
    const ids = [rootId];
    let frontier = [rootId];
    while (frontier.length) {
      const next = folders.filter((f) => frontier.includes(f.parentId)).map((f) => f.id);
      frontier = next.filter((id) => !ids.includes(id));
      ids.push(...frontier);
    }
    return ids;
  }

  function emptyLibrary() {
    return { version: SCHEMA_VERSION, folders: [], docs: [] };
  }

  // 把任意 JSON 收敛成合法结构，坏条目直接丢弃而不是让整个文件失效
  function sanitizeLibrary(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const folders = [];
    for (const item of Array.isArray(source.folders) ? source.folders : []) {
      if (!item || typeof item !== 'object') continue;
      const name = cleanText(item.name, LIMITS.folderName);
      if (!name) continue;
      folders.push({
        id: typeof item.id === 'string' && item.id ? item.id : makeId('f'),
        name,
        parentId: typeof item.parentId === 'string' ? item.parentId : null,
        createdAt: Number(item.createdAt) || Date.now(),
      });
    }
    // 父级不存在（或自引用）时挂回根目录
    const folderIds = new Set(folders.map((f) => f.id));
    for (const folder of folders) {
      if (folder.parentId === folder.id || (folder.parentId && !folderIds.has(folder.parentId))) {
        folder.parentId = null;
      }
    }

    const docs = [];
    const seenIds = new Set();
    for (const item of Array.isArray(source.docs) ? source.docs : []) {
      if (!item || typeof item !== 'object') continue;
      let url;
      try {
        url = normalizeUrl(item.url);
      } catch {
        continue; // 无效链接的条目丢弃
      }
      const id =
        typeof item.id === 'string' && item.id && !seenIds.has(item.id) ? item.id : makeId('d');
      seenIds.add(id);
      docs.push({
        id,
        title: cleanText(item.title, LIMITS.title) || fallbackTitle(url),
        url,
        folderId: folderIds.has(item.folderId) ? item.folderId : null,
        tags: normalizeTags(item.tags),
        note: cleanText(item.note, LIMITS.note),
        star: item.star === true,
        titleAuto: item.titleAuto === true,
        createdAt: Number(item.createdAt) || Date.now(),
        updatedAt: Number(item.updatedAt) || Number(item.createdAt) || Date.now(),
        openedAt: Number(item.openedAt) || null,
        openCount: Number.isFinite(item.openCount) ? Math.max(0, Math.floor(item.openCount)) : 0,
      });
    }

    return { version: SCHEMA_VERSION, folders, docs };
  }

  // ---------- 库（子类只需实现 save） ----------

  class LibraryStore {
    constructor(data) {
      this.data = data || emptyLibrary();
    }

    // 持久化钩子，由子类实现
    save() {
      throw new Error('save() 未实现');
    }

    // 暴露给界面的快照（子类可以附加文件位置等信息）
    snapshot() {
      return {
        version: this.data.version,
        folders: this.data.folders.map((f) => ({ ...f })),
        docs: this.data.docs.map((d) => ({ ...d, tags: [...d.tags] })),
      };
    }

    // 导出成可以给别的设备导入的 JSON：只有版本号、文件夹、文档
    // （snapshot 里的 dataFile/backupFile 是本机路径，给别人没用）
    exportPayload() {
      return {
        version: this.data.version,
        folders: this.data.folders.map((f) => ({ ...f })),
        docs: this.data.docs.map((d) => ({ ...d, tags: [...d.tags] })),
      };
    }

    // ---------- 文档 ----------

    addDoc(input = {}) {
      const url = normalizeUrl(input.url);
      const doc = {
        id: makeId('d'),
        title: cleanText(input.title, LIMITS.title) || fallbackTitle(url),
        url,
        folderId: this.data.folders.some((f) => f.id === input.folderId) ? input.folderId : null,
        tags: normalizeTags(input.tags),
        note: cleanText(input.note, LIMITS.note),
        star: input.star === true,
        // 标题是自动推导的 → 网页加载出真实标题后允许自动补全
        titleAuto: !cleanText(input.title, LIMITS.title),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        openedAt: null,
        openCount: 0,
      };
      this.data.docs.unshift(doc);
      this.save();
      return doc;
    }

    updateDoc(id, patch = {}) {
      const doc = this.data.docs.find((d) => d.id === id);
      if (!doc) throw new Error('文档不存在，可能已被删除');

      if (patch.url !== undefined) doc.url = normalizeUrl(patch.url);
      if (patch.title !== undefined) {
        const title = cleanText(patch.title, LIMITS.title);
        doc.title = title || fallbackTitle(doc.url);
        // 用户手动改过标题就停止自动同步
        doc.titleAuto = !title;
      }
      if (patch.note !== undefined) doc.note = cleanText(patch.note, LIMITS.note);
      if (patch.tags !== undefined) doc.tags = normalizeTags(patch.tags);
      if (patch.star !== undefined) doc.star = patch.star === true;
      if (patch.folderId !== undefined) {
        doc.folderId = this.data.folders.some((f) => f.id === patch.folderId)
          ? patch.folderId
          : null;
      }
      // 仅自动标题占位时才接受网页报上来的标题，且只补全一次
      if (patch.autoTitle !== undefined && doc.titleAuto) {
        const title = cleanText(patch.autoTitle, LIMITS.title);
        if (title) {
          doc.title = title;
          doc.titleAuto = false;
        }
      }
      doc.updatedAt = Date.now();
      this.save();
      return doc;
    }

    deleteDoc(id) {
      const idx = this.data.docs.findIndex((d) => d.id === id);
      if (idx === -1) throw new Error('文档不存在，可能已被删除');
      const [removed] = this.data.docs.splice(idx, 1);
      this.save();
      return removed;
    }

    // 打开文档时记一笔，用于"最近打开"
    touchDoc(id) {
      const doc = this.data.docs.find((d) => d.id === id);
      if (!doc) return null;
      doc.openedAt = Date.now();
      doc.openCount += 1;
      this.save();
      return doc;
    }

    // ---------- 文件夹 ----------

    addFolder(name, parentId) {
      const folderName = cleanText(name, LIMITS.folderName);
      if (!folderName) throw new Error('文件夹名不能为空');
      const parent = this.data.folders.some((f) => f.id === parentId) ? parentId : null;
      const folder = {
        id: makeId('f'),
        name: folderName,
        parentId: parent,
        createdAt: Date.now(),
      };
      this.data.folders.push(folder);
      this.save();
      return folder;
    }

    renameFolder(id, name) {
      const folder = this.data.folders.find((f) => f.id === id);
      if (!folder) throw new Error('文件夹不存在');
      const folderName = cleanText(name, LIMITS.folderName);
      if (!folderName) throw new Error('文件夹名不能为空');
      folder.name = folderName;
      this.save();
      return folder;
    }

    // mode: 'keep' 文档移到未分类、子文件夹上提一级（只删这一个文件夹）；
    //       'cascade' 连同子文件夹与文档一起删除
    deleteFolder(id, mode = 'keep') {
      const folder = this.data.folders.find((f) => f.id === id);
      if (!folder) throw new Error('文件夹不存在');

      const ids = collectFolderIds(this.data.folders, id);
      const affected = this.data.docs.filter((d) => ids.includes(d.folderId));

      if (mode === 'cascade') {
        this.data.folders = this.data.folders.filter((f) => !ids.includes(f.id));
        this.data.docs = this.data.docs.filter((d) => !ids.includes(d.folderId));
        this.save();
        return {
          mode,
          removedFolders: ids.length,
          removedDocs: affected.length,
          affectedDocs: affected.length,
        };
      }

      const children = this.data.folders.filter((f) => f.parentId === id);
      for (const child of children) child.parentId = folder.parentId;
      for (const doc of this.data.docs) {
        if (ids.includes(doc.folderId)) doc.folderId = null;
      }
      this.data.folders = this.data.folders.filter((f) => f.id !== id);
      this.save();
      return {
        mode,
        removedFolders: 1,
        promotedFolders: children.length,
        affectedDocs: affected.length,
        removedDocs: 0,
      };
    }
  }

  return {
    SCHEMA_VERSION,
    LIMITS,
    makeId,
    cleanText,
    normalizeUrl,
    fallbackTitle,
    normalizeTags,
    collectFolderIds,
    sanitizeLibrary,
    emptyLibrary,
    LibraryStore,
  };
});