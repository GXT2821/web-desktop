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

// ---------- U 盘绑定 ----------

test('U 盘绑定：令牌记录卷序列号，换到别的盘打不开', () =>
  withEnv(async ({ tokenDir }) => {
    const bound = await soft.createToken(tokenDir, '123456', { drive: { volumeSerial: 'AAAA-BBBB' } });
    assert.equal(soft.readTokenInfo(bound.path).boundDrive, 'AAAA-BBBB');
    // 当前测试目录在 C: 盘，卷序列号不可能正好是 AAAA-BBBB
    await assert.rejects(() => soft.openToken(bound.path, '123456'), /U 盘不匹配|U 盘编码/);
  }));

test('U 盘绑定：与所在盘一致时可以正常打开', () =>
  withEnv(async ({ tokenDir }) => {
    const drive = require('../src/token/drive');
    const probe = path.join(tokenDir, 'probe');
    const current = drive.identify(probe);
    if (!current) {
      // 无卷序列号的平台（如部分 Linux 容器）跳过
      return;
    }
    const token = await soft.createToken(tokenDir, '123456', { drive: current });
    const session = await soft.openToken(token.path, '123456');
    assert.equal(session.driveId, current.volumeSerial);
    session.close();
  }));

test('U 盘绑定：保险库把 driveId 纳入 KEK，改令牌文件里的盘号也解不开', () =>
  withEnv(async ({ dataDir, tokenDir }) => {
    const drive = require('../src/token/drive');
    const current = drive.identify(path.join(tokenDir, 'probe'));
    if (!current) return; // 无卷序列号时跳过
    const token = await soft.createToken(tokenDir, '123456', { drive: current });
    const vault = new Vault(dataDir);
    await vault.enroll({ tokenPath: token.path, pin: '123456', library: SAMPLE });
    vault.lock();

    // 篡改令牌文件里的盘号，伪造"这是当前盘"
    const raw = JSON.parse(fs.readFileSync(token.path, 'utf-8'));
    raw.drive = { volumeSerial: 'FFFF-FFFF' };
    fs.writeFileSync(token.path, JSON.stringify(raw));
    // 伪造的盘号与当前盘不符：openToken 直接拒绝
    await assert.rejects(() => vault.unlock({ pin: '123456', tokenPath: token.path }), /U 盘不匹配|U 盘编码/);

    // 恢复真实盘号后可以解锁（vault.json 里的 driveId 才是权威）
    raw.drive = { volumeSerial: current.volumeSerial };
    fs.writeFileSync(token.path, JSON.stringify(raw));
    await vault.unlock({ pin: '123456' });
    assert.deepEqual(vault.codec().decode(fs.readFileSync(vault.encFile)), SAMPLE);
  }));

test('U 盘绑定：旧保险库解锁后就地升级为绑定', () =>
  withEnv(async ({ dataDir, tokenDir }) => {
    // 创建"旧版"令牌：显式不绑定
    const token = await soft.createToken(tokenDir, '123456', { drive: null });
    const vault = new Vault(dataDir);
    await vault.enroll({ tokenPath: token.path, pin: '123456', library: SAMPLE });
    const metaBefore = JSON.parse(fs.readFileSync(path.join(dataDir, 'vault.json'), 'utf-8'));
    assert.equal(metaBefore.tokens ? metaBefore.tokens[0].driveId : metaBefore.token.driveId, null);

    vault.lock();
    await vault.unlock({ pin: '123456' });

    const metaAfter = JSON.parse(fs.readFileSync(path.join(dataDir, 'vault.json'), 'utf-8'));
    const drive = require('../src/token/drive');
    const current = drive.identify(token.path);
    if (current) {
      assert.equal(metaAfter.tokens[0].driveId, current.volumeSerial, '解锁后应补上 driveId');
      assert.equal(soft.readTokenInfo(token.path).boundDrive, current.volumeSerial, '令牌文件也应补上盘号');
    }
  }));

test('U 盘绑定：只认卷序列号，换盘符/换路径不影响解锁', () =>
  withEnv(async ({ dataDir, tokenDir }) => {
    const drive = require('../src/token/drive');
    const current = drive.identify(path.join(tokenDir, 'probe'));
    if (!current) return; // 无卷序列号时跳过
    const token = await soft.createToken(tokenDir, '123456', { drive: current });
    const vault = new Vault(dataDir);
    await vault.enroll({ tokenPath: token.path, pin: '123456', library: SAMPLE });
    vault.lock();

    // 模拟盘符变化：令牌被挪到同一个卷的另一个挂载目录，vault.json 里的旧路径失效
    const movedDir = path.join(tokenDir, 'MOUNT-E');
    fs.mkdirSync(movedDir);
    fs.renameSync(token.path, path.join(movedDir, 'DocVault.key'));

    // 旧路径读不到，但按序列号扫描能找回来；盘符/路径不参与身份判定
    assert.equal(vault.status().locked, true);
    assert.equal(vault.boundTokenStatus().present, true, '扫描应能找到移动后的令牌');
    assert.equal(vault.tokenPath(), path.join(movedDir, 'DocVault.key'), '重置用的路径也应重新解析');
    await vault.unlock({ pin: '123456' });
    assert.equal(vault.status().locked, false);
    assert.deepEqual(vault.codec().decode(fs.readFileSync(vault.encFile)), SAMPLE);
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

test('恢复码：解锁 → 绑定新令牌（追加）→ 新旧令牌都可用、恢复码轮换', () =>
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

    // 多令牌语义：旧令牌继续可用（跨系统共用一个保险库），新令牌同样可解锁
    vault.lock();
    await vault.unlock({ pin: '123456', tokenPath: oldToken.path });
    assert.equal(vault.status().locked, false);
    vault.lock();
    await vault.unlock({ pin: '654321', tokenPath: newToken.path });
    assert.equal(vault.status().locked, false);
    assert.equal(vault.status().tokenCount, 2, '两枚令牌都应记录在库里');
    // 未绑定到本库的令牌会被明确拒绝
    const strangerDir = path.join(tokenDir, 'token3');
    fs.mkdirSync(strangerDir);
    const stranger = await soft.createToken(strangerDir, '111111');
    vault.lock();
    await assert.rejects(() => vault.unlock({ pin: '111111', tokenPath: stranger.path }), /不匹配/);
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

// ---------- 多令牌：一套系统一枚，共用一个保险库 ----------

test('多令牌：同一个 U 盘目录可放多枚令牌，追加后两枚都能解锁', () =>
  withEnv(async ({ dataDir, tokenDir }) => {
    const first = await soft.createToken(tokenDir, '123456');
    const vault = new Vault(dataDir);
    await vault.enroll({ tokenPath: first.path, pin: '123456', library: SAMPLE });

    // 同一目录再建一枚：默认拒绝，allowMultiple 时另存为 DocVault-<平台>.key
    await assert.rejects(() => soft.createToken(tokenDir, '654321'), /已经有一枚令牌/);
    const second = await soft.createToken(tokenDir, '654321', { allowMultiple: true });
    assert.notEqual(second.path, first.path, '第二枚要写到另一个位置');
    assert.equal(path.basename(first.path), 'DocVault.key');
    // 按系统分目录：<U盘>/mac/DocVault.key
    assert.match(path.relative(tokenDir, second.path), /^(win|mac|linux)(-\d+)?[\\/]DocVault\.key$/);

    // 解锁后追加第二枚
    const added = await vault.addToken({ tokenPath: second.path, pin: '654321' });
    assert.equal(added.count, 2);
    assert.equal(vault.status().tokenCount, 2);

    // 两枚都能独立解锁
    vault.lock();
    await vault.unlock({ pin: '654321', tokenPath: second.path });
    assert.equal(vault.status().locked, false);
    vault.lock();
    await vault.unlock({ pin: '123456', tokenPath: first.path });
    assert.equal(vault.status().locked, false);

    // 重复追加被拒
    await assert.rejects(() => vault.addToken({ tokenPath: second.path, pin: '654321' }), /已经绑定过/);
  }));

test('多令牌：作废一枚后它解不开，其余仍可用；不能删光', () =>
  withEnv(async ({ dataDir, tokenDir }) => {
    const first = await soft.createToken(tokenDir, '123456');
    const vault = new Vault(dataDir);
    await vault.enroll({ tokenPath: first.path, pin: '123456', library: SAMPLE });
    const secondDir = path.join(tokenDir, 'b');
    fs.mkdirSync(secondDir);
    const second = await soft.createToken(secondDir, '654321');
    await vault.addToken({ tokenPath: second.path, pin: '654321' });

    vault.removeToken(second.serial);
    assert.equal(vault.status().tokenCount, 1);
    vault.lock();
    await assert.rejects(() => vault.unlock({ pin: '654321', tokenPath: second.path }), /不匹配/);
    await vault.unlock({ pin: '123456', tokenPath: first.path });
    assert.throws(() => vault.removeToken(first.serial), /至少要保留一枚令牌/);
  }));

test('多令牌：v1 元数据（单令牌 token+wrappedDek）仍能读，读后可正常解锁', () =>
  withEnv(async ({ dataDir, tokenDir }) => {
    const token = await soft.createToken(tokenDir, '123456');
    const vault = new Vault(dataDir);
    await vault.enroll({ tokenPath: token.path, pin: '123456', library: SAMPLE });

    // 手工降级成 v1 结构
    const file = path.join(dataDir, 'vault.json');
    const v2 = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const rec = v2.tokens[0];
    const v1 = { v: 1, token: { ...rec }, salt: v2.salt, wrappedDek: rec.wrappedDek, recovery: v2.recovery };
    delete v1.token.wrappedDek;
    fs.writeFileSync(file, JSON.stringify(v1));

    const reopened = new Vault(dataDir);
    await reopened.unlock({ pin: '123456', tokenPath: token.path });
    assert.deepEqual(reopened.codec().decode(fs.readFileSync(path.join(dataDir, 'library.enc'))), SAMPLE);
  }));

test('drive.mountRoot：macOS 解析到 /Volumes/<盘名>，而不是根目录', () => {
  const drive = require('../src/token/drive');
  if (process.platform === 'darwin') {
    assert.equal(drive.mountRoot('/Volumes/U盘/DocVault.key'), '/Volumes/U盘');
    assert.equal(drive.mountRoot('/Volumes/NO NAME/sub/DocVault.key'), '/Volumes/NO NAME');
    assert.equal(drive.mountRoot('/tmp/DocVault.key'), '/');
  }
  // Windows 盘符根
  if (process.platform === 'win32') {
    assert.equal(drive.mountRoot('D:\\DocVault.key'), 'D:\\');
  }
});

test('多令牌：tokenList 返回已绑定的令牌与在场状态', () =>
  withEnv(async ({ dataDir, tokenDir }) => {
    const first = await soft.createToken(tokenDir, '123456');
    const vault = new Vault(dataDir);
    await vault.enroll({ tokenPath: first.path, pin: '123456', library: SAMPLE });
    const secondDir = path.join(tokenDir, 'b');
    fs.mkdirSync(secondDir);
    const second = await soft.createToken(secondDir, '654321');
    await vault.addToken({ tokenPath: second.path, pin: '654321' });

    const list = vault.tokenList();
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((t) => t.serial).sort(), [first.serial, second.serial].sort());
    for (const token of list) {
      assert.equal(token.pinFree, false);
      assert.equal(token.present, true, '两枚令牌文件都还在，应显示在场');
      assert.ok(token.path, '应带令牌路径');
    }
  }));
