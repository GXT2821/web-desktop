// 加密导出 / 导入：用 U 盘在设备之间搬文档库。
//
// 与"备份口令"一样，导出的文件用一个独立口令加密：
//   DVE1 | salt 16 | iv 12 | tag 16 | AES-256-GCM(JSON payload)
//   密钥 = scrypt(passphrase, salt, 32, N=32768, r=8, p=1)
// 口令不上传、不落盘；文件本身可以随便放 U 盘/网盘，没有口令打不开。
//
// 导入支持两种模式：
//   overwrite  整个库替换为文件里的内容
//   merge      以现有库为准，补充新文件夹/新文档（同一链接不重复加）
// 合并按"文件夹 id"和"链接归一化后的 URL"判重；文件夹父级丢了就挂回根目录。

const crypto = require('crypto');
const core = require('./store-core');

const MAGIC = Buffer.from('DVE1', 'ascii');
const AAD = Buffer.from('docvault-export-v1');
const KDF = { alg: 'scrypt', N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function assertPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new Error('导出/导入口令至少 8 位（丢了无法恢复，请用长口令并另存）');
  }
}

function encryptLibrary(library, passphrase) {
  assertPassphrase(passphrase);
  const payload = {
    v: 1,
    exportedAt: Date.now(),
    library: {
      version: library.version,
      folders: library.folders || [],
      docs: library.docs || [],
    },
  };
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32, KDF);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(AAD);
    const body = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(payload), 'utf-8')),
      cipher.final(),
    ]);
    return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
  } finally {
    key.fill(0);
  }
}

function decryptExport(blob, passphrase) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.length < 4 + 16 + 12 + 16 || !buf.subarray(0, 4).equals(MAGIC)) {
    throw new Error('不是有效的文档库加密导出文件（文件头不正确）');
  }
  const salt = buf.subarray(4, 20);
  const iv = buf.subarray(20, 32);
  const tag = buf.subarray(32, 48);
  const key = crypto.scryptSync(passphrase, salt, 32, KDF);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(buf.subarray(48)), decipher.final()]);
    const payload = JSON.parse(plain.toString('utf-8'));
    if (!payload || payload.v !== 1 || !payload.library) {
      throw new Error('导出文件内容格式不正确');
    }
    return payload;
  } catch (err) {
    if (/口令|口令不正确|unable to authenticate|bad decrypt/i.test(err.message)) {
      throw new Error('口令不正确，或文件已损坏');
    }
    throw err;
  } finally {
    key.fill(0);
  }
}

// 合并：现有库优先，只补充新东西；
//   判重键 = 归一化 URL + 所属文件夹（与本地"同链接可存在于不同文件夹"的模型一致），
//   文档 id 冲突时重新分配，避免两台设备各自改过同一条后合并出重复 id。
function mergeLibraries(current, incoming) {
  const base = core.sanitizeLibrary(current);
  // 导入的文档可能引用"现有库里的文件夹"：合并文件夹列表后再 sanitize，
  // 否则单独清洗 incoming 会把 f2 之类的 folderId 当成孤儿清成 null。
  const add = core.sanitizeLibrary({
    version: incoming && incoming.version,
    folders: [...base.folders, ...((incoming && incoming.folders) || [])],
    docs: (incoming && incoming.docs) || [],
  });

  const folders = base.folders.map((f) => ({ ...f }));
  const folderIds = new Set(folders.map((f) => f.id));
  let foldersAdded = 0;
  for (const folder of add.folders) {
    if (folderIds.has(folder.id)) continue;
    folders.push({ ...folder });
    folderIds.add(folder.id);
    foldersAdded += 1;
  }
  // 导入的文件夹可能引用了未导入的父级：挂回根目录
  for (const folder of folders) {
    if (folder.parentId && !folderIds.has(folder.parentId)) folder.parentId = null;
  }

  const docs = base.docs.map((d) => ({ ...d, tags: [...d.tags] }));
  const seen = new Set(docs.map((d) => `${core.urlKey(d.url)}|${d.folderId || ''}`));
  const docIds = new Set(docs.map((d) => d.id));
  let docsAdded = 0;
  let docsSkipped = 0;
  for (const doc of add.docs) {
    const key = `${core.urlKey(doc.url)}|${doc.folderId || ''}`;
    if (seen.has(key)) {
      docsSkipped += 1;
      continue;
    }
    // id 被另一条不同内容占用：换一个新 id，避免编辑/删除命中错条目
    const id = docIds.has(doc.id) ? core.makeId('d') : doc.id;
    docIds.add(id);
    docs.push({ ...doc, id, tags: [...doc.tags] });
    seen.add(key);
    docsAdded += 1;
  }

  return {
    library: { version: base.version, folders, docs },
    stats: { foldersAdded, docsAdded, docsSkipped },
  };
}

function exportFilename(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `DocVault-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.dve`;
}

module.exports = {
  MAGIC,
  assertPassphrase,
  encryptLibrary,
  decryptExport,
  mergeLibraries,
  exportFilename,
};