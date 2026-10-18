// 预加载脚本：在渲染进程和主进程之间安全地桥接
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 渲染进程通过 window.api.getPages() 获取页面清单
  getPages: () => ipcRenderer.invoke('get-pages'),
});