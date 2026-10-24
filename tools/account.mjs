#!/usr/bin/env node
// Tạo / đổi tài khoản duy nhất của trang: ghi src/account.js (salt + giá trị kiểm tra, KHÔNG có mật khẩu)
// Dùng: npm run account   (hoặc SPACE_USER=… SPACE_PASS=… npm run account để chạy không hỏi)
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'
import { ITERATIONS, deriveMaster, verifierOf, randomB64 } from '../src/crypto.js'

const OUT = fileURLToPath(new URL('../src/account.js', import.meta.url))

function ask(question, hidden = false) {
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

async function main() {
  let user = process.env.SPACE_USER
  let pass = process.env.SPACE_PASS
  if (!user || !pass) {
    if (!process.stdin.isTTY) {
      console.error('Run this in a terminal (or set SPACE_USER and SPACE_PASS).')
      process.exit(1)
    }
    console.log('Set the account for Shared Notes. The password is never saved anywhere.\n')
    user = (await ask('Account: ')).trim()
    pass = await ask('Password: ', true)
    const again = await ask('Repeat password: ', true)
    if (pass !== again) {
      console.error('✘ Passwords do not match, nothing written.')
      process.exit(1)
    }
  }
  if (!user) {
    console.error('✘ Account cannot be empty.')
    process.exit(1)
  }
  if (pass.length < 10) {
    console.error('✘ Use at least 10 characters — the check value is public, so a weak password can be guessed offline.')
    process.exit(1)
  }

  const salt = randomB64(16)
  const verify = await verifierOf(await deriveMaster(user, pass, salt, ITERATIONS))
  const body = `// Tạo bởi \`npm run account\` — salt + giá trị kiểm tra, không chứa mật khẩu. Đừng sửa tay.
export default ${JSON.stringify({ v: 1, iterations: ITERATIONS, salt, verify }, null, 2)}
`
  writeFileSync(OUT, body)
  console.log('✔ Account saved to src/account.js')
  console.log('  Devices that were signed in with an older password will be signed out.')
  console.log('  Next: git add src/account.js && git commit -m "Update account" && git push')
}

main()
