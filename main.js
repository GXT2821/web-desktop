// 主进程：窗口、数据持久化、webview 策略与安全边界
//
// 定位：一个「在线文档收藏夹」。链接与元数据存在 userData/library.json，
// 点开文档在应用内用 <webview> 打开（登录态由 Electron 的持久化 session 保留）。

const { app, BrowserWindow, Menu, ipcMain, shell, clipboard, session, screen, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { Store } = require('./src/store');
const { Downloads } = require('./src/downloads');

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

const store = new Store(path.join(DATA_DIR, 'library.json'));

// 给所有窗口广播（下载进度、完成、失败）
function broadcastToWindows(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

// 下载记录与管理（不含流式内容，只记元数据）
const downloads = new Downloads({
  dataDir: DATA_DIR,
  getWindow: () => BrowserWindow.getAllWindows()[0] || null,
  broadcast: broadcastToWindows,
});
const WINDOW_STATE_FILE = path.join(DATA_DIR, 'window-state.json');
// 开发期窗口/Dock 图标；打包后由 .app 的 icns、exe 内嵌图标接管（build/ 不随包分发）
const DEV_ICON = path.join(__dirname, 'build', 'icon.png');

// 外壳页面路径：外壳窗口只允许停在这个文件上（见 isShellUrl）
const SHELL_FILE = path.join(__dirname, 'src', 'shell.html');

// 是否为外壳自身的地址（容忍 file:// 的百分号编码差异与 #hash）
function isShellUrl(raw) {
  try {
    const url = new URL(String(raw));
    return url.protocol === 'file:' && decodeURIComponent(url.pathname) === SHELL_FILE;
  } catch {
    return false;
  }
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

// 焦点在 webview 里时，快捷键会被 guest 吃掉；这里拦下应用级快捷键转发给渲染进程
function bindGuestShortcuts(win, guest) {
  guest.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    if (!mod || input.shift || input.alt) return;
    const key = String(input.key || '').toLowerCase();
    if (!/^([1-9]|w|n|f|r)$/.test(key)) return;
    event.preventDefault();
    win.webContents.send('shortcut', { key });
  });
}

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

function createWindow() {
  const win = new BrowserWindow({
    ...readWindowState(),
    minWidth: 960,
    minHeight: 620,
    title: '文档库',
    backgroundColor: '#f6f7f9',
    show: false,
    // 打包后图标由 .app / exe 提供；开发期才需要显式指定（未打包时传 undefined 会产生 nativeImage 警告）
    ...(app.isPackaged ? {} : { icon: DEV_ICON }),
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

  win.loadFile(path.join(__dirname, 'src', 'shell.html'));
  return win;
}

// ---------- IPC ----------

// 统一包一层：渲染进程拿到的是干净的数据或可直接展示的中文错误信息
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return { ok: true, data: await fn(payload) };
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

  // ---------- 下载 ----------
  handle('downloads:list', () => downloads.snapshot());
  handle('downloads:cancel', ({ id } = {}) => downloads.cancel(id));
  handle('downloads:reveal', ({ id } = {}) => downloads.reveal(id));
  handle('downloads:open', ({ id } = {}) => downloads.open(id));
  handle('downloads:clear', () => downloads.clearFinished());

}

// ---------- 会话级加固（权限 / 下载） ----------

function hardenSession(getWindow) {
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

// macOS 的复制/粘贴/退出依赖菜单 role，直接清空菜单会让 Cmd+C/V/Q 失效；
// 因此 mac 上保留最小菜单（应用 + 编辑 + 视图），其他平台保持无菜单栏。
function setupMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: '视图',
        submenu: [
          { role: 'toggleDevTools', label: '开发者工具' },
          { type: 'separator' },
          { role: 'resetZoom', label: '实际大小' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
        ],
      },
    ])
  );
}

// ---------- 生命周期 ----------

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

    // 未打包时 macOS 的 Dock 图标取自 Electron 本体，这里换成应用图标
    if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
      try {
        app.dock.setIcon(DEV_ICON);
      } catch (err) {
        console.error(`[icon] 设置 Dock 图标失败: ${err.message}`);
      }
    }

    const result = store.load();
    // 只有 http(s) 的请求才带干净 UA，确保首次加载就被站点接受
    session.defaultSession.setUserAgent(buildCleanUA(session.defaultSession.getUserAgent()));
    // 权限默认拒绝 + 下载需确认（窗口是懒取的，此时还没创建也没关系）
    hardenSession(() => BrowserWindow.getAllWindows()[0] || null);

    const win = createWindow();

    if (result.recovered !== 'none') {
      const message = result.recovered === 'backup'
        ? '数据文件读取失败，已从备份 library.json.bak 恢复。建议检查该文件是否被外部程序改坏。'
        : '数据文件无法读取，已重建为空库；原文件已改名留档在同一目录，不会被覆盖。';
      dialog.showMessageBox(win, { type: 'warning', title: '数据恢复提示', message });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}