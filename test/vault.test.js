/**
 * U盾保护（令牌 + 保险库）测试：不依赖 Electron。
 *
 * 覆盖：
 * - 软件令牌：创建、PIN 校验、HMAC 应答、错误扣次与自锁；
 * - 保险库：启用/解锁/锁定、密文不可读、换令牌拒绝、篡改检测；
 * - 恢复码：解锁 → 绑定新令牌 → 旧令牌失效；
 * - Store 集成：加密读写、备份、损坏恢复；
 * - 停用：明文还原。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const soft = require('../src/token/soft-token');
const provider = require('../src/token/provider');
const { Vault, normalizeRecoveryCode } = require('../src/vault');
const { Store, sanitizeLibrary } = require('../src/store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'docvault-vault-test-'));
}

const SAMPLE = sanitizeLibrary({
  folders: [{ id: 'f1', name: '工作', parentId: null }],
  docs: [
    {
      id: 'd1',
      title: '内部文档',
      url: 'https://example.com/secret-plan',
      folderId: 'f1',
      tags: ['机密'],
      note: '这是一段不该被明文看到的备注',
    },
  ],
});

// 每个用例独立的 数据目录 + 令牌目录；令牌目录挂进扫描环境变量
async function withEnv(fn) {
  const dataDir = tmpDir();
  const tokenDir = tmpDir();
  const prev = process.env.DOCVAULT_TOKEN_DIR;
  process.env.DOCVAULT_TOKEN_DIR = tokenDir;
  try {
    return await fn({ dataDir, tokenDir });
  } finally {
    if (prev === undefined) delete process.env.DOCVAULT_TOKEN_DIR;
    else process.env.DOCVAULT_TOKEN_DIR = prev;
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(tokenDir, { recursive: true, force: true });
  }
}

// ---------- 软件令牌 ----------

test('令牌：创建后元信息可读，PIN 正确才能打开会话', () =>
  withEnv(async ({ tokenDir }) => {
    const { path: file, serial } = await soft.createToken(tokenDir, '123456');
    assert.ok(fs.existsSync(file));
    const info = soft.readTokenInfo(file);
    assert.equal(info.serial, serial);
    assert.equal(info.attemptsLeft, soft.MAX_ATTEMPTS);
    assert.equal(info.locked, false);

    const session = await soft.openToken(file, '123456');
    const a = session.hmac(Buffer.alloc(32, 1));
    const b = session.hmac(Buffer.alloc(32, 1));
    const c = session.hmac(Buffer.alloc(32, 2));
    assert.equal(a.length, 32);
    assert.deepEqual(a, b, '同一 challenge 应答应一致');
    assert.notDeepEqual(a, c, '不同 challenge 应答应不同');
    session.close();
    assert.throws(() => session.hmac(Buffer.alloc(32)), /已关闭/);
  }));

test('令牌：PIN 错误扣减次数并写回文件，扣到 0 自锁', () =>
  withEnv(async ({ tokenDir }) => {
    const { path: file } = await soft.createToken(tokenDir, '123456');
    await assert.rejects(() => soft.openToken(file, '000000'), /还可尝试 7 次/);
    assert.equal(soft.readTokenInfo(file).attemptsLeft, 7);
    // 正确 PIN 会补满次数
    const ok = await soft.openToken(file, '123456');
    ok.close();
    assert.equal(soft.readTokenInfo(file).attemptsLeft, soft.MAX_ATTEMPTS);
    // 连续错到锁定
    for (let i = 0; i < soft.MAX_ATTEMPTS; i += 1) {
      await assert.rejects(() => soft.openToken(file, '000000'));
    }
    assert.equal(soft.readTokenInfo(file).locked, true);
    await assert.rejects(() => soft.openToken(file, '123456'), /已锁定/);
  }));

test('令牌：目标位置已有令牌时默认拒绝，force 覆盖后旧 PIN 失效', () =>
  withEnv(async ({ tokenDir }) => {
    const first = await soft.createToken(tokenDir, '123456');
    await assert.rejects(() => soft.createToken(tokenDir, 'abcdef'), /已经有一枚令牌/);

    const second = await soft.createToken(tokenDir, 'abcdef', { force: true });
    assert.notEqual(second.serial, first.serial, '覆盖后应是新令牌');
    // 旧 PIN 打不开新令牌，新 PIN 可以
    await assert.rejects(() => soft.openToken(second.path, '123456'), /PIN 不正确/);
    const session = await soft.openToken(second.path, 'abcdef');
    session.close();
  }));

test('令牌：force 覆盖同样适用于免 PIN 令牌', () =>
  withEnv(async ({ tokenDir }) => {
    const first = await soft.createToken(tokenDir, '', { pinFree: true });
    const second = await soft.createToken(tokenDir, '', { pinFree: true, force: true });
    assert.notEqual(second.serial, first.serial);
    const info = soft.readTokenInfo(second.path);
    assert.equal(info.pinFree, true);
    const a = await soft.openToken(first.path, '');
    a.close();
  }));

test('令牌：PIN 长度不合法直接拒绝', () =>
  withEnv(async ({ tokenDir }) => {
    await assert.rejects(() => soft.createToken(tokenDir, '123'), /4–16/);
    const { path: file } = await soft.createToken(tokenDir, '123456');
    await assert.rejects(() => soft.openToken(file, ''), /4–16/);
  }));

// ---------- 免 PIN 令牌（物理钥匙） ----------

test('免 PIN 令牌：创建后无需 PIN 即可打开，元信息标记 pinFree', () =>
  withEnv(async ({ tokenDir }) => {
    const { path: file, serial } = await soft.createToken(tokenDir, '', { pinFree: true });
    const info = soft.readTokenInfo(file);
    assert.equal(info.serial, serial);
    assert.equal(info.pinFree, true);
    assert.equal(info.locked, false);

    // 传空 PIN 也能打开（openToken 对免 PIN 令牌忽略 PIN）
    const session = await soft.openToken(file, '');
    const a = session.hmac(Buffer.alloc(32, 7));
    assert.equal(a.length, 32);
    session.close();
    assert.throws(() => session.hmac(Buffer.alloc(32)), /已关闭/);
  }));

test('免 PIN 令牌：不同令牌的应答不同（密钥独立）', () =>
  withEnv(async ({ tokenDir }) => {
    const dirA = path.join(tokenDir, 'a');
    const dirB = path.join(tokenDir, 'b');
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    const a = await soft.createToken(dirA, '', { pinFree: true });
    const b = await soft.createToken(dirB, '', { pinFree: true });
    const sa = await soft.openToken(a.path, '');
    const sb = await soft.openToken(b.path, '');
    assert.notDeepEqual(sa.hmac(Buffer.alloc(32, 1)), sb.hmac(Buffer.alloc(32, 1)));
    sa.close();
    sb.close();
  }));

test('自动解锁判定：只有"绑定令牌在场且免 PIN"才返回令牌', () =>
  withEnv(async ({ dataDir, tokenDir }) => {
    const pinToken = await soft.createToken(tokenDir, '123456');
    const vault = new Vault(dataDir);
    await vault.enroll({ tokenPath: pinToken.path, pin: '123456', library: SAMPLE });
    vault.lock();
    // 带 PIN 的令牌：绝不能自动尝试解锁（否则会白白扣尝试次数）
    assert.equal(vault.autoUnlockToken(), null);

    // 换成免 PIN 令牌绑定（先解锁，换绑需要已解锁或恢复态）
    const freeDir = path.join(tokenDir, 'free');
    fs.mkdirSync(freeDir);
    const free = await soft.createToken(freeDir, '', { pinFree: true });
    await vault.unlock({ pin: '123456', tokenPath: pinToken.path });
    await vault.rebind({ tokenPath: free.path, pin: '' });
    vault.lock();
    const auto = vault.autoUnlockToken();
    assert.ok(auto, '免 PIN 令牌应当可自动解锁');
    assert.equal(auto.serial, free.serial);
    assert.equal(auto.pinFree, true);

    // 解锁后不再是"锁定态"，判定返回 null
    await vault.unlock({ pin: '', tokenPath: free.path });
    assert.equal(vault.autoUnlockToken(), null);

    // 令牌被拔走 → 判定返回 null
    vault.lock();
    fs.rmSync(free.path);
    assert.equal(vault.autoUnlockToken(), null);
  }));

test('免 PIN 保险库：状态带 pinFree，空 PIN 可解锁且数据完整', () =>
  withEnv(async ({ dataDir, tokenDir }) => {
    const freeDir = path.join(tokenDir, 'free2');
    fs.mkdirSync(freeDir);
    const free = await soft.createToken(freeDir, '', { pinFree: true });
    const vault = new Vault(dataDir);
    await vault.enroll({ tokenPath: free.path, pin: '', library: SAMPLE });
    assert.equal(vault.status().pinFree, true);

    const reborn = new Vault(dataDir);
    assert.equal(reborn.status().locked, true);
    await reborn.unlock({ pin: '' });
    assert.deepEqual(reborn.codec().decode(fs.readFileSync(path.join(dataDir, 'library.enc'))), SAMPLE);
  }));

test('发现：扫描目录里的令牌能被找到，按序列号定位', () =>
  withEnv(async ({ tokenDir }) => {
    const { serial } = await soft.createToken(tokenDir, '123456');
    const found = provider.discover();
    assert.ok(found.some((t) => t.serial === serial));
    assert.equal(provider.findBySerial(serial).serial, serial);
    assert.equal(provider.findBySerial('不存在的序列号'), null);
  }));

// ---------- 保险库：启用 / 解锁 / 锁定 ----------

test('保险库：启用后数据是密文，重启后凭令牌+PIN 解回原样', () =>
  withEnv(async ({ dataDir, tokenDir }) => {
    const { path: tokenPath } = await soft.createToken(tokenDir, '123456');
    const vault = new Vault(dataDir);
    assert.equal(vault.isEnabled(), false);
    const { recoveryCode, serial } = await vault.enroll({ tokenPath, pin: '123456', library: SAMPLE });
    assert.match(recoveryCode, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
    assert.ok(serial);

    const enc = fs.readFileSync(path.join(dataDir, 'library.enc'));
    assert.equal(enc.subarray(0, 4).toString('ascii'), 'DVC1');
    assert.ok(!enc.includes(Buffer.from('secret-plan')), '密文里不能出现明文链接');
    assert.ok(!enc.includes(Buffer.from('不该被明文看到')), '密文里不能出现明文备注');

    // 模拟重启：新实例默认锁定，codec 不可用
    const reborn = new Vault(dataDir);
    assert.equal(reborn.status().locked, true);
    assert.throws(() => reborn.codec().encode(SAMPLE), /已锁定/);
    await reborn.unlock({ pin: '123456' });
    const decoded = reborn.codec().decode(fs.readFileSync(path.join(dataDir, 'library.enc')));
    assert.deepEqual(decoded, SAMPLE);
    reborn.lock();
    assert.throws(() => reborn.codec().decode(enc), /已锁定/);
  }));

test('保险库：错误 PIN、错误令牌都打不开', () =>
  withEnv(async ({ dataDir, tokenDir }) => {
    const { path: tokenPath } = await soft.createToken(tokenDir, '123456');
    const vault = new Vault(dataDir);
    await vault.enroll({ tokenPath, pin: '123456', library: SAMPLE });
    vault.lock();

    await assert.rejects(() => vault.unlock({ pin: '999999' }), /PIN 不正确/);
    assert.equal(vault.status().locked, true);

    const other = await soft.createToken(tmpDir(), '123456');
    try {
      await assert.rejects(() => vault.unlock({ pin: '123456', tokenPath: other.path }), /不匹配/);
    } finally {
      fs.rmSync(path.dirname(other.path), { recursive: true, force: true });
    }
  }));

test('保险库：密文被篡改时解锁失败（GCM 完整性）', () =>
  withEnv(async ({ dataDir, tokenDir }) => {
    const { path: tokenPath } = await soft.createToken(tokenDir, '123456');
    const vault = new Vault(dataDir);
    await vault.enroll({ tokenPath, pin: '123456', library: SAMPLE });
    vault.lock();

    const encFile = path.join(dataDir, 'library.enc');
    const buf = fs.readFileSync(encFile);
    buf[buf.length - 1] ^= 0xff; // 翻一个比特
    fs.writeFileSync(encFile, buf);
    await assert.rejects(() => vault.unlock({ pin: '123456' }));
    assert.equal(vault.status().locked, true);
  }));

// ---------- 恢复码 ----------

test('恢复码：解锁 → 绑定新令牌 → 旧令牌失效、新恢复码生效', () =>
  withEnv(async ({ dataDir, tokenDir }) => {
    const oldToken = await soft.createToken(tokenDir, '123456');
    const vault = new Vault(dataDir);
    const { recoveryCode } = await vault.enroll({ tokenPath: oldToken.path, pin: '123456', library: SAMPLE });
    vault.lock();

    await assert.rejects(() => vault.unlockWithRecovery('0000-0000-0000-0000-0000-0000-0000-0000'), /恢复码不正确/);
    const { needRebind } = await vault.unlockWithRecovery(recoveryCode);
    assert.equal(needRebind, true);
    assert.equal(vault.status().recovery, true);
    // recovery 状态还不算解锁，数据不可用
    assert.throws(() => vault.codec().encode(SAMPLE), /已锁定/);

    const newTokenDir = path.join(tokenDir, 'token2');
    fs.mkdirSync(newTokenDir);
    const newToken = await soft.createToken(newTokenDir, '654321');
    const rebound = await vault.rebind({ tokenPath: newToken.path, pin: '654321' });
    assert.match(rebound.recoveryCode, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
    assert.notEqual(rebound.recoveryCode, recoveryCode, '换绑后旧恢复码应作废');
    assert.equal(vault.status().locked, false);
    assert.deepEqual(vault.codec().decode(fs.readFileSync(path.join(dataDir, 'library.enc'))), SAMPLE);

    // 旧令牌不再被接受；新令牌可以正常解锁
    vault.lock();
    await assert.rejects(() => vault.unlock({ pin: '123456', tokenPath: oldToken.path }), /不匹配/);
    await vault.unlock({ pin: '654321' });
    assert.equal(vault.status().locked, false);
  }));

test('恢复码：规范化容忍分隔符与易混淆字符', () => {
  const code = '0ABC-DEFG-HJKM-NPQR-STVW-XYZ2-3456-70AB';
  assert.equal(normalizeRecoveryCode(code.toLowerCase().replace(/-/g, ' ')), code.replace(/-/g, ''));
  assert.equal(normalizeRecoveryCode('OABC-DEFG-HJKM-NPQR-STVW-XYZ2-3456-7OAB'), '0ABCDEFGHJKMNPQRSTVWXYZ2345670AB'.slice(0, 32));
  assert.throws(() => normalizeRecoveryCode('123'), /32 位/);
});

// ---------- Store 集成 ----------

test('Store+codec：加密读写、备份、损坏后从备份恢复', () =>
  withEnv(async ({ dataDir, tokenDir }) => {
    const { path: tokenPath } = await soft.createToken(tokenDir, '123456');
    const vault = new Vault(dataDir);
    await vault.enroll({ tokenPath, pin: '123456', library: SAMPLE });

    const encFile = path.join(dataDir, 'library.enc');
    const store = new Store(encFile, { codec: vault.codec() });
    assert.equal(store.load().recovered, 'none');
    assert.equal(store.data.docs.length, 1);

    store.addDoc({ url: 'https://example.com/another', title: '第二篇' });
    assert.ok(fs.existsSync(`${encFile}.bak`), '第二次保存应留下备份');

    // 重新打开：数据仍在
    const again = new Store(encFile, { codec: vault.codec() });
    again.load();
    assert.equal(again.data.docs.length, 2);
    again.save(); // 再存一次，让 .bak 也滚动到 2 条（备份天生落后一代）

    // 主文件损坏 → 从 .bak 恢复（留档，不丢数据）
    fs.writeFileSync(encFile, Buffer.from('DVC1' + 'x'.repeat(60)));
    const recovered = new Store(encFile, { codec: vault.codec() });
    assert.equal(recovered.load().recovered, 'backup');
    assert.equal(recovered.data.docs.length, 2);
    assert.ok(fs.readdirSync(dataDir).some((n) => n.startsWith('library.enc.corrupt-')));
  }));

test('停用保护：还原明文库并清掉保险库文件', () =>
  withEnv(async ({ dataDir, tokenDir }) => {
    const { path: tokenPath } = await soft.createToken(tokenDir, '123456');
    const vault = new Vault(dataDir);
    await vault.enroll({ tokenPath, pin: '123456', library: SAMPLE });
    const plain = await vault.disable({ pin: '123456' });
    assert.deepEqual(plain, SAMPLE);
    assert.equal(vault.isEnabled(), false);
    assert.ok(!fs.existsSync(path.join(dataDir, 'library.enc')));
    // 明文 Store 能直接读回
    const file = path.join(dataDir, 'library.json');
    fs.writeFileSync(file, JSON.stringify(plain));
    const store = new Store(file);
    store.load();
    assert.equal(store.data.docs.length, 1);
  }));
