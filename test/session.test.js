/**
 * 会话持久化：明文/密文两种形态的互斥与迁移。
 * 用假 codec 代替保险库，测试不依赖 Electron / 真实加密。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSessionStore, normalize } = require('../src/session');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'docvault-session-test-'));
}

// 前缀 + base64 的假加密：足够验证"明文/密文形态互斥"，不代表真实强度
const codec = () => ({
  encode: (buf) => Buffer.from(`ENC:${buf.toString('base64')}`, 'utf-8'),
  decode: (buf) => Buffer.from(buf.toString('utf-8').slice(4), 'base64'),
});

function makeStore(dir) {
  const state = { enabled: false, locked: false };
  const store = createSessionStore({
    dataDir: dir,
    isVaultEnabled: () => state.enabled,
    isVaultLocked: () => state.locked,
    codec,
  });
  return { store, state, plain: path.join(dir, 'session.json'), enc: path.join(dir, 'session.enc') };
}

const SAMPLE = normalize({ tabs: [{ url: 'https://example.com/a', title: 'A' }], activeIndex: 0 });

test('会话：未启用保护时写明文，启用后写密文并删掉明文', () => {
  const dir = tmpDir();
  const { store, state, plain, enc } = makeStore(dir);

  assert.equal(store.save(SAMPLE), true);
  assert.ok(fs.existsSync(plain));
  assert.equal(fs.existsSync(enc), false);
  assert.deepEqual(store.load(), SAMPLE);

  // 启用保护：先读明文，再以加密形态写回
  const pending = store.loadPlain();
  state.enabled = true;
  assert.equal(store.save(pending), true);
  assert.equal(fs.existsSync(plain), false, '启用后不能留明文');
  assert.ok(fs.existsSync(enc));
  assert.deepEqual(store.load(), SAMPLE);
});

test('会话：锁定态读不到、也写不了加密会话', () => {
  const dir = tmpDir();
  const { store, state } = makeStore(dir);
  state.enabled = true;
  store.save(SAMPLE);
  state.locked = true;
  assert.equal(store.load(), null);
  assert.equal(store.save(SAMPLE), false);
});

test('会话：停用保护后回到明文形态', () => {
  const dir = tmpDir();
  const { store, state, plain, enc } = makeStore(dir);
  state.enabled = true;
  store.save(SAMPLE);
  assert.ok(fs.existsSync(enc));

  const pending = store.load();
  state.enabled = false;
  store.save(pending);
  assert.ok(fs.existsSync(plain));
  assert.equal(fs.existsSync(enc), false, '停用后不能留密文文件');
});

test('会话：损坏内容当作没有会话', () => {
  const dir = tmpDir();
  const { store, plain } = makeStore(dir);
  fs.writeFileSync(plain, '{not json');
  assert.equal(store.load(), null);
});