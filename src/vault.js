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
    // 多令牌时，界面关心的是"当前解锁用的这枚"是不是免 PIN（停用对话框据此决定
    // 要不要收 PIN），所以优先取 boundSerial 对应的记录，退回第一枚。
    const current = meta
      ? meta.tokens.find((t) => t.serial === this.boundSerial) || meta.tokens[0]
      : null;
    return {
      enabled: this.state !== 'disabled',
      locked: this.state === 'locked',
      recovery: this.state === 'recovery',
      serial: current ? current.serial : null,
      serials: meta ? meta.tokens.map((t) => t.serial) : [],
      tokenCount: meta ? meta.tokens.length : 0,
      tokenType: current ? current.type : null,
      pinFree: current ? current.pinFree === true : false,
      createdAt: meta ? meta.createdAt : null,
      error,
    };
  }

  // 读元数据并统一成 v2 结构：{ salt, tokens: [{...token, wrappedDek}], recovery }。
  // v1 是单令牌（token + wrappedDek），读进来就地提升，写入时升到 v2。
  #meta() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.vaultFile, 'utf-8'));
    } catch (err) {
      throw new Error(`保险库元数据读取失败：${err.message}`);
    }
    if (!raw || !raw.salt || !raw.recovery) {
      throw new Error('保险库元数据无效（vault.json 被改动或损坏）');
    }
    let tokens;
    if (Array.isArray(raw.tokens)) {
      tokens = raw.tokens.filter((t) => t && t.serial && t.wrappedDek);
    } else if (raw.token && raw.wrappedDek) {
      tokens = [{ ...raw.token, wrappedDek: raw.wrappedDek }];
    } else {
      tokens = [];
    }
    if (!tokens.length) throw new Error('保险库元数据无效（没有可用的令牌记录）');
    return { v: 2, salt: raw.salt, tokens, recovery: raw.recovery, createdAt: raw.createdAt || null };
  }

  // 写回 v2（所有令牌各自一份 wrappedDek；salt 共享，密钥派生里还混了序列号）
  #writeMeta(meta) {
    writeJsonAtomic(this.vaultFile, {
      v: 2,
      salt: meta.salt,
      tokens: meta.tokens,
      recovery: meta.recovery,
      createdAt: meta.createdAt || Date.now(),
    });
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
        salt: salt.toString('hex'),
        tokens: [
          {
            type: session.type,
            serial: session.serial,
            pinFree: session.pinFree === true,
            driveId: session.driveId || null,
            path: tokenPath,
            wrappedDek: seal(kek, dek),
          },
        ],
        recovery: { kdf: { ...RECOVERY_KDF, salt: recSalt }, wrappedDek: seal(recKey, dek) },
        createdAt: Date.now(),
      };
      kek.fill(0);
      recKey.fill(0);

      // 先写密文、再写元数据；任何一步失败都不留下"半个保险库"
      const enc = encryptBuffer(dek, library);
      fs.writeFileSync(this.encFile, enc, { mode: 0o600 });
      try {
        this.#writeMeta(meta);
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

    // 指定路径优先；否则在挂载点里找"任何一枚已绑定的令牌"（多系统各一枚）
    let info = null;
    let record = null;
    if (tokenPath) {
      info = soft.readTokenInfo(tokenPath);
      if (!info) throw new Error('令牌文件无效');
      record = meta.tokens.find((t) => t.serial === info.serial) || null;
      if (!record) {
        throw new Error('这枚令牌与保险库不匹配：它还没有绑定到这个库（已解锁时可用「绑定新令牌」添加）');
      }
    }

    // 没有指定令牌：在"在场的令牌"里挑一枚。
    // 多系统共用一个 U 盘时，其他系统的令牌会在 openToken 的盘校验里被拦下
    // （这一步发生在验 PIN 之前，不会扣尝试次数），可以安全跳过；
    // 一旦出现 PIN 错误就停下——说明这枚就是本机的令牌，只是 PIN 不对。
    const tryTokens = info
      ? [{ info, record }]
      : meta.tokens
          .map((candidate) => ({ record: candidate, info: provider.findBySerial(candidate.serial) }))
          .filter((entry) => entry.info);

    if (!tryTokens.length) throw new Error('未检测到绑定的令牌，请插入对应的 U 盘');

    let session = null;
    let lastError = null;
    for (const entry of tryTokens) {
      try {
        session = await soft.openToken(entry.info.path, pin);
        info = entry.info;
        record = entry.record;
        break;
      } catch (err) {
        lastError = err;
        // 与当前盘不匹配 → 换下一枚；PIN/已锁定这类错误直接抛给用户
        if (/不匹配|编码不一致/.test(err.message)) continue;
        throw err;
      }
    }
    if (!session) throw lastError || new Error('未检测到可用的令牌');
    const dek = crypto.randomBytes(32);
    try {
      // 旧版保险库没有 driveId，用旧 info 派生；解锁成功后就地升级为 U 盘绑定
      const metaDrive = record.driveId || null;
      const kek = deriveKek(session.hmac(Buffer.from(meta.salt, 'hex')), session.serial, metaDrive);
      const unwrapped = unseal(kek, record.wrappedDek);
      kek.fill(0);
      unwrapped.copy(dek);
      unwrapped.fill(0);
      this.#verifyEncFile(dek); // 失败会抛错，下面 catch 里清零
      this.dek = dek;
      this.state = 'unlocked';
      this.boundSerial = session.serial;
      this.boundTokenPath = info.path;
      this.#upgradeDriveBinding(meta, record, session, dek);
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
  #upgradeDriveBinding(meta, record, session, dek) {
    if (record.driveId) return;
    try {
      let driveId = session.driveId;
      if (!driveId) driveId = soft.bindDrive(this.boundTokenPath);
      if (!driveId) return; // 盘无序列号（如某些虚拟盘）：保持不绑定
      const kek = deriveKek(
        session.hmac(Buffer.from(meta.salt, 'hex')),
        session.serial,
        driveId
      );
      record.driveId = driveId;
      record.wrappedDek = seal(kek, dek);
      kek.fill(0);
      this.#writeMeta(meta);
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
    let recoveryCode = null;
    try {
      const old = this.#meta();
      // 共享 salt 必须沿用：已有令牌的 wrappedDek 都是用它派生的，
      // 轮换 salt 会让它们全部解不开（多令牌场景下等于把老令牌作废）。
      const salt = Buffer.from(old.salt, 'hex');
      const kek = deriveKek(session.hmac(salt), session.serial, session.driveId);
      recoveryCode = generateRecoveryCode();
      const recSalt = crypto.randomBytes(16).toString('hex');
      const recKey = await scrypt(normalizeRecoveryCode(recoveryCode), Buffer.from(recSalt, 'hex'), 32, {
        ...RECOVERY_KDF,
        maxmem: SCRYPT_MAXMEM,
      });
      const record = {
        type: session.type,
        serial: session.serial,
        pinFree: session.pinFree === true,
        driveId: session.driveId || null,
        path: tokenPath,
        wrappedDek: seal(kek, dek),
      };
      // 追加而不是替换：同一个保险库可以绑定多枚令牌（每条系统一枚）。
      // 恢复码本身会作废（重新生成），旧令牌继续可用；要作废旧令牌用 removeToken。
      const tokens = old.tokens.filter((t) => t.serial !== record.serial).concat(record);
      const meta = {
        salt: salt.toString('hex'),
        tokens,
        recovery: { kdf: { ...RECOVERY_KDF, salt: recSalt }, wrappedDek: seal(recKey, dek) },
        createdAt: old.createdAt || Date.now(),
      };
      kek.fill(0);
      recKey.fill(0);
      this.#writeMeta(meta);
      this.state = 'unlocked';
      this.boundSerial = session.serial;
      this.boundTokenPath = tokenPath;
      return { recoveryCode, serial: session.serial, drive: session.driveId || null };
    } finally {
      session.close();
    }
  }

  // 已解锁时追加一枚令牌（典型用法：在另一套系统上建好令牌，绑定进同一个保险库）。
  // 只追加 wrap 记录，DEK 与数据文件都不动，其他令牌继续可用。
  async addToken({ tokenPath, pin }) {
    if (this.state !== 'unlocked') throw new Error('请先解锁再绑定新令牌');
    const dek = this.dek;
    if (!dek) throw new Error('数据密钥不在内存中');
    const meta = this.#meta();
    const session = await soft.openToken(tokenPath, pin);
    try {
      if (meta.tokens.some((t) => t.serial === session.serial)) {
        throw new Error('这枚令牌已经绑定过了');
      }
      const kek = deriveKek(session.hmac(Buffer.from(meta.salt, 'hex')), session.serial, session.driveId);
      const wrappedDek = seal(kek, dek);
      kek.fill(0);
      meta.tokens.push({
        type: session.type,
        serial: session.serial,
        pinFree: session.pinFree === true,
        driveId: session.driveId || null,
        path: tokenPath,
        wrappedDek,
      });
      this.#writeMeta(meta);
      console.log(`[vault] 已追加令牌 ${session.serial}（共 ${meta.tokens.length} 枚）`);
      return { serial: session.serial, count: meta.tokens.length };
    } finally {
      session.close();
    }
  }

  // 已绑定的令牌清单（给界面展示/管理用）
  tokenList() {
    if (!this.isEnabled()) return [];
    const meta = this.#meta();
    return meta.tokens.map((record) => ({
      serial: record.serial,
      pinFree: record.pinFree === true,
      driveId: record.driveId || null,
      path: record.path || null,
      present: Boolean(
        (record.path && soft.readTokenInfo(record.path)) || provider.findBySerial(record.serial)
      ),
    }));
  }

  // 作废一枚令牌：删掉它的 wrap 记录，之后这枚令牌解不开保险库。
  // 至少要留一枚——彻底停用请走「停用 U盾保护」。
  removeToken(serial) {
    if (this.state !== 'unlocked') throw new Error('请先解锁再解绑令牌');
    const meta = this.#meta();
    const next = meta.tokens.filter((t) => t.serial !== serial);
    if (next.length === meta.tokens.length) throw new Error('没有这枚令牌');
    if (!next.length) throw new Error('至少要保留一枚令牌');
    meta.tokens = next;
    this.#writeMeta(meta);
    // 解绑的正是当前这把钥匙：把"在场令牌"的记忆切到剩下的一枚。
    // 否则 boundTokenPresent() 的快路径仍认着被解绑的文件，拔掉它也不会上锁。
    if (serial === this.boundSerial) {
      this.boundSerial = next[0].serial;
      this.boundTokenPath = next[0].path || null;
    }
    return { count: next.length };
  }

  // ---------- 锁定 / 停用 ----------

  lock() {
    if (this.dek) this.dek.fill(0);
    this.dek = null;
    this.boundTokenPath = null;
    this.state = this.isEnabled() ? 'locked' : 'disabled';
  }

  // 停用保护：校验 PIN → 解出明文 →（可选）先落盘明文 → 再删除保险库文件。
  // persist(library)：调用方提供的明文持久化钩子，在删任何密文之前执行。
  // 之前是"先删密文、调用方再写明文"：写明文失败（磁盘满/只读）时数据只剩内存，
  // 退出即丢。现在 persist 抛错就直接中止，vault.json / library.enc 原样保留。
  // 不传 persist 时行为与旧版一致（返回明文，由调用方自行落盘）。
  async disable({ pin, persist }) {
    if (this.state === 'disabled') throw new Error('尚未启用 U盾保护');
    if (this.state !== 'unlocked') await this.unlock({ pin });
    // 已解锁时 unlock() 会直接返回，不能拿它当 PIN 校验：
    // 之前这里漏了这一步，界面上的 PIN 输入框形同虚设，输错也能把整库落成明文。
    else await this.#verifyPin(pin);
    const library = this.codec().decode(fs.readFileSync(this.encFile));
    if (persist) await persist(library);
    for (const file of [this.vaultFile, this.encFile, `${this.encFile}.bak`, `${this.vaultFile}.tmp`]) {
      fs.rmSync(file, { force: true });
    }
    this.lock();
    this.state = 'disabled';
    return library;
  }

  // 页面已解锁时再核对一次 PIN：打开一次绑定的令牌会话（会走 PIN 校验与 U 盘绑定），
  // 免 PIN 令牌本来就没有 PIN，openToken 会直接放行。
  async #verifyPin(pin) {
    const tokenPath =
      this.boundTokenPath && fs.existsSync(this.boundTokenPath)
        ? this.boundTokenPath
        : this.tokenPath();
    if (!tokenPath) throw new Error('没有可用的绑定令牌，请插入令牌后再停用保护');
    let session = null;
    try {
      session = await soft.openToken(tokenPath, pin);
    } catch (err) {
      throw new Error(`PIN 校验失败：${err.message}`);
    } finally {
      if (session) session.close();
    }
  }

  // 重置时用：返回绑定令牌的文件路径（未启用或元数据损坏时返回 null）。
  // 盘符可能变化：旧路径失效时按序列号重新扫描，不依赖记录下来的盘符。
  tokenPath() {
    if (!this.isEnabled()) return null;
    try {
      const meta = this.#meta();
      for (const record of meta.tokens) {
        if (record.path && fs.existsSync(record.path)) return record.path;
        const found = provider.findBySerial(record.serial);
        if (found) return found.path;
      }
      return meta.tokens[0].path || null;
    } catch {
      return null;
    }
  }

  // 拔盾检测：绑定的那枚令牌还在不在。
  // 快路径：记住令牌路径（vault.json 里的 token.path），一次 existsSync（约 0.07ms）；
  // 只有路径失效（换盘符/文件被移动）才退回全盘扫描。
  // 任一枚已绑定的令牌在场即算"盾插着"（多枚令牌时，哪个系统的在手边用哪个）
  boundTokenPresent() {
    if (this.boundTokenPath && fs.existsSync(this.boundTokenPath)) return true;
    let meta;
    try {
      meta = this.#meta();
    } catch {
      return false;
    }
    return meta.tokens.some((t) => provider.findBySerial(t.serial) !== null);
  }

  // 当前在场的所有令牌（可能同时插着多枚，比如 U 盘上放着三套系统的令牌）
  #presentTokens(meta) {
    const found = [];
    const seen = new Set();
    const consider = (info) => {
      if (!info || seen.has(info.serial)) return;
      if (!meta.tokens.some((t) => t.serial === info.serial)) return;
      seen.add(info.serial);
      found.push(info);
    };
    if (this.boundTokenPath) consider(soft.readTokenInfo(this.boundTokenPath));
    // 只有"记录路径读不到"的令牌才需要全盘扫描；锁定页每 400ms 调一次本方法，
    // 每枚令牌都扫一遍挂载点会把轮询变成磁盘扫描（Windows 上尤其慢）。
    let discovered = null;
    const findBySerial = (serial) => {
      if (!discovered) discovered = provider.discover();
      return discovered.find((info) => info.serial === serial) || null;
    };
    for (const record of meta.tokens) {
      if (record.path) consider(soft.readTokenInfo(record.path));
      if (seen.has(record.serial)) continue;
      consider(findBySerial(record.serial));
    }
    return found;
  }

  // 优先挑"在场的免 PIN 令牌"，否则第一枚在场的
  #presentToken(meta) {
    const present = this.#presentTokens(meta);
    return present.find((info) => info.pinFree) || present[0] || null;
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
    const info = this.#presentToken(meta);
    return {
      present: Boolean(info),
      pinFree: Boolean(info && info.pinFree),
      locked: Boolean(info && info.locked),
      serial: info ? info.serial : meta.tokens[0].serial,
      tokenCount: meta.tokens.length,
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
    // 多枚令牌同时在场时，优先用免 PIN 的那枚自动解锁
    const present = this.#presentTokens(meta);
    return present.find((info) => info.pinFree) || null;
  }
}

module.exports = { Vault, VAULT_FILE, ENC_FILE, generateRecoveryCode, normalizeRecoveryCode };
