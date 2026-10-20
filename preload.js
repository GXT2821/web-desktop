// 预加载脚本：渲染进程与主进程之间唯一的通道
//
// 只暴露「文档库」需要的具体方法，不透传 ipcRenderer，避免渲染层拿到任意 IPC 能力。
// 主进程统一返回 { ok, data } / { ok, error }，这里拆包成正常返回值与中文异常。

const { contextBridge, ipcRenderer } = require('electron');

const call = async (channel, payload) => {
  const res = await ipcRenderer.invoke(channel, payload);
  if (!res || res.ok !== true) throw new Error((res && res.error) || '操作失败');
  return res.data;
};

contextBridge.exposeInMainWorld('api', {
  // 数据读写（每次变更都返回整库快照，渲染层据此整体刷新）
  getLibrary: () => call('library:get'),
  getInfo: () => call('library:info'),
  addDoc: (input) => call('doc:add', input),
  updateDoc: (id, patch) => call('doc:update', { id, patch }),
  deleteDoc: (id) => call('doc:delete', { id }),
  touchDoc: (id) => call('doc:touch', { id }),
  autoTitle: (id, title) => call('doc:auto-title', { id, title }),

  // 文件夹
  addFolder: (name, parentId) => call('folder:add', { name, parentId }),
  renameFolder: (id, name) => call('folder:rename', { id, name }),
  deleteFolder: (id, mode) => call('folder:delete', { id, mode }),

  // 系统能力
  openExternal: (url) => call('shell:open-external', { url }),
  copyText: (text) => call('clipboard:write', { text }),
  revealDataFile: () => call('store:reveal'),

  // 主进程通知：网页里的 window.open 已被拦截，改为应用内新标签
  onOpenTab: (callback) => {
    ipcRenderer.on('open-tab', (_event, payload) => callback(payload && payload.url));
  },
  // 主进程转发：焦点在网页里时按下的应用级快捷键
  onShortcut: (callback) => {
    ipcRenderer.on('shortcut', (_event, payload) => callback(payload && payload.key));
  },
});