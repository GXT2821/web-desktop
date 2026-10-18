// Electron 主进程：负责创建窗口、读取页面配置
const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// 读取 config.json 里的页面清单
function loadPages() {
  const configPath = path.join(__dirname, 'config.json');
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return raw.pages.map((p) => {
    if (p.type === 'local') {
      // 把相对路径转成浏览器能识别的 file:// 绝对地址
      return {
        name: p.name,
        type: 'local',
        url: pathToFileURL(path.join(__dirname, p.file)).href,
      };
    }
    // 远程网址原样返回
    return { name: p.name, type: 'remote', url: p.url };
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: '我的桌面应用',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,        // 允许使用 <webview> 加载页面
      contextIsolation: true,  // 安全隔离
      nodeIntegration: false,  // 渲染进程不直接暴露 Node
    },
  });

  win.loadFile(path.join(__dirname, 'src', 'shell.html'));
}

// 渲染进程通过这个接口拿页面清单
ipcMain.handle('get-pages', () => loadPages());

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // 移除顶部 File/Edit/View/Window/Help 菜单
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 关闭所有窗口时退出（macOS 除外，按平台惯例处理）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});