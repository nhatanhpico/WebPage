#!/usr/bin/env node
// Quản lý tài khoản duy nhất của trang: src/account.js chỉ chứa salt + giá trị kiểm tra, KHÔNG có mật khẩu / tên
//   npm run account                 menu
//   npm run account:change          tạo / đổi tên tài khoản / mật khẩu
//   npm run account:delete          xoá tài khoản (trang bị khoá với mọi người)
//   npm run account:status          xem trạng thái
// Cờ: --force (quên mật khẩu: bỏ qua bước xác minh), --no-push (chỉ ghi file, không commit/push)
// Chạy không hỏi (thử nghiệm): SPACE_CUR_USER/SPACE_CUR_PASS = hiện tại, SPACE_USER/SPACE_PASS = mới, SPACE_CONFIRM=yes
import { writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import readline from 'node:readline'
import { ITERATIONS, deriveMaster, verifierOf, randomB64 } from '../src/crypto.js'

const OUT = fileURLToPath(new URL('../src/account.js', import.meta.url))
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const flag = f => args.includes(f)
const env = process.env
const MIN_LEN = 10
const MAX_TRIES = 3

function ask(question, hidden = false) {
  if (!process.stdin.isTTY) {
    console.error('✘ Run this in a terminal (Terminal / iTerm), not through a pipe.')
    process.exit(1)
  }
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

const fail = msg => {
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
    ? `// Tạo bởi \`npm run account\` — salt + giá trị kiểm tra, không chứa mật khẩu. Đừng sửa tay.
export default ${JSON.stringify(account, null, 2)}
`
    : `// Chưa có tài khoản — chạy \`npm run account\` để tạo (file này được ghi lại tự động)
export default null
`
  writeFileSync(OUT, body)
}

async function check(account, user, pass) {
  const master = await deriveMaster(user, pass, account.salt, account.iterations)
  return (await verifierOf(master)) === account.verify
}

// Xác minh tài khoản hiện tại trước khi đổi / xoá → trả về tên đã gõ (để gợi ý giữ nguyên)
async function verifyCurrent(account) {
  if (flag('--force')) {
    console.log('! --force: skipping the current password check.\n')
    return null
  }
  if (env.SPACE_CUR_USER && env.SPACE_CUR_PASS) {
    if (await check(account, env.SPACE_CUR_USER, env.SPACE_CUR_PASS)) return { user: env.SPACE_CUR_USER.trim(), pass: env.SPACE_CUR_PASS }
    fail('Current account or password is incorrect.')
  }
  for (let i = 1; i <= MAX_TRIES; i++) {
    const user = (await ask('Current account: ')).trim()
    const pass = await ask('Current password: ', true)
    process.stdout.write('Checking… ')
    if (await check(account, user, pass)) {
      console.log('✔\n')
      return { user, pass }
    }
    console.log(`✘ incorrect${i < MAX_TRIES ? ', try again' : ''}\n`)
  }
  fail('Too many wrong attempts. Forgot the password? Run: npm run account:change -- --force')
}

async function newCredentials(current) {
  if (env.SPACE_USER && env.SPACE_PASS) return { user: env.SPACE_USER.trim(), pass: env.SPACE_PASS }
  const keepUser = current?.user
  let user = (await ask(keepUser ? `New account (Enter to keep "${keepUser}"): ` : 'Account: ')).trim()
  if (!user) user = keepUser || ''
  if (!user) fail('Account cannot be empty.')

  let pass = await ask(current ? 'New password (Enter to keep the current one): ' : 'Password: ', true)
  if (!pass && current) return { user, pass: current.pass }
  const again = await ask('Repeat password: ', true)
  if (pass !== again) fail('Passwords do not match, nothing written.')
  return { user, pass }
}

async function confirm(question) {
  if (env.SPACE_CONFIRM) return env.SPACE_CONFIRM === 'yes'
  return /^y(es)?$/i.test((await ask(question)).trim())
}

// Commit chỉ src/account.js với message chung chung (không lộ tên tài khoản), rồi push
async function publish(message) {
  if (flag('--no-push')) {
    console.log('  Not published (--no-push). To publish later:')
    console.log('  git add src/account.js && git commit -m "Update account" && git push')
    return
  }
  const yes = env.SPACE_CONFIRM ? env.SPACE_CONFIRM === 'yes' : !/^n(o)?$/i.test((await ask('Publish now (commit + push)? [Y/n] ')).trim())
  if (!yes) {
    console.log('  Not published. To publish later:')
    console.log('  git add src/account.js && git commit -m "Update account" && git push')
    return
  }
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
  try {
    git('add', 'src/account.js')
    if (!git('diff', '--cached', '--name-only', '--', 'src/account.js').trim()) {
      console.log('  Nothing to commit (file already published).')
      return
    }
    git('commit', '-m', message, '--', 'src/account.js')
    process.stdout.write('  Pushing… ')
    git('push')
    console.log('✔ done. The site updates in about a minute.')
  } catch (err) {
    console.log('')
    fail('git failed: ' + (err.stderr?.toString().trim() || err.message) +
      '\n  Publish manually: git add src/account.js && git commit -m "Update account" && git push')
  }
}

async function change() {
  const account = await load()
  console.log(account ? 'Change account name / password\n' : 'Create the account for Shared Notes\n')
  const current = account ? await verifyCurrent(account) : null
  const { user, pass } = await newCredentials(current)
  if (pass.length < MIN_LEN) {
    fail(`Use at least ${MIN_LEN} characters — the check value is public, so a weak password can be guessed offline.`)
  }
  if (current && user.toLowerCase() === current.user.toLowerCase() && pass === current.pass) {
    console.log('Nothing changed.')
    return
  }
  const salt = randomB64(16)
  const verify = await verifierOf(await deriveMaster(user, pass, salt, ITERATIONS))
  write({ v: 1, iterations: ITERATIONS, salt, verify, updated: new Date().toISOString().slice(0, 10) })
  console.log(`✔ Account ${account ? 'updated' : 'created'} in src/account.js`)
  console.log('  Once published, every device is signed out and must sign in with the new details.')
  await publish(account ? 'Update account' : 'Set account')
}

async function remove() {
  const account = await load()
  if (!account) {
    console.log('There is no account to delete.')
    return
  }
  console.log('Delete the account\n')
  console.log('  After publishing, nobody can sign in, every device is signed out, and the site shows')
  console.log('  "No account has been set up yet" until you create a new one.\n')
  await verifyCurrent(account)
  if (!(await confirm('Type "yes" to delete the account: '))) {
    console.log('Cancelled, nothing written.')
    return
  }
  write(null)
  console.log('✔ Account deleted from src/account.js')
  await publish('Remove account')
}

async function status() {
  const account = await load()
  if (!account) {
    console.log('No account yet. Create one with: npm run account:change')
    return
  }
  console.log('✔ An account is set.')
  if (account.updated) console.log('  Last changed: ' + account.updated)
  console.log(`  Key derivation: PBKDF2-SHA256, ${account.iterations.toLocaleString('en-US')} iterations`)
  console.log('  The account name and password are not stored anywhere, so they cannot be shown.')
  try {
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src/account.js'], { cwd: ROOT }).toString().trim()
    console.log(dirty ? '  ! Local change not published yet (git push needed).' : '  Published: yes (matches the last commit).')
  } catch { /* không phải repo git */ }
}

async function menu() {
  const account = await load()
  const items = [
    [account ? 'Change account name / password' : 'Create account', change],
    ...(account ? [['Delete account', remove]] : []),
    ['Status', status],
  ]
  console.log('Shared Notes · account\n')
  items.forEach(([label], i) => console.log(`  ${i + 1}) ${label}`))
  console.log('  q) Quit\n')
  const choice = items[parseInt((await ask('Choose: ')).trim(), 10) - 1]
  console.log('')
  if (choice) return choice[1]()
}

const cmd = args.find(a => !a.startsWith('--'))
const commands = { change, delete: remove, status }
if (cmd && !commands[cmd]) fail(`Unknown command "${cmd}". Use: change, delete, status`)
await (cmd ? commands[cmd]() : menu())
