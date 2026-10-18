// 预加载脚本：在渲染进程和主进程之间安全地桥接
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 渲染进程通过 window.api.getPages() 获取页面清单
  getPages: () => ipcRenderer.invoke('get-pages'),
  // 主进程通知：有网页要开新窗口（window.open / target=_blank），
  // 改为在应用内新开一个标签，而不是弹新窗口。
  onOpenTab: (callback) => ipcRenderer.on('open-tab', (_event, url) => callback(url)),
});