// 保险库（Vault）：把文档库从"明文 JSON"升级为"没有令牌就解不开的密文"。
//
// 密钥层级（三层，各司其职）：
//   令牌 secret ──HMAC(salt)──▶ KEK ──AES-GCM 解包──▶ DEK ──AES-GCM──▶ library.enc
//
//   - secret：在令牌里（软件令牌=PIN 加密的文件；硬件令牌=永不出芯片的密钥）
//   - KEK：每次解锁现算，不落盘。salt 存在 vault.json，绑定令牌序列号
//   - DEK：32 字节随机数，真正加密数据的密钥。用 KEK 包起来存 vault.json，
//     另用"恢复码"再包一份——令牌丢了靠恢复码救数据，然后绑定新令牌
//
// 文件：
//   vault.json   元数据 + 两份包装好的 DEK（可以公开，没令牌/恢复码解不开）
//   library.enc  [DVC1][iv 12B][tag 16B][AES-256-GCM 密文]
//
// 状态机：disabled → (enroll) → unlocked ⇄ locked
//                         locked → (恢复码) → recovery → (rebind) → unlocked

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const soft = require('./token/soft-token');
const provider = require('./token/provider');

const scrypt = promisify(crypto.scrypt);

const VAULT_FILE = 'vault.json';
const ENC_FILE = 'library.enc';
const MAGIC = Buffer.from('DVC1', 'ascii');
const RECOVERY_KDF = { alg: 'scrypt', N: 32768, r: 8, p: 1 };
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
// Crockford base32（去掉易混淆的 I/L/O/U），8 组 × 4 位 ≈ 160 bit
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function seal(key, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('hex') };
}

function unseal(key, box) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(box.tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(box.data, 'hex')), decipher.final()]);
}

function deriveKek(hmacResponse, serial, driveId) {
  // HKDF：把令牌应答扩展成独立的加密密钥。
  // info 绑定令牌序列号 + U 盘卷序列号：把令牌文件拷到别的盘后，
  // 即便改了文件里的 drive 字段，也推不出原来的 KEK，解不开已包装的 DEK。
  const info = driveId
    ? `docvault-vault-v1|${serial}|${driveId}`
    : `docvault-vault-v1|${serial}`;
  return Buffer.from(
    crypto.hkdfSync('sha256', hmacResponse, Buffer.from('docvault-vault-v1'), Buffer.from(info), 32)
  );
}

function generateRecoveryCode() {
  const bytes = crypto.randomBytes(20); // 160 bit
  let out = '';
  for (let i = 0; i < 32; i += 1) {
    // 每 5 bit 取一个字符（20 字节 = 160 bit = 32 字符）
    const bitPos = i * 5;
    const byteIdx = bitPos >> 3;
    const shift = bitPos & 7;
    let value;
    if (shift <= 3) {
      value = (bytes[byteIdx] >> (3 - shift)) & 31;
    } else {
      value = ((bytes[byteIdx] << (shift - 3)) | (bytes[byteIdx + 1] >> (11 - shift))) & 31;
    }
    out += CODE_ALPHABET[value];
  }
  return out.match(/.{4}/g).join('-');
}

function normalizeRecoveryCode(input) {
  const cleaned = String(input || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (cleaned.length !== 32) throw new Error('恢复码应为 32 位字符（8 组 × 4 位）');
  return cleaned;
}

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---------- 纯加解密（不关心状态，供内部与 codec 共用） ----------

function encryptBuffer(dek, data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  const plain = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

function decryptBuffer(dek, buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 32 || !buf.subarray(0, 4).equals(MAGIC)) {
    throw new Error('数据文件不是有效的加密库（缺少 DVC1 头）');
  }
  const iv = buf.subarray(4, 16);
  const tag = buf.subarray(16, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(buf.subarray(32)), decipher.final()]);
  return JSON.parse(plain.toString('utf-8'));
}

class Vault {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.vaultFile = path.join(dataDir, VAULT_FILE);
    this.encFile = path.join(dataDir, ENC_FILE);
    this.state = this.isEnabled() ? 'locked' : 'disabled';
    this.dek = null; // 仅内存；lock() 时清零
    this.boundSerial = null;
    this.boundTokenPath = null;
  }

  isEnabled() {
    return fs.existsSync(this.vaultFile);
  }

  // 轻量状态查询（不做文件 I/O），供 IPC 门禁用
  isLocked() {
    return this.state === 'locked' || this.state === 'recovery';
  }

  status() {
    let meta = null;
    let error = null;
    if (this.isEnabled()) {
      try {
        meta = this.#meta();
      } catch (err) {
        error = err.message; // 元数据损坏也要能报告状态，而不是把锁定页打崩
      }
    }
    return {
      enabled: this.state !== 'disabled',
      locked: this.state === 'locked',
      recovery: this.state === 'recovery',
      serial: meta ? meta.token.serial : null,
      tokenType: meta ? meta.token.type : null,
      pinFree: meta ? meta.token.pinFree === true : false,
      createdAt: meta ? meta.createdAt : null,
      error,
    };
  }

  #meta() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.vaultFile, 'utf-8'));
    } catch (err) {
      throw new Error(`保险库元数据读取失败：${err.message}`);
    }
    if (!raw || raw.v !== 1 || !raw.token || !raw.salt || !raw.wrappedDek || !raw.recovery) {
      throw new Error('保险库元数据无效（vault.json 被改动或损坏）');
    }
    return raw;
  }

  // ---------- 编解码（给 Store 当 codec 用） ----------

  codec() {
    return {
      encode: (data) => encryptBuffer(this.#requireDek(), data),
      decode: (buffer) => decryptBuffer(this.#requireDek(), buffer),
    };
  }

  // recovery 状态虽然 DEK 已在内存，但必须先绑定新令牌才允许读写数据
  #requireDek() {
    if (!this.dek || this.state === 'locked' || this.state === 'recovery') {
      throw new Error('文档库已锁定');
    }
    return this.dek;
  }

  // 解锁后校验一次密文完整性：GCM tag 不过说明文件被改过/密钥不对
  #verifyEncFile(dek) {
    if (!fs.existsSync(this.encFile)) return; // 全新保险库允许为空
    decryptBuffer(dek, fs.readFileSync(this.encFile));
  }

  // ---------- 启用（迁移现有明文库） ----------

  async enroll({ tokenPath, pin, library }) {
    if (this.state !== 'disabled') throw new Error('U盾保护已经启用');
    const session = await soft.openToken(tokenPath, pin);
    const dek = crypto.randomBytes(32);
    const salt = crypto.randomBytes(32);
    let recoveryCode = null;
    try {
      const kek = deriveKek(session.hmac(salt), session.serial, session.driveId);
      recoveryCode = generateRecoveryCode();
      const recSalt = crypto.randomBytes(16).toString('hex');
      const recKey = await scrypt(normalizeRecoveryCode(recoveryCode), Buffer.from(recSalt, 'hex'), 32, {
        ...RECOVERY_KDF,
        maxmem: SCRYPT_MAXMEM,
      });
      const meta = {
        v: 1,
        token: {
          type: session.type,
          serial: session.serial,
          pinFree: session.pinFree === true,
          driveId: session.driveId || null,
          path: tokenPath,
        },
        salt: salt.toString('hex'),
        wrappedDek: seal(kek, dek),
        recovery: { kdf: { ...RECOVERY_KDF, salt: recSalt }, wrappedDek: seal(recKey, dek) },
        createdAt: Date.now(),
      };
      kek.fill(0);
      recKey.fill(0);

      // 先写密文、再写元数据；任何一步失败都不留下"半个保险库"
      const enc = encryptBuffer(dek, library);
      fs.writeFileSync(this.encFile, enc, { mode: 0o600 });
      try {
        writeJsonAtomic(this.vaultFile, meta);
      } catch (err) {
        fs.rmSync(this.encFile, { force: true });
        throw err;
      }
      this.dek = dek;
      this.state = 'unlocked';
      this.boundSerial = session.serial;
      this.boundTokenPath = tokenPath;
      return { recoveryCode, serial: session.serial, drive: session.driveId || null };
    } catch (err) {
      dek.fill(0);
      this.dek = null;
      throw err;
    } finally {
      session.close();
    }
  }

  // ---------- 解锁 ----------

  async unlock({ pin, tokenPath }) {
    if (this.state === 'disabled') throw new Error('尚未启用 U盾保护');
    if (this.state === 'unlocked') return { serial: this.boundSerial };
    if (this.state === 'recovery') throw new Error('请先完成新令牌的绑定');
    const meta = this.#meta();

    // 指定路径优先；否则按序列号在挂载点里找"那枚"令牌
    let info = null;
    if (tokenPath) {
      info = soft.readTokenInfo(tokenPath);
      if (!info) throw new Error('令牌文件无效');
    } else {
      info = provider.findBySerial(meta.token.serial);
    }
    if (!info) throw new Error('未检测到绑定的令牌，请插入对应的 U 盘');
    if (info.serial !== meta.token.serial) throw new Error('这枚令牌与保险库不匹配（序列号不同）');

    const session = await soft.openToken(info.path, pin);
    const dek = crypto.randomBytes(32);
    try {
      // 旧版保险库没有 driveId，用旧 info 派生；解锁成功后就地升级为 U 盘绑定
      const metaDrive = meta.token.driveId || null;
      const kek = deriveKek(session.hmac(Buffer.from(meta.salt, 'hex')), session.serial, metaDrive);
      const unwrapped = unseal(kek, meta.wrappedDek);
      kek.fill(0);
      unwrapped.copy(dek);
      unwrapped.fill(0);
      this.#verifyEncFile(dek); // 失败会抛错，下面 catch 里清零
      this.dek = dek;
      this.state = 'unlocked';
      this.boundSerial = session.serial;
      this.boundTokenPath = info.path;
      this.#upgradeDriveBinding(meta, session, dek);
      return { serial: session.serial };
    } catch (err) {
      dek.fill(0);
      this.dek = null;
      if (/unsupported|bad decrypt|unable to authenticate/i.test(err.message)) {
        throw new Error('令牌应答与保险库不匹配，无法解包数据密钥');
      }
      throw err;
    } finally {
      session.close();
    }
  }

  // 旧版保险库迁移：补上 U 盘绑定并把 DEK 重新包装。
  // 只影响 wrappedDek 的包装方式，DEK 与数据文件不动；失败不影响本次解锁。
  #upgradeDriveBinding(meta, session, dek) {
    if (meta.token.driveId) return;
    try {
      let driveId = session.driveId;
      if (!driveId) driveId = soft.bindDrive(this.boundTokenPath);
      if (!driveId) return; // 盘无序列号（如某些虚拟盘）：保持不绑定
      const kek = deriveKek(
        session.hmac(Buffer.from(meta.salt, 'hex')),
        session.serial,
        driveId
      );
      meta.token.driveId = driveId;
      meta.wrappedDek = seal(kek, dek);
      kek.fill(0);
      writeJsonAtomic(this.vaultFile, meta);
      console.log(`[vault] 已把令牌绑定到当前 U 盘（${driveId}）`);
    } catch (err) {
      console.error(`[vault] U 盘绑定迁移失败：${err.message}`);
    }
  }

  // ---------- 恢复码（令牌丢失时的唯一出口） ----------

  async unlockWithRecovery(code) {
    if (this.state === 'disabled') throw new Error('尚未启用 U盾保护');
    if (this.state !== 'locked') throw new Error('当前状态不需要恢复');
    const meta = this.#meta();
    const normalized = normalizeRecoveryCode(code);
    const recKey = await scrypt(normalized, Buffer.from(meta.recovery.kdf.salt, 'hex'), 32, {
      ...RECOVERY_KDF,
      maxmem: SCRYPT_MAXMEM,
    });
    const dek = crypto.randomBytes(32);
    try {
      const unwrapped = unseal(recKey, meta.recovery.wrappedDek);
      recKey.fill(0);
      unwrapped.copy(dek);
      unwrapped.fill(0);
      this.#verifyEncFile(dek);
      this.dek = dek;
      this.state = 'recovery'; // 数据密钥已到手，但必须绑定新令牌才算解锁
      return { needRebind: true };
    } catch (err) {
      dek.fill(0);
      this.dek = null;
      recKey.fill(0);
      if (/unable to authenticate|bad decrypt/i.test(err.message)) {
        throw new Error('恢复码不正确');
      }
      throw err;
    }
  }

  // 绑定新令牌（恢复流程），或更换令牌（已解锁时）。会生成新的恢复码。
  async rebind({ tokenPath, pin }) {
    if (this.state !== 'recovery' && this.state !== 'unlocked') {
      throw new Error('请先用恢复码或原令牌解锁');
    }
    const dek = this.dek;
    if (!dek) throw new Error('数据密钥不在内存中');
    const session = await soft.openToken(tokenPath, pin);
    const salt = crypto.randomBytes(32);
    let recoveryCode = null;
    try {
      const kek = deriveKek(session.hmac(salt), session.serial, session.driveId);
      recoveryCode = generateRecoveryCode();
      const recSalt = crypto.randomBytes(16).toString('hex');
      const recKey = await scrypt(normalizeRecoveryCode(recoveryCode), Buffer.from(recSalt, 'hex'), 32, {
        ...RECOVERY_KDF,
        maxmem: SCRYPT_MAXMEM,
      });
      const old = this.#meta();
      const meta = {
        v: 1,
        token: {
          type: session.type,
          serial: session.serial,
          pinFree: session.pinFree === true,
          driveId: session.driveId || null,
          path: tokenPath,
        },
        salt: salt.toString('hex'),
        wrappedDek: seal(kek, dek),
        recovery: { kdf: { ...RECOVERY_KDF, salt: recSalt }, wrappedDek: seal(recKey, dek) },
        createdAt: old.createdAt || Date.now(),
        reboundAt: Date.now(),
      };
      kek.fill(0);
      recKey.fill(0);
      writeJsonAtomic(this.vaultFile, meta);
      this.state = 'unlocked';
      this.boundSerial = session.serial;
      this.boundTokenPath = tokenPath;
      return { recoveryCode, serial: session.serial, drive: session.driveId || null };
    } finally {
      session.close();
    }
  }

  // ---------- 锁定 / 停用 ----------

  lock() {
    if (this.dek) this.dek.fill(0);
    this.dek = null;
    this.boundTokenPath = null;
    this.state = this.isEnabled() ? 'locked' : 'disabled';
  }

  // 停用保护：校验 PIN → 解出明文返回给调用方落盘 → 删除保险库文件
  async disable({ pin }) {
    if (this.state === 'disabled') throw new Error('尚未启用 U盾保护');
    if (this.state !== 'unlocked') await this.unlock({ pin });
    const library = this.codec().decode(fs.readFileSync(this.encFile));
    for (const file of [this.vaultFile, this.encFile, `${this.encFile}.bak`, `${this.vaultFile}.tmp`]) {
      fs.rmSync(file, { force: true });
    }
    this.lock();
    this.state = 'disabled';
    return library;
  }

  // 重置时用：返回绑定令牌的文件路径（未启用或元数据损坏时返回 null）。
  // 盘符可能变化：旧路径失效时按序列号重新扫描，不依赖记录下来的盘符。
  tokenPath() {
    if (!this.isEnabled()) return null;
    try {
      const meta = this.#meta();
      if (meta.token.path && fs.existsSync(meta.token.path)) return meta.token.path;
      const info = provider.findBySerial(meta.token.serial);
      return info ? info.path : meta.token.path || null;
    } catch {
      return null;
    }
  }

  // 拔盾检测：绑定的那枚令牌还在不在。
  // 快路径：记住令牌路径（vault.json 里的 token.path），一次 existsSync（约 0.07ms）；
  // 只有路径失效（换盘符/文件被移动）才退回全盘扫描。
  boundTokenPresent() {
    if (this.boundTokenPath && fs.existsSync(this.boundTokenPath)) return true;
    if (!this.boundSerial) return false;
    return provider.findBySerial(this.boundSerial) !== null;
  }

  // 轻量状态：令牌在不在、是不是免 PIN、有没有被锁。供锁定页高频轮询（不扫全盘）。
  boundTokenStatus() {
    const empty = { present: false, pinFree: false, locked: false, serial: null };
    if (!this.isEnabled()) return empty;
    let meta;
    try {
      meta = this.#meta();
    } catch {
      return empty;
    }
    let info = null;
    if (meta.token.path) info = soft.readTokenInfo(meta.token.path);
    if (!info || info.serial !== meta.token.serial) info = provider.findBySerial(meta.token.serial);
    return {
      present: Boolean(info),
      pinFree: Boolean(info && info.pinFree),
      locked: Boolean(info && info.locked),
      serial: meta.token.serial,
    };
  }

  // 自动解锁判定：仅当"已启用 + 锁定中 + 绑定令牌在场且为免 PIN"时返回该令牌信息。
  // 只做只读探测，不打开会话——避免对带 PIN 的令牌误扣尝试次数。
  autoUnlockToken() {
    if (!this.isEnabled() || !this.isLocked()) return null;
    let meta;
    try {
      meta = this.#meta();
    } catch {
      return null;
    }
    let info = null;
    if (meta.token.path) info = soft.readTokenInfo(meta.token.path);
    if (!info || info.serial !== meta.token.serial) info = provider.findBySerial(meta.token.serial);
    return info && info.pinFree ? info : null;
  }
}

module.exports = { Vault, VAULT_FILE, ENC_FILE, generateRecoveryCode, normalizeRecoveryCode };
