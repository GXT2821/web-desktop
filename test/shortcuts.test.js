import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldForwardFromGuest } = require('../src/shortcuts.js');

const mac = (key, extra = {}) => ({ meta: true, control: false, shift: false, alt: false, key, ...extra });

test('网页里 Cmd/Ctrl+F 留给网页自己（在线文档的页内查找）', () => {
  assert.equal(shouldForwardFromGuest(mac('f'), true), false);
  assert.equal(shouldForwardFromGuest({ ...mac('f'), meta: false, control: true }, false), false);
  assert.equal(shouldForwardFromGuest(mac('F'), true), false);
});

test('网页里标签类快捷键仍然转发给应用', () => {
  for (const key of ['w', 'r', 'n', '1', '9']) {
    assert.equal(shouldForwardFromGuest(mac(key), true), true, `${key} 应该转发`);
  }
});

test('带 Shift/Alt 或没有命令键的组合不转发', () => {
  assert.equal(shouldForwardFromGuest(mac('f', { shift: true }), true), false);
  assert.equal(shouldForwardFromGuest(mac('w', { alt: true }), true), false);
  assert.equal(shouldForwardFromGuest({ meta: false, control: false, key: 'w' }, true), false);
  // Windows/Linux 上 Ctrl 才算命令键，单独的 Meta（Win 键）不算
  assert.equal(shouldForwardFromGuest({ meta: true, control: false, key: 'w' }, false), false);
});

test('真实接线：网页里按 Cmd+F 既不被拦、也不转发给应用', async () => {
  const { EventEmitter } = await import('node:events');
  const { bindGuestShortcuts } = require('../src/shortcuts.js');

  const guest = new EventEmitter();
  const sent = [];
  const win = { webContents: { send: (channel, payload) => sent.push({ channel, payload }) } };
  bindGuestShortcuts(win, guest, { isMac: true });

  let prevented = 0;
  guest.emit('before-input-event', { preventDefault: () => (prevented += 1) }, { type: 'keyDown', key: 'f', meta: true });
  assert.equal(prevented, 0, '不能 preventDefault，否则网页收不到 Cmd+F');
  assert.deepEqual(sent, [], '不能把 f 转发成文档库搜索');

  // 对照：Cmd+W 仍然关标签
  guest.emit('before-input-event', { preventDefault: () => (prevented += 1) }, { type: 'keyDown', key: 'w', meta: true });
  assert.equal(prevented, 1);
  assert.deepEqual(sent, [{ channel: 'shortcut', payload: { key: 'w' } }]);

  // keyUp 不重复触发
  guest.emit('before-input-event', { preventDefault: () => (prevented += 1) }, { type: 'keyUp', key: 'w', meta: true });
  assert.equal(prevented, 1);
});
