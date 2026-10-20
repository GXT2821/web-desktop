// 下载管理：网页发起的下载落地到下载目录，并把进度/结果推给界面
//
// 为什么不再用"弹窗确认"：网页里的下载链接点了没反应，用户根本不知道发生了什么。
// 现在改成浏览器的做法——直接存到下载目录，界面上出现一条可追踪的下载记录
// （进度、失败原因、"在访达中显示"），要撤销随时可以取消或删文件。
// 防刷屏不靠弹窗，靠并发数与频率上限：页面循环触发下载也只会拖垮自己。

const fs = require('fs');
const path = require('path');

const MAX_HISTORY = 50; // 保留最近 50 条记录
const MAX_CONCURRENT = 6; // 同时最多 6 个下载
const RATE_WINDOW = 60_000; // 频率统计窗口
const RATE_LIMIT = 40; // 窗口内最多 40 次，超过视为页面异常
const PROGRESS_INTERVAL = 300; // 进度推送节流

function safeFilename(raw) {
  let name = String(raw || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .trim();
  if (!name || name === '.' || name === '..') name = 'download';
  if (name.length > 160) {
    const ext = path.extname(name).slice(0, 16);
    name = name.slice(0, 160 - ext.length) + ext;
  }
  return name;
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext) || 'download';
  let candidate = path.join(dir, name);
  let index = 1;
  while (fs.existsSync(candidate) && index < 1000) {
    candidate = path.join(dir, `${base} (${index})${ext}`);
    index += 1;
  }
  return candidate;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

class Downloads {
  constructor({ dataDir, getWindow, broadcast }) {
    this.dataDir = dataDir;
    this.getWindow = getWindow;
    this.broadcast = broadcast || (() => {});
    this.file = path.join(dataDir, 'downloads.json');
    this.items = [];
    this.live = new Map(); // id -> DownloadItem
    this.recent = []; // 触发时间戳，用于频率限制
    this.lastPush = new Map(); // id -> 上次推送时间
    this.timers = new Map(); // id -> 中断后的确认定时器
    this.notified = new Set(); // 已经提示过失败的 id
    this.load();
  }

  // ---------- 持久化 ----------

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf-8');
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : parsed && parsed.items;
      if (!Array.isArray(list)) return;
      this.items = list
        .filter((entry) => entry && typeof entry === 'object')
        .slice(0, MAX_HISTORY)
        .map((entry) => ({
          id: String(entry.id || ''),
          filename: safeFilename(entry.filename),
          path: typeof entry.path === 'string' ? entry.path : '',
          url: typeof entry.url === 'string' ? entry.url : '',
          host: typeof entry.host === 'string' ? entry.host : '',
          state: ['completed', 'cancelled', 'interrupted'].includes(entry.state)
            ? entry.state
            : 'interrupted',
          received: Number(entry.received) || 0,
          total: Number(entry.total) || 0,
          startedAt: Number(entry.startedAt) || Date.now(),
          finishedAt: Number(entry.finishedAt) || 0,
        }))
        .filter((entry) => entry.id);
    } catch {
      // 记录文件坏了就重来，不影响下载本身
      this.items = [];
    }
  }

  save() {
    const payload = JSON.stringify({ items: this.items.slice(0, MAX_HISTORY) }, null, 2);
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, payload, { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmp, this.file);
      try {
        fs.chmodSync(this.file, 0o600);
      } catch {
        /* 忽略 */
      }
    } catch (err) {
      console.error(`[downloads] 保存记录失败: ${err.message}`);
    }
  }

  // ---------- 对外快照 ----------

  snapshot() {
    return this.items.slice(0, MAX_HISTORY).map((entry) => ({
      id: entry.id,
      filename: entry.filename,
      path: entry.path,
      url: entry.url,
      host: entry.host,
      state: entry.state,
      received: entry.received,
      total: entry.total,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      exists: entry.path ? fs.existsSync(entry.path) : false,
    }));
  }

  push() {
    this.broadcast('downloads:changed', this.snapshot());
  }

  // ---------- 目录 ----------

  downloadDir() {
    const configured = process.env.DOCVAULT_DOWNLOAD_DIR
      ? path.resolve(process.env.DOCVAULT_DOWNLOAD_DIR)
      : '';
    let dir = configured;
    if (!dir) {
      try {
        const { app } = require('electron');
        dir = app.getPath('downloads');
      } catch {
        dir = '';
      }
    }
    if (!dir) dir = path.join(this.dataDir, 'downloads');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.warn(`[downloads] 下载目录不可用（${dir}），改存数据目录: ${err.message}`);
      dir = path.join(this.dataDir, 'downloads');
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        /* 实在不行就让 setSavePath 失败，走中断分支 */
      }
    }
    return dir;
  }

  // ---------- 频率限制 ----------

  allow() {
    const now = Date.now();
    this.recent = this.recent.filter((time) => now - time < RATE_WINDOW);
    if (this.live.size >= MAX_CONCURRENT) {
      return { ok: false, reason: `并发下载超过 ${MAX_CONCURRENT} 个` };
    }
    if (this.recent.length >= RATE_LIMIT) {
      return { ok: false, reason: `一分钟内下载超过 ${RATE_LIMIT} 次` };
    }
    this.recent.push(now);
    return { ok: true };
  }

  // ---------- 注册一个下载 ----------

  register(item, webContents) {
    const from = webContents && webContents.getURL ? webContents.getURL() : '';
    const filename = safeFilename(item.getFilename());

    const gate = this.allow();
    if (!gate.ok) {
      console.warn(`[downloads] 已丢弃下载请求（${gate.reason}）: ${filename}`);
      try {
        item.cancel();
      } catch {
        /* 忽略 */
      }
      return;
    }

    const dir = this.downloadDir();
    const target = uniquePath(dir, filename);
    try {
      item.setSavePath(target);
    } catch (err) {
      console.warn(`[downloads] 设置保存路径失败: ${err.message}`);
      item.cancel();
      return;
    }

    const entry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      filename: path.basename(target),
      path: target,
      url: typeof item.getURL === 'string' ? item.getURL() : '',
      host: hostOf(from),
      state: 'progressing',
      received: 0,
      total: item.getTotalBytes() || 0,
      startedAt: Date.now(),
      finishedAt: 0,
    };
    this.items.unshift(entry);
    if (this.items.length > MAX_HISTORY) this.items.length = MAX_HISTORY;
    this.live.set(entry.id, item);
    this.save();
    this.push();

    const notify = (state) => {
      const payload = { id: entry.id, filename: entry.filename };
      if (state === 'completed') this.broadcast('downloads:done', payload);
      else if (state === 'interrupted') this.broadcast('downloads:failed', payload);
    };

    // 中断有个坑：Chromium 报告 interrupted 后不一定会再发 done（可能在等待续传），
    // 而且那次进度推送很容易正好被节流吃掉——界面就会一直停在"下载中"。
    // 所以中断要立刻推一次，并起一个短定时器兜底发失败通知。
    item.on('updated', (_event, state) => {
      entry.received = item.getReceivedBytes() || 0;
      entry.total = item.getTotalBytes() || entry.total;

      if (state === 'interrupted') {
        entry.state = 'interrupted';
        this.push();
        if (!this.timers.has(entry.id)) {
          const timer = setTimeout(() => {
            this.timers.delete(entry.id);
            if (entry.state !== 'interrupted' || this.notified.has(entry.id)) return;
            this.notified.add(entry.id);
            notify('interrupted');
            console.warn(`[downloads] 下载中断: ${entry.filename}`);
          }, 1500);
          this.timers.set(entry.id, timer);
          if (typeof timer.unref === 'function') timer.unref();
        }
        return;
      }

      entry.state = 'progressing';
      const now = Date.now();
      const last = this.lastPush.get(entry.id) || 0;
      if (now - last >= PROGRESS_INTERVAL) {
        this.lastPush.set(entry.id, now);
        this.push();
      }
    });

    item.once('done', (_event, state) => {
      const timer = this.timers.get(entry.id);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(entry.id);
      }

      entry.received = item.getReceivedBytes() || entry.received;
      entry.total = item.getTotalBytes() || entry.total;
      entry.finishedAt = Date.now();
      entry.state =
        state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted';
      entry.path = state === 'completed' ? target : entry.path;

      this.live.delete(entry.id);
      this.lastPush.delete(entry.id);
      this.save();
      this.push();

      if (entry.state === 'interrupted') {
        if (!this.notified.has(entry.id)) {
          this.notified.add(entry.id);
          notify('interrupted');
        }
        console.warn(`[downloads] 下载中断: ${entry.filename}`);
      } else {
        notify(entry.state);
      }
    });
  }

  // ---------- 操作 ----------

  cancel(id) {
    const item = this.live.get(String(id || ''));
    if (!item) return false;
    try {
      item.cancel();
      return true;
    } catch {
      return false;
    }
  }

  reveal(id) {
    const entry = this.items.find((row) => row.id === String(id || ''));
    if (!entry || !entry.path) return false;
    const { shell } = require('electron');
    if (fs.existsSync(entry.path)) {
      shell.showItemInFolder(entry.path);
      return true;
    }
    // 文件已被移走/删除：退回到打开所在目录
    const dir = path.dirname(entry.path);
    if (fs.existsSync(dir)) {
      shell.openPath(dir);
      return true;
    }
    return false;
  }

  async open(id) {
    const entry = this.items.find((row) => row.id === String(id || ''));
    if (!entry || !entry.path || !fs.existsSync(entry.path)) {
      throw new Error('文件不存在或已被移动');
    }
    const { shell } = require('electron');
    const error = await shell.openPath(entry.path);
    if (error) throw new Error(error);
    return true;
  }

  clearFinished() {
    this.items = this.items.filter((entry) => entry.state === 'progressing');
    this.save();
    this.push();
    return this.snapshot();
  }

  activeCount() {
    return this.live.size;
  }
}

module.exports = { Downloads, safeFilename };