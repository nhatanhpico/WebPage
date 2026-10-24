// Mã hoá dùng chung cho trình duyệt và tools/account.mjs — chỉ dùng Web Crypto, không thư viện
const subtle = globalThis.crypto.subtle
const enc = new TextEncoder()
const dec = new TextDecoder()

export const ITERATIONS = 600000

export function b64(bytes) {
  const u = new Uint8Array(bytes)
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}

export const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0))
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
export const randomB64 = n => b64(globalThis.crypto.getRandomValues(new Uint8Array(n)))

// Khoá gốc = PBKDF2(account + "\n" + password) — mật khẩu không bao giờ được lưu
export async function deriveMaster(user, pass, salt, iterations = ITERATIONS) {
  const base = await subtle.importKey('raw', enc.encode(user.trim().toLowerCase() + '\n' + pass), 'PBKDF2', false, ['deriveBits'])
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations }, base, 256)
  return new Uint8Array(bits)
}

// Mỗi mục đích một khoá con riêng (HKDF), lộ cái này không suy ra được cái kia
async function hkdf(master, info) {
  const k = await subtle.importKey('raw', master, 'HKDF', false, ['deriveBits'])
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('couple-space/' + info) }, k, 256)
  return new Uint8Array(bits)
}

// Giá trị kiểm tra công khai trong src/account.js: biết đăng nhập đúng hay sai mà không lộ khoá
export async function verifierOf(master) {
  return hex(await hkdf(master, 'verify'))
}

export async function sessionKeys(master) {
  const [room, sdp, auth, msg] = await Promise.all(['room', 'sdp', 'auth', 'msg'].map(i => hkdf(master, i)))
  return {
    roomId: hex(room).slice(0, 32),
    sdpPassword: b64(sdp),
    authKey: await subtle.importKey('raw', auth, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']),
    msgKey: await subtle.importKey('raw', msg, 'AES-GCM', false, ['encrypt', 'decrypt']),
  }
}

// Gói tin: iv (12 byte) ‖ AES-GCM(JSON)
export async function seal(key, obj) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv)
  out.set(ct, 12)
  return out
}

export async function unseal(key, data) {
  const u = new Uint8Array(data)
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12) }, key, u.subarray(12))
  return JSON.parse(dec.decode(pt))
}

export async function sign(key, text) {
  return b64(await subtle.sign('HMAC', key, enc.encode(text)))
}

export function verifySig(key, sig, text) {
  return subtle.verify('HMAC', key, unb64(sig), enc.encode(text))
}
