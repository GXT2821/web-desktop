// 会话（打开中的标签页）持久化：明文/加密两条路径 + 损坏容错
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSessionStore, normalize } = require('../src/session');
const core = require('../src/store-core');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'docvault-session-test-'));
}

// 假保险库：用 store-core 的加密能力模拟 DEK 在/不在内存
function fakeVault() {
  const dek = Buffer.alloc(32, 7);
  let enabled = false;
  let locked = false;
  return {
    setEnabled(v) { enabled = v; },
    setLocked(v) { locked = v; },
    deps: {
      isVaultEnabled: () => enabled,
      isVaultLocked: () => locked,
      codec: () => ({
        encode: (buf) => core.SealDemo ? buf : buf, // 占位，下面用真实实现覆盖
        decode: (buf) => buf,
      }),
    },
  };
}

test('normalize：过滤无 url 的条目、限制字段长度与数量', () => {
  assert.equal(normalize(null), null);
  const out = normalize({
    tabs: [
      { url: 'https://a.example/1', title: 'A', docId: null },
      { url: '', title: '空' },
      { url: 'https://b.example/2', title: 'x'.repeat(500) },
    ],
    activeIndex: -1,
  });
  assert.equal(out.tabs.length, 2);
  assert.equal(out.activeIndex, -1);
  assert.equal(out.tabs[1].title.length, 200);
});

test('未启用 U盾：明文件读写，切换后能读回', () => {
  const dir = tmpDir();
  const store = createSessionStore({
    dataDir: dir,
    isVaultEnabled: () => false,
    isVaultLocked: () => false,
    codec: () => { throw new Error('不该调用'); },
  });
  assert.equal(store.load(), null);
  assert.equal(store.save({ tabs: [{ url: 'https://a.example/1', title: 'A' }], activeIndex: 0 }), true);
  assert.ok(fs.existsSync(path.join(dir, 'session.json')));
  const reloaded = createSessionStore({
    dataDir: dir,
    isVaultEnabled: () => false,
    isVaultLocked: () => false,
    codec: () => { throw new Error('不该调用'); },
  }).load();
  assert.equal(reloaded.tabs[0].url, 'https://a.example/1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('启用 U盾：写加密文件、不留明文；锁定时读不到，解锁后能读', () => {
  const dir = tmpDir();
  const key = Buffer.alloc(32, 9);
  const codec = {
    encode: (buf) => {
      const iv = Buffer.alloc(12, 1);
      const cipher = require('node:crypto').createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(buf), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decode: (buf) => {
      const decipher = require('node:crypto').createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
    },
  };
  let locked = false;
  const store = createSessionStore({
    dataDir: dir,
    isVaultEnabled: () => true,
    isVaultLocked: () => locked,
    codec: () => codec,
  });
  assert.equal(store.save({ tabs: [{ url: 'https://secret.example/doc', title: '机密' }], activeIndex: 0 }), true);
  assert.ok(fs.existsSync(path.join(dir, 'session.enc')), '应写加密文件');
  assert.equal(fs.existsSync(path.join(dir, 'session.json')), false, '不能留明文');
  // 密文里不应出现明文链接
  assert.equal(fs.readFileSync(path.join(dir, 'session.enc'), 'utf-8').includes('secret.example'), false);

  locked = true;
  assert.equal(store.load(), null, '锁定时读不到');
  locked = false;
  assert.equal(store.load().tabs[0].url, 'https://secret.example/doc');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('损坏的会话文件：当作没有会话，不抛错', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'session.json'), '{ not json');
  const store = createSessionStore({
    dataDir: dir,
    isVaultEnabled: () => false,
    isVaultLocked: () => false,
    codec: () => { throw new Error('不该调用'); },
  });
  assert.equal(store.load(), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('clear：两种文件都删掉', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'session.json'), '{}');
  fs.writeFileSync(path.join(dir, 'session.enc'), 'x');
  createSessionStore({
    dataDir: dir,
    isVaultEnabled: () => false,
    isVaultLocked: () => false,
    codec: () => { throw new Error('不该调用'); },
  }).clear();
  assert.equal(fs.existsSync(path.join(dir, 'session.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'session.enc')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
