// 锁定页专用 preload：只暴露保险库相关方法。
// 锁定状态下渲染层拿不到任何文档库 IPC（window.api 不存在），
// 主进程侧还有第二道门禁（校验 sender + 锁定状态）。

const { contextBridge, ipcRenderer } = require('electron');

const call = async (channel, payload) => {
  const res = await ipcRenderer.invoke(channel, payload);
  if (!res || res.ok !== true) throw new Error((res && res.error) || '操作失败');
  return res.data;
};

contextBridge.exposeInMainWorld('lockApi', {
  status: () => call('vault:status'),
  detect: () => call('vault:detect'),
  unlock: (pin, tokenPath) => call('vault:unlock', { pin, tokenPath }),
  recover: (code) => call('vault:recover', { code }),
  rebind: (payload) => call('vault:rebind', payload),
  finish: () => call('vault:finish'),
  createToken: (dir, pin) => call('vault:create-token', { dir, pin }),
  pickDir: () => call('vault:pick-dir'),

  // 主进程推送：密钥已读取 / 令牌被拔走 / 读取失败
  onReady: (callback) => {
    ipcRenderer.on('vault:ready', (_event, payload) => callback(payload || {}));
  },
  onReset: (callback) => {
    ipcRenderer.on('vault:reset', (_event, payload) => callback(payload || {}));
  },
  onError: (callback) => {
    ipcRenderer.on('vault:error', (_event, payload) => callback(payload || {}));
  },
});
