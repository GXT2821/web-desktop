// 数据层（主进程）：把文档库持久化到 userData/library.json
//
// 设计要点：
// - 只存链接与元数据（标题、备注、标签、文件夹、星标、打开记录），不抓取网页内容；
// - 写入使用「临时文件 + rename」的原子替换，并在替换前留一份 .bak；
// - 文件损坏时优先回退 .bak，两份都坏才重建，且把坏文件改名留档，绝不静默丢数据；
// - 所有从渲染进程进来的字段都在这里做校验，主进程是唯一的数据可信边界。
//
// 校验与增删改逻辑在 src/store-core.js（Android 端共用同一份），这里只负责
// 文件读写、备份、权限与损坏留档。

const fs = require('fs');
const path = require('path');
const core = require('./store-core');

const {
  SCHEMA_VERSION,
  LIMITS,
  normalizeUrl,
  fallbackTitle,
  sanitizeLibrary,
  emptyLibrary,
  LibraryStore,
} = core;

// 单个库文件的体积上限（超过视为损坏，原文件留档不删）
const MAX_FILE_BYTES = 50 * 1024 * 1024;

class Store extends LibraryStore {
  constructor(file) {
    super(emptyLibrary());
    this.file = file;
    this.backupFile = `${file}.bak`;
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

    this.data = emptyLibrary();
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
      return { ok: true, data: sanitizeLibrary(JSON.parse(raw)) };
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

  // 原子写入：先写 .tmp，再备份旧文件，最后 rename 覆盖
  // 文件权限固定 0600：文档库里的链接/备注可能是内部资料，不给同机其他用户读
  save() {
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, {
        encoding: 'utf-8',
        mode: 0o600,
      });
      try {
        if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.backupFile);
        fs.renameSync(tmp, this.file);
      } catch (err) {
        // rename 在个别文件系统上会失败，退化为直接写
        fs.writeFileSync(this.file, fs.readFileSync(tmp, 'utf-8'), {
          encoding: 'utf-8',
          mode: 0o600,
        });
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
      ...super.snapshot(),
      dataFile: this.file,
      backupFile: this.backupFile,
    };
  }
}

module.exports = { Store, normalizeUrl, fallbackTitle, LIMITS, SCHEMA_VERSION, sanitizeLibrary };