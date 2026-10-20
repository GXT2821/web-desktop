// 数据层（主进程）：把文档库持久化到 userData/library.json
//
// 设计要点：
// - 只存链接与元数据（标题、备注、标签、文件夹、星标、打开记录），不抓取网页内容；
// - 写入使用「临时文件 + rename」的原子替换，并在替换前留一份 .bak；
// - 文件损坏时优先回退 .bak，两份都坏才重建，且把坏文件改名留档，绝不静默丢数据；
// - 所有从渲染进程进来的字段都在这里做校验，主进程是唯一的数据可信边界。

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;

// 单个库文件的体积上限（超过视为损坏，原文件留档不删）
const MAX_FILE_BYTES = 50 * 1024 * 1024;

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

// ---------- Store ----------

class Store {
  constructor(file) {
    this.file = file;
    this.backupFile = `${file}.bak`;
    this.data = { version: SCHEMA_VERSION, folders: [], docs: [] };
  }

  // 读取磁盘数据；返回 { recovered: 'none'|'backup'|'reset' }
  // 'none'   = 正常（含全新安装，没有数据文件）
  // 'backup' = 主文件读不了，已从 .bak 恢复
  // 'reset'  = 主文件存在但读不了且备份也不可用，只能重建（原文件已留档）
  load() {
    const existed = fs.existsSync(this.file);
    const primary = this.#readFile(this.file);
    this.#tighten(); // 旧版本或手动拷贝可能留下 0644，载入时纠正一次
    if (primary.ok) {
      this.data = primary.data;
      return { recovered: 'none' };
    }

    const backup = this.#readFile(this.backupFile);
    if (backup.ok) {
      this.data = backup.data;
      if (existed) this.#quarantine(this.file);
      this.save();
      return { recovered: existed ? 'backup' : 'none' };
    }

    this.data = { version: SCHEMA_VERSION, folders: [], docs: [] };
    if (!existed) {
      this.save(); // 全新安装：直接建一个空库
      return { recovered: 'none' };
    }
    this.#quarantine(this.file);
    this.save();
    return { recovered: 'reset' };
  }

  #readFile(file) {
    try {
      if (!fs.existsSync(file)) return { ok: false };
      // 超大文件先拦下：正常库几 MB 就到头了，超过上限多半是文件被写坏。
      // 按"读不了"处理而不是硬解析，原文件会被留档，不会丢数据。
      const size = fs.statSync(file).size;
      if (size > MAX_FILE_BYTES) {
        console.error(`[store] 文件过大，按损坏处理 ${file} (${size} 字节)`);
        return { ok: false };
      }
      const raw = fs.readFileSync(file, 'utf-8');
      if (!raw.trim()) return { ok: false };
      return { ok: true, data: this.#sanitize(JSON.parse(raw)) };
    } catch (err) {
      console.error(`[store] 读取失败 ${file}: ${err.message}`);
      return { ok: false };
    }
  }

  // 把目录与数据文件的权限收紧到 0700 / 0600（尽力而为，失败不影响功能）
  #tighten() {
    const targets = [
      [path.dirname(this.file), 0o700],
      [this.file, 0o600],
      [this.backupFile, 0o600],
    ];
    for (const [target, mode] of targets) {
      try {
        if (fs.existsSync(target)) fs.chmodSync(target, mode);
      } catch {
        /* 只读文件系统等场景下忽略 */
      }
    }
  }

  #quarantine(file) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.renameSync(file, `${file}.corrupt-${stamp}`);
      this.#pruneQuarantined();
    } catch (err) {
      console.error(`[store] 留档坏文件失败: ${err.message}`);
    }
  }

  // 留档文件只保留最近 5 个，避免反复损坏时把目录撑大
  #pruneQuarantined(keep = 5) {
    try {
      const dir = path.dirname(this.file);
      const prefix = `${path.basename(this.file)}.corrupt-`;
      const files = fs.readdirSync(dir).filter((name) => name.startsWith(prefix)).sort();
      for (const name of files.slice(0, Math.max(0, files.length - keep))) {
        fs.rmSync(path.join(dir, name), { force: true });
      }
    } catch (err) {
      console.error(`[store] 清理留档文件失败: ${err.message}`);
    }
  }

  // 把任意 JSON 收敛成合法结构，坏条目直接丢弃而不是让整个文件失效
  #sanitize(raw) {
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
      const id = typeof item.id === 'string' && item.id && !seenIds.has(item.id)
        ? item.id
        : makeId('d');
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

  // 原子写入：先写 .tmp，再备份旧文件，最后 rename 覆盖
  // 文件权限固定 0600：文档库里的链接/备注可能是内部资料，不给同机其他用户读
  save() {
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
      try {
        if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.backupFile);
        fs.renameSync(tmp, this.file);
      } catch (err) {
        // rename 在个别文件系统上会失败，退化为直接写
        fs.writeFileSync(this.file, fs.readFileSync(tmp, 'utf-8'), { encoding: 'utf-8', mode: 0o600 });
        fs.rmSync(tmp, { force: true });
      }
      // writeFileSync 的 mode 只在新建文件时生效，这里兜底纠正已存在文件的权限（失败不影响功能）
      try {
        fs.chmodSync(this.file, 0o600);
      } catch {
        /* 权限纠正失败可忽略 */
      }
    } catch (err) {
      console.error(`[store] 保存失败: ${err.message}`);
      throw new Error(`保存失败：${err.message}`);
    }
  }

  // 暴露给渲染进程的快照（附带数据文件位置，便于用户备份）
  snapshot() {
    return {
      version: this.data.version,
      folders: this.data.folders.map((f) => ({ ...f })),
      docs: this.data.docs.map((d) => ({ ...d, tags: [...d.tags] })),
      dataFile: this.file,
      backupFile: this.backupFile,
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
      doc.folderId = this.data.folders.some((f) => f.id === patch.folderId) ? patch.folderId : null;
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
      return { mode, removedFolders: ids.length, removedDocs: affected.length, affectedDocs: affected.length };
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

module.exports = { Store, normalizeUrl, fallbackTitle, LIMITS };