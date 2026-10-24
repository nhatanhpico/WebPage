#!/usr/bin/env node
// Quản lý tài khoản: nhiều tài khoản, cùng một không gian. src/account.js chỉ chứa salt + giá trị kiểm tra
// + bản mã hoá — KHÔNG có mật khẩu, tên chỉ thành viên mới giải mã được.
//   npm run account            menu
//   npm run account:add        thêm tài khoản (tài khoản đầu tiên tạo luôn không gian)
//   npm run account:change     đổi tên / mật khẩu của tài khoản mình
//   npm run account:delete     xoá một tài khoản
//   npm run account:list       danh sách tài khoản
//   npm run account:status     trạng thái
//   npm run account:reset      xoá hết, tạo lại từ đầu (khi quên mọi mật khẩu)
// Cờ: --no-push (chỉ ghi file)
// Chạy không hỏi (thử nghiệm): SPACE_AUTH_USER/SPACE_AUTH_PASS = tài khoản đang có, SPACE_USER/SPACE_PASS = mới,
// SPACE_TARGET = tên cần xoá, SPACE_CONFIRM=yes|no
import { writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import readline from 'node:readline'
import { ITERATIONS, randomB64 } from '../src/crypto.js'
import { isV2, login, nameOf, makeEntry } from '../src/accounts.js'

const OUT = fileURLToPath(new URL('../src/account.js', import.meta.url))
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const flag = f => args.includes(f)
const env = process.env
const MIN_LEN = 10
const MAX_TRIES = 3

function ask(question, hidden = false) {
  if (!process.stdin.isTTY) fail('Run this in a terminal (Terminal / iTerm), not through a pipe.')
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    if (hidden) {
      // không in ký tự mật khẩu ra màn hình
      rl._writeToOutput = s => {
        if (s.startsWith(question)) rl.output.write(question)
      }
    }
    rl.question(question, answer => {
      rl.close()
      if (hidden) process.stdout.write('\n')
      resolve(answer)
    })
    rl.on('SIGINT', () => {
      process.stdout.write('\nCancelled, nothing written.\n')
      process.exit(130)
    })
  })
}

function fail(msg) {
  console.error('✘ ' + msg)
  process.exit(1)
}

async function load() {
  if (!existsSync(OUT)) return null
  const mod = await import(pathToFileURL(OUT).href + '?t=' + Date.now())
  return mod.default || null
}

function write(account) {
  const body = account
    ? `// Tạo bởi \`npm run account\` — salt + giá trị kiểm tra + bản mã hoá, không chứa mật khẩu. Đừng sửa tay.
export default ${JSON.stringify(account, null, 2)}
`
    : `// Chưa có tài khoản — chạy \`npm run account:add\` để tạo (file này được ghi lại tự động)
export default null
`
  writeFileSync(OUT, body)
}

async function confirm(question) {
  if (env.SPACE_CONFIRM) return env.SPACE_CONFIRM === 'yes'
  return /^y(es)?$/i.test((await ask(question)).trim())
}

// Đăng nhập bằng một tài khoản đang có → mở được không gian (cần để thêm / xoá / đổi)
async function signIn(account, prompt) {
  if (env.SPACE_AUTH_USER && env.SPACE_AUTH_PASS) {
    const r = await login(account, env.SPACE_AUTH_USER, env.SPACE_AUTH_PASS)
    if (!r) fail('Account or password is incorrect.')
    return { ...r, pass: env.SPACE_AUTH_PASS }
  }
  console.log(prompt + '\n')
  for (let i = 1; i <= MAX_TRIES; i++) {
    const user = (await ask('  Account: ')).trim()
    const pass = await ask('  Password: ', true)
    process.stdout.write('  Checking… ')
    const r = await login(account, user, pass)
    if (r) {
      console.log(`✔ signed in as ${r.name}\n`)
      return { ...r, pass }
    }
    console.log(`✘ incorrect${i < MAX_TRIES ? ', try again' : ''}\n`)
  }
  fail('Too many wrong attempts. If every password is lost, run: npm run account:reset')
}

async function names(account, keys) {
  return Promise.all(account.users.map(u => nameOf(keys, u)))
}

function validName(user, taken) {
  if (!user) fail('Account name cannot be empty.')
  if (user.length > 32) fail('Account name is too long (max 32 characters).')
  if (/[\u0000-\u001f<>]/.test(user)) fail('Account name contains characters that are not allowed.')
  if (taken.some(n => n.toLowerCase() === user.toLowerCase())) fail(`An account named "${user}" already exists.`)
}

function validPass(pass) {
  if (pass.length < MIN_LEN) {
    fail(`Use at least ${MIN_LEN} characters — the check value is public, so a weak password can be guessed offline.`)
  }
}

async function askNewPassword(label = 'Password') {
  const pass = await ask(`  ${label}: `, true)
  if (!pass) return ''
  const again = await ask('  Repeat password: ', true)
  if (pass !== again) fail('Passwords do not match, nothing written.')
  return pass
}

// Commit chỉ src/account.js với message chung chung (không lộ tên tài khoản), rồi push
async function publish(message) {
  const later = () => {
    console.log('  To publish later: git add src/account.js && git commit -m "Update accounts" && git push')
  }
  if (flag('--no-push')) return later()
  const yes = env.SPACE_CONFIRM ? env.SPACE_CONFIRM === 'yes' : !/^n(o)?$/i.test((await ask('Publish now (commit + push)? [Y/n] ')).trim())
  if (!yes) return later()
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
  try {
    git('add', 'src/account.js')
    if (!git('diff', '--cached', '--name-only', '--', 'src/account.js').trim()) {
      console.log('  Nothing to commit (already published).')
      return
    }
    git('commit', '-m', message, '--', 'src/account.js')
    process.stdout.write('  Pushing… ')
    git('push')
    console.log('✔ done. The site updates in about a minute.')
  } catch (err) {
    console.log('')
    fail('git failed: ' + (err.stderr?.toString().trim() || err.message) +
      '\n  Publish manually: git add src/account.js && git commit -m "Update accounts" && git push')
  }
}

/* ================= LỆNH ================= */
async function add() {
  let account = await load()
  let space
  let taken = []
  if (isV2(account)) {
    const me = await signIn(account, 'Adding an account needs an existing account to unlock the space.')
    space = me.space
    taken = await names(account, me.keys)
  } else {
    if (account) console.log('! Found the old single-account format; it is replaced by the new multi-account setup.\n')
    console.log('Creating the first account (this also creates the shared space).\n')
    account = { v: 2, iterations: ITERATIONS, salt: randomB64(16), users: [] }
    space = globalThis.crypto.getRandomValues(new Uint8Array(32))
  }
  let user = env.SPACE_USER
  let pass = env.SPACE_PASS
  if (!user || !pass) {
    console.log('New account:')
    user = await ask('  Account name (also shown on notes): ')
    pass = await askNewPassword()
  }
  user = user.trim()
  validName(user, taken)
  validPass(pass)
  account.users.push(await makeEntry(account, space, user, pass))
  account.updated = new Date().toISOString().slice(0, 10)
  write(account)
  console.log(`✔ Account "${user}" added (${account.users.length} account${account.users.length > 1 ? 's' : ''} in total).`)
  await publish('Update accounts')
}

async function change() {
  const account = await load()
  if (!isV2(account)) fail('No accounts yet. Create one with: npm run account:add')
  const me = await signIn(account, 'Sign in with the account you want to change.')
  const taken = (await names(account, me.keys)).filter((_, i) => i !== me.index)
  let user = env.SPACE_USER
  let pass = env.SPACE_PASS
  if (!user || !pass) {
    user = (await ask(`  New account name (Enter to keep "${me.name}"): `)).trim() || me.name
    pass = (await askNewPassword('New password (Enter to keep the current one)')) || me.pass
  }
  user = user.trim()
  validName(user, taken)
  validPass(pass)
  if (user === me.name && pass === me.pass) {
    console.log('Nothing changed.')
    return
  }
  account.users[me.index] = await makeEntry(account, me.space, user, pass)
  account.updated = new Date().toISOString().slice(0, 10)
  write(account)
  console.log(`✔ Account updated${user !== me.name ? `: "${me.name}" → "${user}"` : ''}.`)
  console.log('  Devices signed in with this account will be signed out once published.')
  await publish('Update accounts')
}

async function remove() {
  const account = await load()
  if (!isV2(account)) fail('There are no accounts to delete.')
  const me = await signIn(account, 'Sign in with any account to manage accounts.')
  const all = await names(account, me.keys)
  let index
  if (env.SPACE_TARGET) {
    index = all.findIndex(n => n.toLowerCase() === env.SPACE_TARGET.trim().toLowerCase())
    if (index < 0) fail(`No account named "${env.SPACE_TARGET}".`)
  } else {
    console.log('Accounts:')
    all.forEach((n, i) => console.log(`  ${i + 1}) ${n}${i === me.index ? '  (you)' : ''}`))
    index = parseInt((await ask('\nDelete which account? (number, Enter to cancel) ')).trim(), 10) - 1
    if (!(index >= 0 && index < all.length)) {
      console.log('Cancelled, nothing written.')
      return
    }
  }
  const last = account.users.length === 1
  if (last) console.log('\n! This is the last account: after publishing nobody can sign in until you add a new one.')
  if (!(await confirm(`Type "yes" to delete "${all[index]}": `))) {
    console.log('Cancelled, nothing written.')
    return
  }
  account.users.splice(index, 1)
  account.updated = new Date().toISOString().slice(0, 10)
  write(account.users.length ? account : null)
  console.log(`✔ Account "${all[index]}" deleted. Its devices are signed out the next time they open the site.`)
  await publish('Update accounts')
}

async function list() {
  const account = await load()
  if (!isV2(account)) fail('No accounts yet. Create one with: npm run account:add')
  const me = await signIn(account, 'Names are encrypted — sign in with any account to see them.')
  const all = await names(account, me.keys)
  console.log(`${all.length} account${all.length > 1 ? 's' : ''}:`)
  all.forEach((n, i) => console.log(`  • ${n}${i === me.index ? '  (you)' : ''}`))
}

async function status() {
  const account = await load()
  if (!isV2(account)) {
    console.log(account ? '! Old single-account format. Run npm run account:add to set up accounts again.'
      : 'No accounts yet. Create one with: npm run account:add')
    return
  }
  console.log(`✔ ${account.users.length} account${account.users.length > 1 ? 's' : ''} set up.`)
  if (account.updated) console.log('  Last changed: ' + account.updated)
  console.log(`  Key derivation: PBKDF2-SHA256, ${account.iterations.toLocaleString('en-US')} iterations`)
  console.log('  Names are encrypted; see them with npm run account:list')
  try {
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src/account.js'], { cwd: ROOT }).toString().trim()
    console.log(dirty ? '  ! Local change not published yet (git push needed).' : '  Published: yes (matches the last commit).')
  } catch { /* không phải repo git */ }
}

async function reset() {
  console.log('Reset: deletes EVERY account. Use this only if all passwords are lost.')
  console.log('After publishing nobody can sign in until you run npm run account:add.\n')
  if (!(await confirm('Type "yes" to delete all accounts: '))) {
    console.log('Cancelled, nothing written.')
    return
  }
  write(null)
  console.log('✔ All accounts deleted.')
  await publish('Update accounts')
}

async function menu() {
  const account = await load()
  const has = isV2(account)
  const items = has
    ? [['Add an account', add], ['Change my account name / password', change], ['Delete an account', remove],
      ['List accounts', list], ['Status', status], ['Reset everything (lost all passwords)', reset]]
    : [['Create the first account', add], ['Status', status]]
  console.log('Shared Notes · accounts\n')
  items.forEach(([label], i) => console.log(`  ${i + 1}) ${label}`))
  console.log('  q) Quit\n')
  const choice = items[parseInt((await ask('Choose: ')).trim(), 10) - 1]
  console.log('')
  if (choice) return choice[1]()
}

const cmd = args.find(a => !a.startsWith('--'))
const commands = { add, change, delete: remove, list, status, reset }
if (cmd && !commands[cmd]) fail(`Unknown command "${cmd}". Use: ${Object.keys(commands).join(', ')}`)
await (cmd ? commands[cmd]() : menu())
