// 软件令牌（U盾的"原型替身"）：一个放在 U 盘里的 PIN 保护密钥文件。
//
// 设计目标：与将来的硬件 U盾（HID 令牌）保持**同一个接口**——
//   info() / open(pin) → session.hmac(challenge) / session.close()
// 硬件版把 secret 换成"永不出设备的 HMAC 密钥"，主机侧代码一行不用改。
//
// 文件结构（DocVault.key，JSON）：
//   secret（32 字节随机数）用 scrypt(PIN) 派生的密钥做 AES-256-GCM 包装；
//   没有 PIN 就拿不到 secret，也就派生不出数据密钥。
//
// 诚实的边界（README 里也写了）：
//   - secret 解锁后存在于本机内存，软件令牌防不了同权限的恶意软件；
//   - 尝试次数写在文件里，拿到文件的人可以重置——硬件版由芯片计数，无法重置；
//   - 文件可以被整份复制。它验证的是"持有令牌文件 + 知道 PIN"，
//     真正的"密钥不可复制"要等硬件令牌。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const drive = require('./drive');

const scrypt = promisify(crypto.scrypt);

const TOKEN_FILENAME = 'DocVault.key';
// 同一个目录里允许放多枚令牌（每套系统一枚，或主令牌 + 备用令牌），
// 发现层按这个模式扫描：DocVault.key / DocVault-mac.key / DocVault-win-2.key …
const TOKEN_PATTERN = /^DocVault[^/\\]*\.key$/i;

// 令牌在 U 盘上的位置。多系统各一枚时按系统分目录，一眼能看出哪枚属于哪套系统：
//   第一枚        <U盘>/DocVault.key
//   之后          <U盘>/mac/DocVault.key、<U盘>/win/DocVault.key、<U盘>/linux/DocVault.key
//   同系统第二枚  <U盘>/mac-2/DocVault.key
// 发现层本来就扫描挂载点下一层目录，所以分目录不需要额外配置。
function tokenRelativePath(dir) {
  if (!fs.existsSync(path.join(dir, TOKEN_FILENAME))) return TOKEN_FILENAME;
  const tag = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
  let folder = tag;
  let index = 2;
  while (fs.existsSync(path.join(dir, folder, TOKEN_FILENAME))) folder = `${tag}-${index++}`;
  return path.join(folder, TOKEN_FILENAME);
}
const TOKEN_TYPE = 'docvault-soft-token';
const MAX_ATTEMPTS = 8;
const PIN_MIN = 4;
const PIN_MAX = 16;
// scrypt 参数：解锁一次约几十毫秒，暴力猜 PIN 的成本被抬高
const KDF = { alg: 'scrypt', N: 16384, r: 8, p: 1 };
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function assertPin(pin) {
  if (typeof pin !== 'string' || pin.length < PIN_MIN || pin.length > PIN_MAX) {
    throw new Error(`PIN 需要 ${PIN_MIN}–${PIN_MAX} 位`);
  }
}

// ---------- AES-256-GCM（hex 字段，便于 JSON 存放） ----------

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

async function pinKey(pin, saltHex) {
  return scrypt(pin, Buffer.from(saltHex, 'hex'), 32, { ...KDF, maxmem: SCRYPT_MAXMEM });
}

// 原子写：U 盘随时可能被拔走，写一半的文件不能出现
function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readTokenFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (!raw || raw.type !== TOKEN_TYPE || raw.v !== 1) return null;
  if (typeof raw.serial !== 'string' || !raw.serial) return null;
  if (raw.pinFree === true) {
    // 免 PIN 物理钥匙：secret 明文存放，没有 kdf/wrappedSecret
    if (typeof raw.secret !== 'string' || !raw.secret) return null;
  } else if (!raw.kdf || !raw.wrappedSecret) {
    return null;
  }
  return raw;
}

// ---------- 对外 API ----------

// 在指定目录（通常是 U 盘根目录）创建一枚新令牌。
// options.pinFree=true：免 PIN 物理钥匙——secret 明文存于文件，"持有 U 盘=持有钥匙"。
// options.force=true：目标位置已有 DocVault.key 时覆盖它（旧令牌立即失效）。
async function createToken(dir, pin, options = {}) {
  const pinFree = options.pinFree === true;
  const force = options.force === true;
  if (!pinFree) assertPin(pin);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error('令牌目录不存在，请先把 U 盘插好');
  }
  const target = path.join(dir, TOKEN_FILENAME);
  const allowMultiple = options.allowMultiple === true;
  if (fs.existsSync(target) && !force && !allowMultiple) {
    throw new Error('这个位置已经有一枚令牌（DocVault.key）。继续会覆盖它，请确认后再试');
  }
  // allowMultiple：同一个目录里再放一枚（按平台命名，例如 DocVault-mac.key），
  // 用于"每套系统一枚令牌"共用同一个 U 盘。force 覆盖时仍然写 DocVault.key。
  const relative = force ? TOKEN_FILENAME : tokenRelativePath(dir);
  const file = path.join(dir, relative);
  if (!force) fs.mkdirSync(path.dirname(file), { recursive: true });
  // 绑定到"这张 U 盘"的卷序列号；识别不到时退化为不绑定（保持可用）
  const driveInfo = Object.hasOwn(options, 'drive') ? options.drive : drive.identify(file);

  const serial = crypto.randomBytes(8).toString('hex');
  const secret = crypto.randomBytes(32);
  const driveBinding = driveInfo ? { volumeSerial: driveInfo.volumeSerial } : null;
  let token;
  if (pinFree) {
    token = {
      v: 1,
      type: TOKEN_TYPE,
      serial,
      createdAt: Date.now(),
      pinFree: true,
      secret: secret.toString('hex'),
      ...(driveBinding ? { drive: driveBinding } : {}),
    };
  } else {
    const salt = crypto.randomBytes(16).toString('hex');
    const key = await pinKey(pin, salt);
    token = {
      v: 1,
      type: TOKEN_TYPE,
      serial,
      createdAt: Date.now(),
      kdf: { ...KDF, salt },
      wrappedSecret: seal(key, secret),
      attemptsLeft: MAX_ATTEMPTS,
      ...(driveBinding ? { drive: driveBinding } : {}),
    };
    key.fill(0);
  }
  secret.fill(0);
  writeJsonAtomic(file, token);
  return { path: file, serial, pinFree, drive: driveBinding };
}

// 只读元信息（不碰 secret），用于发现/展示
function readTokenInfo(file) {
  try {
    const raw = readTokenFile(file);
    if (!raw) return null;
    const pinFree = raw.pinFree === true;
    const attempts = Number.isFinite(raw.attemptsLeft) ? raw.attemptsLeft : MAX_ATTEMPTS;
    return {
      path: file,
      type: 'soft',
      serial: raw.serial,
      pinFree,
      boundDrive: raw.drive && raw.drive.volumeSerial ? raw.drive.volumeSerial : null,
      attemptsLeft: pinFree ? MAX_ATTEMPTS : attempts,
      locked: pinFree ? false : attempts <= 0,
      createdAt: raw.createdAt || 0,
    };
  } catch {
    return null;
  }
}

// 由 secret 构造会话（HMAC 应答 + close 清零），PIN / 免 PIN 两种令牌共用
function makeSession(serial, secret, pinFree, driveId = null) {
  let closed = false;
  return {
    type: 'soft',
    serial,
    pinFree,
    driveId,
    // 与硬件 U盾的 HMAC 命令同形：challenge → 32 字节应答
    hmac(challenge) {
      if (closed) throw new Error('令牌会话已关闭');
      const input = Buffer.isBuffer(challenge) ? challenge : Buffer.from(challenge);
      return crypto.createHmac('sha256', secret).update(input).digest();
    },
    close() {
      if (!closed) {
        secret.fill(0);
        closed = true;
      }
    },
  };
}

// 校验 PIN 并打开会话。成功后 secret 只在内存里，close() 时清零。
// 失败会扣减文件里的尝试次数；扣到 0 令牌自锁（只能走恢复码）。
// 免 PIN 令牌（pinFree）不需要 PIN，直接打开。
async function openToken(file, pin) {
  const raw = readTokenFile(file);
  if (!raw) throw new Error('令牌文件无效或已损坏');

  // U 盘绑定：令牌记录的卷序列号必须与当前所在盘一致。
  // 把 DocVault.key 拷到另一张 U 盘、或把盘符挂到别的设备上，这里就会拒绝。
  const bound = raw.drive && raw.drive.volumeSerial;
  if (bound) {
    const current = drive.identify(file);
    if (!current || current.volumeSerial !== bound) {
      throw new Error('这枚令牌与当前 U 盘不匹配（U 盘编码不一致），可能是从别的 U 盘复制来的');
    }
  }

  if (raw.pinFree === true) {
    const secret = Buffer.from(raw.secret, 'hex');
    if (secret.length !== 32) throw new Error('免 PIN 令牌的密钥无效');
    return makeSession(raw.serial, secret, true, bound || null);
  }

  assertPin(pin);
  const attempts = Number.isFinite(raw.attemptsLeft) ? raw.attemptsLeft : MAX_ATTEMPTS;
  if (attempts <= 0) throw new Error('令牌已锁定（PIN 错误次数过多），请用恢复码解锁并绑定新令牌');

  const key = await pinKey(pin, raw.kdf.salt);
  let secret;
  try {
    secret = unseal(key, raw.wrappedSecret);
  } catch {
    key.fill(0);
    const left = attempts - 1;
    try {
      raw.attemptsLeft = left;
      writeJsonAtomic(file, raw);
    } catch {
      /* U 盘被拔走等场景：次数写不回去，本次拒绝仍然生效 */
    }
    throw new Error(left > 0 ? `PIN 不正确，还可尝试 ${left} 次` : 'PIN 错误次数过多，令牌已锁定');
  }
  key.fill(0);

  // PIN 正确：把尝试次数补满
  if (attempts !== MAX_ATTEMPTS) {
    try {
      raw.attemptsLeft = MAX_ATTEMPTS;
      writeJsonAtomic(file, raw);
    } catch {
      /* 忽略 */
    }
  }

  return makeSession(raw.serial, secret, false, bound || null);
}

// 给旧令牌补上 U 盘绑定（迁移用）：成功返回卷序列号，失败返回 null。
// 只在令牌文件里还没有 drive 字段时写入一次。
function bindDrive(file) {
  try {
    const raw = readTokenFile(file);
    if (!raw) return null;
    if (raw.drive && raw.drive.volumeSerial) return raw.drive.volumeSerial;
    const info = drive.identify(file);
    if (!info || !info.volumeSerial) return null;
    raw.drive = { volumeSerial: info.volumeSerial };
    writeJsonAtomic(file, raw);
    return info.volumeSerial;
  } catch {
    return null;
  }
}

module.exports = {
  TOKEN_FILENAME,
  TOKEN_PATTERN,
  tokenRelativePath,
  TOKEN_TYPE,
  MAX_ATTEMPTS,
  createToken,
  readTokenInfo,
  openToken,
  bindDrive,
};
