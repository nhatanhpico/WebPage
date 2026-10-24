// Nhiều tài khoản, một không gian chung. src/account.js (công khai) có dạng:
//   { v: 2, iterations, salt, users: [{ verify, wrap, label }] }
// - salt chung → đăng nhập chỉ cần MỘT lần PBKDF2 dù có bao nhiêu tài khoản
// - verify: giá trị kiểm tra của tài khoản (không suy ra được mật khẩu nếu mật khẩu đủ mạnh)
// - wrap:   khoá chung của không gian, mã hoá bằng khoá riêng của tài khoản
// - label:  tên hiển thị, mã hoá bằng khoá của không gian → chỉ thành viên mới đọc được
// Dùng chung cho trình duyệt (main.js) và tools/account.mjs
import { deriveMaster, verifierOf, wrapKeyOf, sessionKeys, seal, unseal, b64, unb64 } from './crypto.js'

export const isV2 = a => !!a && a.v === 2 && Array.isArray(a.users) && a.users.length > 0

// Mở không gian bằng khoá gốc của một tài khoản; sai → null
export async function openWith(account, master) {
  if (!isV2(account)) return null
  const verify = await verifierOf(master)
  const index = account.users.findIndex(u => u.verify === verify)
  if (index < 0) return null
  const entry = account.users[index]
  const space = unb64((await unseal(await wrapKeyOf(master), unb64(entry.wrap))).s)
  const keys = await sessionKeys(space)
  const name = await nameOf(keys, entry)
  return { index, space, keys, name }
}

export async function login(account, user, pass) {
  const master = await deriveMaster(user, pass, account.salt, account.iterations)
  const opened = await openWith(account, master)
  return opened && { ...opened, master }
}

export async function nameOf(keys, entry) {
  return (await unseal(keys.labelKey, unb64(entry.label))).n
}

// Tạo mục cho một tài khoản (tên đăng nhập không phân biệt hoa thường; tên hiển thị giữ nguyên như đã gõ)
export async function makeEntry(account, space, user, pass) {
  const master = await deriveMaster(user, pass, account.salt, account.iterations)
  const keys = await sessionKeys(space)
  return {
    verify: await verifierOf(master),
    wrap: b64(await seal(await wrapKeyOf(master), { s: b64(space) })),
    label: b64(await seal(keys.labelKey, { n: user.trim() })),
  }
}
