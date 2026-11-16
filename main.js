// 主进程：窗口、数据持久化、webview 策略与安全边界
//
// 定位：一个「在线文档收藏夹」。链接与元数据存在 userData/library.json，
// 点开文档在应用内用 <webview> 打开（登录态由 Electron 的持久化 session 保留）。

const { app, BrowserWindow, Menu, ipcMain, shell, clipboard, session, screen, dialog, powerMonitor } = require('electron');
const { fileURLToPath } = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./src/store');
const { sanitizeLibrary } = require('./src/store');
const transfer = require('./src/transfer');
const { Downloads } = require('./src/downloads');
const { Vault } = require('./src/vault');
const { resetDataDir, listTargets, removeTokenFile } = require('./src/reset');
const { createSessionStore } = require('./src/session');
const { isIdleLock } = require('./src/idle');
const softToken = require('./src/token/soft-token');
const tokenProvider = require('./src/token/provider');

// 界面与网页语言：默认简体中文。
// 打包后的 .app 如果没声明中文本地化，macOS 会把进程语言判成 en-US，
// navigator.language / Accept-Language 于是变成英文，文档站就整页英文。
// 这里显式指定（必须在 app ready 前），不依赖系统语言；需要别的语言用 DOCVAULT_LANG 覆盖。
const APP_LANG = process.env.DOCVAULT_LANG || 'zh-CN';
app.commandLine.appendSwitch('lang', APP_LANG);
app.commandLine.appendSwitch(
  'accept-lang',
  `${APP_LANG},${APP_LANG.split('-')[0]};q=0.9,en;q=0.8`
);

// 固定数据目录：即使以后改 productName，数据也不会"搬家"
// 可用 DOCVAULT_DATA_DIR 覆盖，便于把数据放到 iCloud / 移动硬盘或做便携运行
const DATA_DIR = process.env.DOCVAULT_DATA_DIR
  ? path.resolve(process.env.DOCVAULT_DATA_DIR)
  : path.join(app.getPath('appData'), 'DocVault');
app.setPath('userData', DATA_DIR);
// 目录必须自己建：Chromium 的单实例锁要往这里写 SingletonLock，
// 目录不存在时锁会静默失败，两个实例同时写同一个 library.json 就会互相覆盖。
try {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
} catch (err) {
  console.error(`[startup] 创建数据目录失败: ${err.message}`);
}

// ---------- U盾保险库 ----------
// 启用保护后：数据文件是 library.enc，store 用 Vault 的 codec 加解密；
// 锁定时 store 为 null、DEK 清零，内存里不存在任何文档数据。
const vault = new Vault(DATA_DIR);
let store = null;
let mainWindow = null;
// 打开中的网页标签（标题/链接/活动项）。
// 内存里留一份用于"锁定→解锁"的快速恢复；同时落盘，关闭应用再打开也能恢复。
// 启用 U盾时以加密文件保存（session.enc），未启用时是明文 session.json。
let sessionTabs = null;
let sessionStore = null;
let lockWindow = null;
const IDLE_MINUTES = Math.max(1, Number(process.env.DOCVAULT_IDLE_MINUTES) || 10);

// 整体替换数据库内容：先写盘成功，再承认新数据。
// 反过来的写法（先改内存再 save）在磁盘满/只读时会留下"IPC 报错但内存已换库"的状态，
// 用户再编辑一次就把新库写盘、原库只剩一代 .bak。
function replaceStoreData(next) {
  if (!store) throw new Error('数据层未就绪');
  const previous = store.data;
  store.data = next;
  try {
    store.save();
  } catch (err) {
    store.data = previous;
    throw err;
  }
  return next;
}

// 打开数据层（仅在解锁状态调用）：按保护开关选择明文/加密文件
function openStore() {
  const file = vault.isEnabled()
    ? path.join(DATA_DIR, 'library.enc')
    : path.join(DATA_DIR, 'library.json');
  store = new Store(file, vault.isEnabled() ? { codec: vault.codec() } : {});
  return store.load();
}

// 给所有窗口广播（下载进度、完成、失败）
function broadcastToWindows(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

// 下载记录与管理（不含流式内容，只记元数据）
const downloads = new Downloads({
  dataDir: DATA_DIR,
  broadcast: broadcastToWindows,
});
const WINDOW_STATE_FILE = path.join(DATA_DIR, 'window-state.json');
// 开发期窗口/Dock 图标；打包后由 .app 的 icns、exe 内嵌图标接管（build/ 不随包分发）
const DEV_ICON = path.join(__dirname, 'build', 'icon.png');
// 打包版的窗口图标：从 resources/icon.ico 读（extraResources 落盘），
// 不能指向 asar 内的路径——nativeImage 不认 asar，读不到时会退回 exe 自带的图标。
const PACKAGED_ICON = path.join(process.resourcesPath, 'icon-app-f.ico');
const WINDOW_ICON = app.isPackaged ? PACKAGED_ICON : DEV_ICON;
// Windows 任务栏按 AppUserModelID 分组和缓存图标；显式设置后用应用自己的图标
try {
  app.setAppUserModelId('com.gt.docvault');
} catch {
  /* 非 Windows 平台忽略 */
}

// 外壳页面路径：外壳窗口只允许停在这个文件上（见 isShellUrl）
const SHELL_FILE = path.join(__dirname, 'src', 'shell.html');
// 锁定页路径：锁定窗口只允许停在这个文件上
const LOCK_FILE = path.join(__dirname, 'src', 'lock.html');

// 是否为外壳自身的地址（容忍 file:// 的百分号编码、#hash 与平台路径差异）
// 注意不能直接拿 URL.pathname 和本地路径比：Windows 上 pathname 是 "/C:/…"，
// 而 SHELL_FILE 是 "C:\\…"，两者永远不相等，守卫会把外壳自己的页面也当成外部导航。
function fileUrlMatches(raw, target) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'file:') return false;
    const actual = path.normalize(fileURLToPath(url));
    const expected = path.normalize(target);
    // Windows 路径大小写不敏感，盘符大小写可能不一致
    return process.platform === 'win32'
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
  } catch {
    return false;
  }
}

function isShellUrl(raw) {
  return fileUrlMatches(raw, SHELL_FILE);
}

function isLockUrl(raw) {
  return fileUrlMatches(raw, LOCK_FILE);
}

// 默认允许的网页权限：只留"不碰硬件与隐私"的两项，其余（摄像头/麦克风/定位/通知/USB 等）一律拒绝
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);

// ---------- 通用工具 ----------

// 只有 http/https 才允许进入 webview 或交给系统浏览器
function isOpenable(url) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// 抹掉 UA 里的 Electron / 应用标识：部分文档站点（Google 登录等）会因此拒绝服务
const { buildCleanUA } = require('./src/user-agent');
const { bindGuestShortcuts } = require('./src/shortcuts');

// 开发调试快捷键：F12 或 Cmd/Ctrl+Shift+I 打开对应页面的调试器
// 打包后默认关闭（release 里开着调试器等于把脚本执行入口摆在界面上），
// 需要排查时用 DOCVAULT_DEVTOOLS=1 启动。
function bindDevtools(contents, event, input) {
  if (app.isPackaged && process.env.DOCVAULT_DEVTOOLS !== '1') return;
  if (input.type !== 'keyDown') return;
  const mod = process.platform === 'darwin' ? input.meta : input.control;
  const key = String(input.key || '').toLowerCase();
  if (key === 'f12' || (mod && input.shift && key === 'i')) {
    event.preventDefault();
    contents.toggleDevTools();
  }
}

// 焦点在 webview 里时，应用级快捷键的处理见 src/shortcuts.js：
// Cmd/Ctrl+F 不拦（留给网页自己的「查找」），w/r/n/1-9 照旧转发。

// 每个 webview（guest）挂载时的统一加固
function hardenGuest(win, guest) {
  guest.setUserAgent(buildCleanUA(guest.getUserAgent()));
  // 非激活标签由 CSS display:none 隐藏，配合默认为 true 的后台节流降低占用
  guest.setBackgroundThrottling(true);

  // 页面内的 window.open / target=_blank → 不弹新窗口，改为应用内新标签
  guest.setWindowOpenHandler(({ url }) => {
    if (isOpenable(url)) win.webContents.send('open-tab', { url });
    return { action: 'deny' };
  });

  // 站内点击只能跳到 http/https，挡住 file:/javascript: 之类的意外导航
  guest.on('will-navigate', (event, url) => {
    if (!isOpenable(url)) event.preventDefault();
  });

  guest.on('before-input-event', (event, input) => bindDevtools(guest, event, input));
  bindGuestShortcuts(win, guest);
}

// ---------- 窗口尺寸记忆 ----------

function readWindowState() {
  const fallback = { width: 1360, height: 860 };
  try {
    const raw = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf-8'));
    const bounds = { x: raw.x, y: raw.y, width: raw.width, height: raw.height };
    if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return fallback;
    // 文件被外部改坏时可能给出离谱尺寸，夹到合理区间
    bounds.width = Math.min(Math.max(Math.round(bounds.width), 640), 8000);
    bounds.height = Math.min(Math.max(Math.round(bounds.height), 480), 8000);
    // 显示器拔掉后旧坐标可能落在屏幕外，校验一次
    if (Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) {
      const visible = screen.getAllDisplays().some((display) => {
        const area = display.workArea;
        return (
          bounds.x < area.x + area.width &&
          bounds.x + bounds.width > area.x &&
          bounds.y < area.y + area.height &&
          bounds.y + bounds.height > area.y
        );
      });
      if (!visible) return { width: bounds.width, height: bounds.height };
    } else {
      delete bounds.x;
      delete bounds.y;
    }
    return bounds;
  } catch {
    return fallback;
  }
}

function watchWindowState(win) {
  let timer = null;
  const persist = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    try {
      // 与 library.json 保持一致：窗口坐标也不该给同机其他用户看
      fs.writeFileSync(WINDOW_STATE_FILE, JSON.stringify(win.getNormalBounds()), { encoding: 'utf-8', mode: 0o600 });
      try {
        fs.chmodSync(WINDOW_STATE_FILE, 0o600); // 已存在的旧文件 mode 不会变，兜底纠正
      } catch {
        /* 权限纠正失败可忽略 */
      }
    } catch (err) {
      console.error(`[window-state] 保存失败: ${err.message}`);
    }
  };
  const debounced = () => {
    clearTimeout(timer);
    timer = setTimeout(persist, 400);
  };
  win.on('resize', debounced);
  win.on('move', debounced);
  win.on('close', () => {
    clearTimeout(timer);
    persist();
  });
}

// ---------- 窗口 ----------

function createMainWindow() {
  const win = new BrowserWindow({
    ...readWindowState(),
    minWidth: 960,
    minHeight: 620,
    title: '文档库',
    backgroundColor: '#f6f7f9',
    show: false,
    // 窗口图标始终显式指定：打包版用包内 src/icon.ico，开发期用 build/icon.png
    icon: WINDOW_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true, // 文档在应用内以 <webview> 打开
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  watchWindowState(win);

  // 外壳窗口只允许停在自己的页面上。
  // 没有这道守卫时，把一个链接/HTML 文件拖到窗口上就会把外壳页面替换掉，
  // 而 preload 仍会挂到新文档上——那个第三方页面将直接拿到 window.api（可读写整个文档库）。
  const blockShellNavigation = (event, url) => {
    if (isShellUrl(url)) return;
    event.preventDefault();
    console.warn(`[security] 已拦截外壳窗口导航: ${url}`);
    if (isOpenable(url)) shell.openExternal(url); // 与 window.open 的处理保持一致：外链交给系统浏览器
  };
  win.webContents.on('will-navigate', blockShellNavigation);
  win.webContents.on('will-frame-navigate', (event) => {
    if (!isShellUrl(event.url)) {
      event.preventDefault();
      console.warn(`[security] 已拦截外壳窗口子框架导航: ${event.url}`);
    }
  });

  // 外壳页面本身不允许弹窗，外链一律交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOpenable(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('before-input-event', (event, input) => bindDevtools(win.webContents, event, input));

  // webview 挂载前清洗配置：不给 guest 任何 preload / Node 能力
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    if (!isOpenable(params.src)) event.preventDefault();
  });

  win.webContents.on('did-attach-webview', (event, guest) => hardenGuest(win, guest));

  // macOS 关掉窗口后应用还活着；不能让它"关窗=绕过解锁"，关窗即锁定。
  // Windows/Linux 关窗即退出，交给 window-all-closed。
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    if (app.isQuitting || process.platform !== 'darwin') return;
    // 关窗后应用仍在后台运行：必须上锁，避免"关窗再点 Dock 就绕过令牌"。
    // doLock 内部会处理已锁定/恢复态，不会重复建窗口。
    if (vault.isEnabled()) doLock('主窗口已关闭');
  });

  win.loadFile(path.join(__dirname, 'src', 'shell.html'));
  return win;
}

// ---------- 锁定窗口 ----------
// 独立的页面 + 独立的 preload（只有 vault 方法，没有 window.api），
// 不启用 webviewTag：锁定态不存在任何网页内容。
function createLockWindow() {
  const win = new BrowserWindow({
    width: 480,
    height: 680,
    resizable: false,
    maximizable: false,
    title: '文档库 · 已锁定',
    backgroundColor: '#f6f7f9',
    show: false,
    icon: WINDOW_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload-lock.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.removeMenu();

  // 与外壳同样的导航守卫：锁定窗口只能停在 lock.html
  const blockNavigation = (event, url) => {
    if (isLockUrl(url)) return;
    event.preventDefault();
    console.warn(`[security] 已拦截锁定窗口导航: ${url}`);
  };
  win.webContents.on('will-navigate', blockNavigation);
  win.webContents.on('will-frame-navigate', (event) => {
    if (!isLockUrl(event.url)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('before-input-event', (event, input) => bindDevtools(win.webContents, event, input));

  win.loadFile(LOCK_FILE);
  return win;
}

// ---------- IPC ----------

// 只有"我们自己的两个窗口"能发起 IPC；webview guest 一律拒绝。
// 这是渲染层隔离之外的第二道防线：即使某个页面拿到了 ipcRenderer，
// 只要它不是主窗口/锁定窗口的 webContents，调用也会被丢弃。
function trustedSender(event) {
  const sender = event.sender;
  if (mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents) return 'main';
  if (lockWindow && !lockWindow.isDestroyed() && sender === lockWindow.webContents) return 'lock';
  return null;
}

// 数据类通道：必须来自主窗口，且保险库处于解锁状态
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, payload) => {
    if (trustedSender(event) !== 'main' || !store || (vault.isEnabled() && vault.isLocked())) {
      return { ok: false, error: '文档库已锁定' };
    }
    try {
      return { ok: true, data: await fn(payload) };
    } catch (err) {
      console.error(`[ipc:${channel}] ${err.message}`);
      return { ok: false, error: err.message || '操作失败' };
    }
  });
}

// 保险库通道：两个窗口都可调用，但每个操作自带状态前置条件
function handleVault(channel, fn, { from } = {}) {
  ipcMain.handle(channel, async (event, payload) => {
    const origin = trustedSender(event);
    if (!origin || (from && origin !== from)) {
      return { ok: false, error: '当前窗口无权执行此操作' };
    }
    try {
      return { ok: true, data: await fn(payload || {}, origin) };
    } catch (err) {
      console.error(`[ipc:${channel}] ${err.message}`);
      return { ok: false, error: err.message || '操作失败' };
    }
  });
}

// 导出文件名：DocVault-20261021-1745.json，和 Android 端的导入说明对得上
function exportFilename() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `DocVault-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`;
}

function registerSessionIpc() {
  sessionStore = createSessionStore({
    dataDir: DATA_DIR,
    isVaultEnabled: () => vault.isEnabled(),
    isVaultLocked: () => vault.isLocked(),
    codec: () => vault.codec(),
  });

  ipcMain.on('session:save', (event, state) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
    const normalized = require('./src/session').normalize(state);
    if (!normalized) return;
    sessionTabs = normalized; // 锁定时窗口会销毁，内存里这份用于快速恢复
    try {
      sessionStore.save(normalized); // 落盘：关闭应用再打开也能恢复
    } catch {
      /* 落盘失败不影响使用 */
    }
  });

  // 与其它通道保持同样的 { ok, data } 返回形状（preload 的 call() 依赖它）。
  // 会话里是打开着的文档链接，只给主窗口。没有内存副本时（刚启动）从磁盘读：
  // 启用 U盾时读加密文件，锁定时读不到（返回 null），解锁后再恢复。
  ipcMain.handle('session:get', (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      return { ok: false, error: '当前窗口无权执行此操作' };
    }
    let data = sessionTabs;
    if (!data && sessionStore) data = sessionStore.load();
    return { ok: true, data: data || null };
  });
}

// ---------- IPC ----------
function registerIpc() {
  const snapshot = () => store.snapshot();

  handle('library:get', () => snapshot());
  handle('library:info', () => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    dataDir: DATA_DIR,
    dataFile: store.file,
    vault: vault.status(),
  }));

  handle('doc:add', (input) => {
    store.addDoc(input || {});
    return snapshot();
  });
  handle('doc:update', ({ id, patch } = {}) => {
    store.updateDoc(id, patch || {});
    return snapshot();
  });
  handle('doc:delete', ({ id } = {}) => {
    store.deleteDoc(id);
    return snapshot();
  });
  handle('doc:touch', ({ id } = {}) => {
    store.touchDoc(id);
    return snapshot();
  });
  handle('doc:auto-title', ({ id, title } = {}) => {
    store.updateDoc(id, { autoTitle: title });
    return snapshot();
  });

  handle('folder:add', ({ name, parentId } = {}) => {
    store.addFolder(name, parentId);
    return snapshot();
  });
  handle('folder:rename', ({ id, name } = {}) => {
    store.renameFolder(id, name);
    return snapshot();
  });
  handle('folder:delete', ({ id, mode } = {}) => {
    store.deleteFolder(id, mode === 'cascade' ? 'cascade' : 'keep');
    return snapshot();
  });

  handle('shell:open-external', ({ url } = {}) => {
    if (!isOpenable(url)) throw new Error('只支持用浏览器打开 http/https 链接');
    return shell.openExternal(url);
  });
  handle('clipboard:write', ({ text } = {}) => {
    // 加长度上限：写着剪贴板的可能整段链接/备注，避免异常调用把主进程卡住
    clipboard.writeText(String(text == null ? '' : text).slice(0, 100_000));
    return true;
  });
  // 导出成 JSON 文件：交给系统"另存为"，用户自己选位置（默认落在下载目录）
  handle('library:export', async () => {
    // 启用 U盾后不再提供明文导出通道（渲染层已改道，这里再拦一次，防止绕过界面调用 IPC）
    if (vault.isEnabled()) throw new Error('已启用 U盾保护，请使用「文件 → 导出…」');
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const { canceled, filePath } = await dialog.showSaveDialog(win || undefined, {
      title: '导出文档库',
      defaultPath: path.join(app.getPath('downloads'), exportFilename()),
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (canceled || !filePath) return { canceled: true };

    const payload = store.exportPayload();
    await fs.promises.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    return {
      canceled: false,
      path: filePath,
      docs: payload.docs.length,
      folders: payload.folders.length,
    };
  });

  handle('store:reveal', () => {
    if (fs.existsSync(store.file)) shell.showItemInFolder(store.file);
    else shell.openPath(DATA_DIR);
    return true;
  });

  // ---------- 加密导出 / 导入（U 盘多端同步） ----------
  handle('data:export-encrypted', async ({ passphrase } = {}) => {
    transfer.assertPassphrase(passphrase);
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const { canceled, filePath } = await dialog.showSaveDialog(win || undefined, {
      title: '导出文档库',
      defaultPath: path.join(app.getPath('downloads'), transfer.exportFilename()),
      filters: [{ name: '文档库备份', extensions: ['dve'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (canceled || !filePath) return { canceled: true };
    const blob = transfer.encryptLibrary(store.exportPayload(), passphrase);
    await fs.promises.writeFile(filePath, blob, { mode: 0o600 });
    return {
      canceled: false,
      path: filePath,
      docs: store.data.docs.length,
      folders: store.data.folders.length,
      size: blob.length,
    };
  });

  handle('data:import-encrypted', async ({ passphrase, mode } = {}) => {
    transfer.assertPassphrase(passphrase);
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const { canceled, filePaths } = await dialog.showOpenDialog(win || undefined, {
      title: '导入备份',
      properties: ['openFile'],
      filters: [{ name: '文档库备份', extensions: ['dve'] }],
    });
    if (canceled || !filePaths || !filePaths.length) return { canceled: true };
    const stat = await fs.promises.stat(filePaths[0]);
    if (stat.size > 50 * 1024 * 1024) throw new Error('备份文件超过 50MB，已拒绝导入');
    const blob = await fs.promises.readFile(filePaths[0]);
    const payload = transfer.decryptExport(blob, passphrase);
    // 先按原始条数拦截，再清洗：避免恶意文件先消耗一遍 sanitize
    const rawDocs = payload.library && Array.isArray(payload.library.docs) ? payload.library.docs.length : 0;
    if (rawDocs > 50000) throw new Error('备份里的文档数量异常，已拒绝导入');
    const incoming = sanitizeLibrary(payload.library);
    if (mode === 'overwrite') {
      replaceStoreData(incoming);
      return {
        canceled: false,
        mode: 'overwrite',
        library: store.snapshot(),
        stats: { foldersAdded: incoming.folders.length, docsAdded: incoming.docs.length, docsSkipped: 0 },
      };
    }
    const merged = transfer.mergeLibraries(store.data, incoming);
    replaceStoreData(merged.library);
    return { canceled: false, mode: 'merge', library: store.snapshot(), stats: merged.stats };
  });

  // ---------- 下载 ----------
  handle('downloads:list', () => downloads.snapshot());
  handle('downloads:cancel', ({ id } = {}) => downloads.cancel(id));
  handle('downloads:reveal', ({ id } = {}) => downloads.reveal(id));
  handle('downloads:open', ({ id } = {}) => downloads.open(id));
  handle('downloads:clear', () => downloads.clearFinished());

}

// ---------- 保险库：生命周期 ----------

// 用户确认进入：加载数据 → 打开主窗口 → 销毁锁定窗口
// 单独包一层 try/catch：本函数会从 setImmediate / 事件回调里调用，
// 数据目录不可写时抛出的异常没人接，会直接崩掉主进程（表现为窗口刚出现又消失）。
function bootUnlocked() {
  try {
    startUnlocked();
  } catch (err) {
    console.error(`[startup] 打开文档库失败：${err.message}`);
    try {
      dialog.showErrorBox('无法打开文档库', err.message);
    } catch {
      /* 无图形环境时忽略 */
    }
    // 没有锁定页可回退（首次启动）时别留一个无窗口的僵尸进程
    if (BrowserWindow.getAllWindows().length === 0) app.quit();
  }
}

function startUnlocked() {
  // 解锁与"确定进入"是两条 IPC，理论上可能被连点；已在文档库界面时不再开第二个窗口
  if (mainWindow && !mainWindow.isDestroyed()) return;
  // 只有密文、没有 vault.json：不能按"未启用"启动并建空库（用户会以为数据没了）。
  if (!vault.isEnabled() && fs.existsSync(vault.encFile)) {
    // 明文库还在：多半是上一次"启用加密"中途失败留下的孤儿密文。
    // 改名留档后照常启动，而不是把用户挡在门外（数据仍在 library.json 里）。
    const plainFile = path.join(DATA_DIR, 'library.json');
    if (fs.existsSync(plainFile)) {
      const orphan = `${vault.encFile}.orphan-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try {
        fs.renameSync(vault.encFile, orphan);
        console.warn(`[vault] 发现孤儿密文，已改名留档：${orphan}`);
      } catch (err) {
        dialog.showErrorBox('保护配置缺失', `发现无法识别的 ${vault.encFile}，且改名失败：${err.message}`);
        app.quit();
        return;
      }
    } else {
      dialog.showErrorBox(
        '保护配置缺失',
        `找到了加密数据 ${vault.encFile}，但缺少 vault.json（保护配置）。\n\n请从备份恢复 vault.json 后再启动，不要继续使用空库。`
      );
      app.quit();
      return;
    }
  }
  // 保险库已启用但密文文件不在：绝不能当成"全新安装"建空库覆盖——
  // 那会让用户以为数据没了，其实只是文件被移走/同步盘没同步下来。
  if (vault.isEnabled() && !fs.existsSync(vault.encFile)) {
    dialog.showErrorBox(
      '加密数据文件缺失',
      `找不到 ${vault.encFile}。\n\n请确认数据目录没有被清理，或从备份中恢复 library.enc 后再启动。`
    );
    app.quit();
    return;
  }
  pendingEnter = false;
  const result = openStore();
  mainWindow = createMainWindow();
  if (lockWindow && !lockWindow.isDestroyed()) lockWindow.destroy();
  lockWindow = null;
  // 解锁后重建菜单：恢复流程里可能新增/解绑过令牌，菜单上的"令牌管理（N 枚）"要跟上
  setupMenu();

  if (result.recovered !== 'none') {
    const message = result.recovered === 'backup'
      ? '数据文件读取失败，已从备份恢复。建议检查该文件是否被外部程序改坏。'
      : '数据文件无法读取，已重建为空库；原文件已改名留档在同一目录，不会被覆盖。';
    dialog.showMessageBox(mainWindow, { type: 'warning', title: '数据恢复提示', message });
  }
}

// 锁定：取消进行中的下载 → 清掉内存数据与 DEK → 主窗口换成锁定窗口
// 注意顺序：必须先建好锁定窗口再销毁主窗口。反过来会在"所有窗口都关了"的
// 瞬间触发 window-all-closed → app.quit()，应用直接退出。
function doLock(reason) {
  if (!vault.isEnabled()) return;
  const recovering = vault.state === 'recovery';
  // recovery 虽然 isLocked() 也算 true，但 DEK 已在内存，必须同样清掉并退回锁定
  if (!recovering && vault.isLocked()) return;
  for (const entry of downloads.snapshot()) {
    if (entry.state === 'progressing') downloads.cancel(entry.id);
  }
  vault.lock();
  store = null;
  // 锁定态不在内存里留着"最近打开了哪些文档"——它和文档库一样属于隐私数据
  sessionTabs = null;
  pendingEnter = false;
  if (!lockWindow || lockWindow.isDestroyed()) lockWindow = createLockWindow();
  else {
    lockWindow.show();
    // 复位锁定页：清掉"已读取/等待确定"或恢复态残留，重新按 locked 渲染
    lockWindow.webContents.reload();
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  mainWindow = null;
  console.log(`[vault] 已锁定：${reason}`);
}

// 免 PIN 令牌：插入后自动"读取密钥"，但**不自动进入**——
// 锁定页会播放读取动画，用户点「确定」才打开文档库。
// 带 PIN 的令牌绝不会被自动尝试（否则会白白扣掉它的尝试次数）。
let autoUnlockBusy = false;
// 解锁失败（令牌不对/数据被改坏）后的冷却时间：锁定页每 400ms 轮询一次，
// 失败还继续重试会反复解密校验并把日志刷满，等 10 秒再试。
let autoUnlockRetryAt = 0;
let pendingEnter = false; // 密钥已解包、等待用户点「确定」

function notifyLock(channel, payload) {
  if (!lockWindow || lockWindow.isDestroyed()) return;
  const wc = lockWindow.webContents;
  if (wc.isLoading()) {
    wc.once('did-finish-load', () => {
      if (lockWindow && !lockWindow.isDestroyed()) wc.send(channel, payload);
    });
    return;
  }
  wc.send(channel, payload);
}

async function readKeyOnly(reason) {
  if (autoUnlockBusy || Date.now() < autoUnlockRetryAt) return false;
  const token = vault.autoUnlockToken();
  if (!token) return false;
  autoUnlockBusy = true;
  try {
    await vault.unlock({ pin: '', tokenPath: token.path });
    autoUnlockRetryAt = 0;
    pendingEnter = true;
    console.log(`[vault] 密钥已读取（${reason}），等待用户确认进入`);
    notifyLock('vault:ready', { serial: token.serial, path: token.path });
    return true;
  } catch (err) {
    autoUnlockRetryAt = Date.now() + 10_000;
    console.error(`[vault] 读取密钥失败（${reason}）：${err.message}`);
    notifyLock('vault:error', { message: err.message });
    return false;
  } finally {
    autoUnlockBusy = false;
  }
}

// 启用保护后抹掉明文库（含备份/留档）。
// 尽力而为：先覆写随机字节再删除。SSD 的磨损均衡可能留有物理残影，
// 真正在意这一点的场景应配合全盘加密（README 有说明）。
function wipePlaintextLibrary() {
  let names = [];
  try {
    // session.json 里是最近打开的标签页（同样是隐私数据），启用加密后不能留明文
    names = fs.readdirSync(DATA_DIR).filter(
      (n) =>
        n === 'library.json' ||
        n.startsWith('library.json.') ||
        n === 'session.json' ||
        // 下载记录里也有 URL、文件名和本地路径，属于同一类隐私数据
        n === 'downloads.json' ||
        n === 'downloads.json.tmp'
    );
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(DATA_DIR, name);
    try {
      const size = fs.statSync(file).size;
      if (size > 0 && size <= 64 * 1024 * 1024) fs.writeFileSync(file, crypto.randomBytes(size));
      fs.rmSync(file, { force: true });
    } catch (err) {
      console.error(`[vault] 清理明文文件失败 ${name}: ${err.message}`);
    }
  }
  // 重置时的自动备份目录里也可能是明文库；启用加密后必须一并清掉
  try {
    for (const name of fs.readdirSync(DATA_DIR)) {
      if (!name.startsWith('reset-backup-')) continue;
      fs.rmSync(path.join(DATA_DIR, name), { recursive: true, force: true });
      console.log(`[vault] 已清理明文重置备份目录 ${name}`);
    }
  } catch (err) {
    console.error(`[vault] 清理重置备份目录失败：${err.message}`);
  }
}

// 拔盾 / 空闲 / 休眠 / 锁屏 → 自动锁定；锁定态下插入免 PIN 令牌 → 读取密钥等待确认
function startVaultWatchers() {
  setInterval(() => {
    if (!vault.isEnabled()) return;
    if (vault.isLocked()) {
      // 恢复流程（已拿恢复码、等绑定新令牌）不自动读密钥，但同样受空闲锁约束：
      // 恢复态里 DEK 在内存，不能因为"已经是锁定状态"就不清。
      if (vault.state === 'recovery') {
        if (isIdleLock(powerMonitor.getSystemIdleTime(), IDLE_MINUTES)) {
          doLock('恢复流程空闲超时');
        }
        return;
      }
      readKeyOnly('检测到令牌插入');
      return;
    }
    // 密钥已读、人还没点「确定」：这期间拔盾要立刻退回锁定态
    if (pendingEnter) {
      if (!vault.boundTokenPresent()) {
        vault.lock();
        pendingEnter = false;
        notifyLock('vault:reset', { reason: '令牌已移除' });
      }
      return;
    }
    if (!mainWindow) return;
    if (!vault.boundTokenPresent()) {
      doLock('令牌已移除');
      return;
    }
    if (isIdleLock(powerMonitor.getSystemIdleTime(), IDLE_MINUTES)) {
      doLock(`空闲超过 ${IDLE_MINUTES} 分钟`);
    }
  }, 500);
  powerMonitor.on('suspend', () => doLock('系统休眠'));
  powerMonitor.on('lock-screen', () => doLock('系统锁屏'));
}

// ---------- 保险库：IPC ----------

function registerVaultIpc() {
  handleVault('vault:status', () => ({
    ...vault.status(),
    ...vault.boundTokenStatus(),
    idleMinutes: IDLE_MINUTES,
    ready: pendingEnter,
  }));
  handleVault('vault:detect', (payload = {}) => tokenProvider.discover({ fresh: payload.fresh === true }));
  handleVault('vault:tokens', () => vault.tokenList());
  handleVault('vault:add-token', async ({ tokenPath, pin } = {}) => {
    const result = await vault.addToken({ tokenPath, pin });
    setupMenu(); // 令牌数变了，系统菜单里的"令牌管理（N 枚）"要重建
    return result;
  }, { from: 'main' });
  handleVault('vault:remove-token', ({ serial } = {}) => {
    const result = vault.removeToken(serial);
    setupMenu();
    return result;
  }, { from: 'main' });

  handleVault('vault:pick-dir', async (_payload, origin) => {
    const parent = origin === 'main' ? mainWindow : lockWindow;
    const { canceled, filePaths } = await dialog.showOpenDialog(parent, {
      title: '选择令牌存放位置（建议 U 盘根目录）',
      properties: ['openDirectory', 'createDirectory'],
    });
    return { canceled, dir: filePaths && filePaths[0] };
  });

  // 独立建令牌 IPC 已移除：建令牌只走 enroll / rebind，避免出现"建了但没绑定"的孤儿令牌。

  // 启用保护（仅主窗口、尚未启用时）：绑定令牌 → 加密迁移 → 抹掉明文
  handleVault('vault:enroll', async ({ tokenPath, createDir, pin, pinFree, force }) => {
    if (vault.isEnabled()) throw new Error('U盾保护已经启用');
    if (!store) throw new Error('数据层未就绪');
    const free = pinFree === true;
    let usedPath = tokenPath;
    if (createDir) {
      usedPath = (await softToken.createToken(createDir, pin, {
        pinFree: free,
        force: force === true,
      })).path;
    }
    if (!usedPath) throw new Error('请先选择或创建一枚令牌');
    const result = await vault.enroll({ tokenPath: usedPath, pin: free ? '' : pin, library: store.data });
    // 会话（最近打开的标签页）也要跟着迁移：先读明文，再以上面的 DEK 写成 session.enc，
    // 最后 wipe 掉 session.json。之前只迁了 library，明文会话会一直留到下次切标签。
    const pendingSession = sessionStore ? sessionStore.loadPlain() : null;
    if (pendingSession) sessionStore.save(pendingSession);
    wipePlaintextLibrary();
    openStore(); // 切换到 library.enc（load 会再校验一次密文）
    // 启用后系统菜单要立刻从"启用 U盾保护…"变成"锁定 / 令牌管理 / 停用"，
    // 之前只有停用才重建菜单，启用后菜单会一直停在旧状态。
    setupMenu();
    // 渲染层的恢复码弹窗要显示令牌文件名（stepRecovery 读 result.tokenPath），
    // vault.enroll 本身不返回路径，这里补上
    return { ...result, tokenPath: usedPath };
  }, { from: 'main' });

  handleVault('vault:lock', () => {
    doLock('手动锁定');
    return true;
  }, { from: 'main' });

  // 重置：清空文档库 + 保护配置，可选删除 U 盘令牌，然后重启应用。
  // 需要已解锁（锁定态连数据都读不到，谈重置没有意义），且必须输入确认文字。
  handleVault('vault:reset-targets', () => ({
    files: listTargets(DATA_DIR),
    tokenPath: vault.tokenPath(),
    dataDir: DATA_DIR,
  }), { from: 'main' });

  handleVault('vault:reset', ({ confirm, deleteToken } = {}) => {
    if (confirm !== '重置') throw new Error('请按提示输入「重置」两个字');
    if (vault.isEnabled() && vault.isLocked()) throw new Error('请先解锁后再重置');
    for (const entry of downloads.snapshot()) {
      if (entry.state === 'progressing') downloads.cancel(entry.id);
    }
    const result = resetDataDir(DATA_DIR, {
      deleteToken: deleteToken === true,
      tokenPath: vault.tokenPath(),
      expectedSerial: vault.tokenSerial(),
    });
    if (result.failed.length) {
      // 有文件删不掉（被占用、只读盘等）就不要重启：之前只打日志仍然 relaunch，
      // 界面显示的是"正在清空并重启"，实际数据只删了一半。
      console.error('[reset] 部分文件删除失败：', result.failed);
      throw new Error(
        `有 ${result.failed.length} 个文件删除失败，已取消重启：${result.failed.map((item) => item.name).join('、')}`
      );
    }
    // 内存里的明文/密钥已无意义，直接重启回到全新状态
    setTimeout(() => {
      // 先释放单实例锁再重启：旧进程还占着锁时新进程会直接退出，
      // 表现就是"点重置后应用消失了"。
      app.releaseSingleInstanceLock();
      app.relaunch();
      app.exit(0);
    }, 300);
    return result;
  }, { from: 'main' });

  // 停用保护：PIN 校验 → 先原子写明文 → 成功后才删密文与 vault.json。
  // 顺序不能反：之前先删密文再写 library.json，写失败（磁盘满/只读）时
  // 数据只剩内存一份，退出即丢。现在任何一步失败密文都还在，可重试。
  handleVault('vault:disable', async ({ pin, deleteToken } = {}) => {
    // 停用前先记下"本机正在用的那枚令牌"——停用后 vault.json 就没了，不能再查
    const tokenInfo = vault.boundTokenInfo();
    // 停用前先把加密会话读出来（解锁态才读得到），停用后以明文写回
    const pendingSession = sessionStore ? sessionStore.load() : null;
    const plain = await vault.disable({
      pin,
      persist: async (library) => {
        const file = path.join(DATA_DIR, 'library.json');
        const tmp = `${file}.tmp`;
        await fs.promises.writeFile(tmp, `${JSON.stringify(library, null, 2)}\n`, {
          encoding: 'utf-8',
          mode: 0o600,
        });
        // 与 Store.save 同样的约定：替换前给已有文件留一份备份
        if (fs.existsSync(file)) await fs.promises.copyFile(file, `${file}.bak`);
        await fs.promises.rename(tmp, file);
        try {
          await fs.promises.chmod(file, 0o600); // 已存在的旧文件 mode 不会变，兜底纠正
        } catch {
          /* 权限纠正失败可忽略 */
        }
      },
    });
    setupMenu();
    if (sessionStore) {
      if (pendingSession) sessionStore.save(pendingSession); // 现在未启用保护 → 写 session.json 并删 session.enc
      else sessionStore.clear();
    }
    try {
      for (const name of fs.readdirSync(DATA_DIR)) {
        if (name.startsWith('library.enc.corrupt-')) fs.rmSync(path.join(DATA_DIR, name), { force: true });
      }
    } catch { /* 忽略 */ }
    openStore();
    // 停用后令牌已经解不开任何东西：默认把它删掉，避免 U 盘上留一个没用的密钥文件。
    // 只删"本机用的这枚"（其他系统的令牌不动）；删除失败不影响停用结果。
    let tokenRemoved = false;
    let tokenWarning = null;
    if (deleteToken !== false && tokenInfo) {
      const removal = removeTokenFile(tokenInfo);
      tokenRemoved = removal.removed;
      if (removal.error) {
        tokenWarning = removal.error;
        console.warn(`[vault] 删除令牌失败：${removal.error}`);
      }
    }
    return { docs: plain.docs.length, tokenRemoved, tokenWarning };
  }, { from: 'main' });

  // ---- 锁定窗口专用 ----

  handleVault('vault:unlock', async ({ pin, tokenPath }) => {
    const result = await vault.unlock({ pin, tokenPath });
    // 先把应答送回渲染层，再销毁锁定窗口
    setImmediate(() => bootUnlocked());
    return result;
  }, { from: 'lock' });

  handleVault('vault:recover', async ({ code }) => vault.unlockWithRecovery(code), { from: 'lock' });

  handleVault('vault:rebind', async ({ tokenPath, createDir, pin, pinFree, force }) => {
    const free = pinFree === true;
    let usedPath = tokenPath;
    if (createDir) {
      usedPath = (await softToken.createToken(createDir, pin, {
        pinFree: free,
        force: force === true,
      })).path;
    }
    if (!usedPath) throw new Error('请先选择或创建一枚令牌');
    return vault.rebind({ tokenPath: usedPath, pin: free ? '' : pin });
  }, { from: 'lock' });

  handleVault('vault:finish', () => {
    // 允许进入的两种情况：免 PIN 令牌已读密钥等待确认，或恢复码流程已完成换绑。
    if (vault.isLocked()) throw new Error('尚未完成解锁');
    // 读密钥到点「确定」之间可能把 U 盘拔了：进入前再确认一次，别让空窗期进库
    if (vault.isEnabled() && !vault.boundTokenPresent()) {
      vault.lock();
      pendingEnter = false;
      throw new Error('令牌已移除，请重新插入后再进入');
    }
    setImmediate(() => bootUnlocked());
    return true;
  }, { from: 'lock' });
}

// ---------- 会话级加固（权限 / 下载） ----------

// 注：之前收一个 getWindow 参数但从未使用，已移除
function hardenSession() {
  const ses = session.defaultSession;

  // 权限：默认拒绝，只放行白名单里的两项。
  // 注意 Electron 的默认行为是"没有 handler 就批准所有权限请求"，
  // 文档页因此可能不弹任何提示就拿到摄像头/麦克风/定位/USB 等能力。
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ALLOWED_PERMISSIONS.has(permission);
    if (!allowed) {
      const from = webContents && webContents.getURL ? webContents.getURL() : '(unknown)';
      console.warn(`[security] 已拒绝权限请求: ${permission} ← ${from}`);
    }
    callback(allowed);
  });
  ses.setPermissionCheckHandler((_webContents, permission) => ALLOWED_PERMISSIONS.has(permission));

  // 下载：网页发起的下载直接存到下载目录，并在界面上出现一条可追踪的记录。
  // 不用弹窗确认（点了没反应、页面循环触发还能刷屏），改由 Downloads 做并发与频率限制。
  ses.on('will-download', (event, item, webContents) => {
    const from = webContents && webContents.getURL ? webContents.getURL() : '';

    // 外壳自身不应该产生下载，直接丢弃
    if (isShellUrl(from)) {
      item.cancel();
      return;
    }
    downloads.register(item, webContents);
  });
}

// ---------- 菜单 ----------

// 菜单动作统一转给渲染层处理（对话框都在渲染层）；锁定直接在主进程做。
function sendMenuAction(id) {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (win) win.webContents.send('menu-action', id);
}

// macOS 的复制/粘贴/退出依赖菜单 role；三端都用原生菜单，
// 这样「文件 / U盾 / 帮助」和「视图」并排出现在系统菜单栏里，符合常规软件的位置。
// 注意：状态变化（启用/停用 U盾）后要重新调用本函数重建菜单。
function setupMenu() {
  const isMac = process.platform === 'darwin';
  let vaultEnabled = false;
  let tokenCount = 0;
  try {
    const status = vault.status();
    vaultEnabled = status.enabled === true;
    tokenCount = status.tokenCount || 0;
  } catch {
    /* 元数据异常时按未启用处理 */
  }

  const template = [
    ...(isMac
      ? [
          {
            label: '文档库',
            submenu: [
              { label: '关于文档库', role: 'about' },
              { type: 'separator' },
              { label: '服务', role: 'services' },
              { type: 'separator' },
              { label: '隐藏文档库', role: 'hide' },
              { label: '隐藏其他', role: 'hideOthers' },
              { label: '显示全部', role: 'unhide' },
              { type: 'separator' },
              { label: '退出文档库', role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: '文件',
      submenu: [
        {
          label: '打开数据文件位置',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => sendMenuAction('reveal-data'),
        },
        { label: '导出…', click: () => sendMenuAction('export-encrypted') },
        { label: '导入…', click: () => sendMenuAction('import-encrypted') },
        { type: 'separator' },
        { label: '重置…', click: () => sendMenuAction('reset') },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit', label: '退出' }]),
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'delete', label: '删除' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        // 与 bindDevtools 保持同一门槛：打包版默认不给开发者工具入口。
        // 只藏快捷键不藏菜单等于没关——role 仍然会打开外壳页面的调试器，
        // 而调试器里可以直接调用 window.api 读写整个文档库。
        ...(app.isPackaged && process.env.DOCVAULT_DEVTOOLS !== '1'
          ? []
          : [{ role: 'toggleDevTools', label: '开发者工具' }, { type: 'separator' }]),
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: 'U盾',
      submenu: vaultEnabled
        ? [
            {
              label: '锁定',
              accelerator: 'CmdOrCtrl+Shift+L',
              click: () => doLock('菜单：立即锁定'),
            },
            {
              label: tokenCount > 1 ? `令牌管理（${tokenCount} 枚）…` : '令牌管理…',
              click: () => sendMenuAction('vault-tokens'),
            },
            { type: 'separator' },
            { label: '停用 U盾保护…', click: () => sendMenuAction('vault-disable') },
          ]
        : [{ label: '启用 U盾保护…', click: () => sendMenuAction('vault-enroll') }],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        ...(isMac
          ? [
              { type: 'separator' },
              { role: 'front', label: '前置全部窗口' },
            ]
          : [{ role: 'close', label: '关闭窗口' }]),
      ],
    },
    {
      role: 'help',
      label: '帮助',
      submenu: [
        { label: '关于文档库…', click: () => sendMenuAction('about') },
        { label: '打开数据文件位置', click: () => sendMenuAction('reveal-data') },
      ],
    },
  ];

  const built = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(built);
  if (process.env.DOCVAULT_MENU_DUMP === '1') {
    const dump = (items, depth) =>
      items
        .map((item) => {
          const lines = [`${'  '.repeat(depth)}- ${item.label || item.role || item.type}${item.accelerator ? ` (${item.accelerator})` : ''}`];
          if (item.submenu) lines.push(dump(item.submenu.items, depth + 1));
          return lines.join('\n');
        })
        .join('\n');
    console.log(`[menu]\n${dump(Menu.getApplicationMenu().items, 0)}`);
  }
}

// ---------- 生命周期 ----------

// 开发模式下应用名默认取 package.json 的 name（doc-vault），菜单里显示成英文；
// 统一成与打包版一致的「文档库」
app.setName('文档库');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    setupMenu();
    registerIpc();
    registerVaultIpc();
    registerSessionIpc();

    // 未打包时 macOS 的 Dock 图标取自 Electron 本体，这里换成应用图标
    if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
      try {
        app.dock.setIcon(DEV_ICON);
      } catch (err) {
        console.error(`[icon] 设置 Dock 图标失败: ${err.message}`);
      }
    }

    // 干净 UA + 会话加固（权限默认拒绝、下载接管）
    session.defaultSession.setUserAgent(buildCleanUA(session.defaultSession.getUserAgent()));
    hardenSession();

    // lock-first：启用了 U盾保护就先开锁定窗口，数据层完全不加载；
    // 没有启用则保持旧行为，直接进文档库。
    if (vault.isEnabled()) {
      // 先开锁定页（插着免 PIN 令牌时它负责播放读取动画）；密钥读取在后台进行，
      // 读完后由用户点「确定」再进入，不再自动跳转。
      lockWindow = createLockWindow();
      if (vault.autoUnlockToken()) readKeyOnly('启动时检测到免 PIN 令牌');
    } else {
      bootUnlocked();
    }
    startVaultWatchers();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length > 0) return;
      // pendingEnter = 密钥已解包但用户还没点「确定」：也要回到锁定页，
      // 不能因为"已经解锁"就直接进主界面，否则关掉锁定窗口再点 Dock 就绕过了确认。
      if (vault.isEnabled() && (vault.isLocked() || pendingEnter)) {
        lockWindow = createLockWindow();
        if (vault.state !== 'recovery' && vault.autoUnlockToken()) {
          readKeyOnly('窗口重新打开时检测到令牌');
        }
      } else if (store) {
        mainWindow = createMainWindow(); // macOS 关窗后再点 Dock：会话仍解锁
      } else {
        bootUnlocked();
      }
    });
  }).catch((err) => {
    // 启动阶段还没有窗口承接错误（例如数据目录不可写、首次建库失败）。
    // 不处理的话就是一个 unhandled rejection：用户看到的是"双击没反应"。
    console.error(`[startup] ${err && err.stack ? err.stack : err}`);
    try {
      dialog.showErrorBox('文档库启动失败', String((err && err.message) || err));
    } catch {
      /* 无图形环境时忽略 */
    }
    app.quit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // 退出流程里不要因为窗口关闭再触发"锁定→新建锁定窗口"，否则应用退不掉
  app.on('before-quit', () => {
    app.isQuitting = true;
  });
}