#!/usr/bin/env node
// Bot trả lời tự động cho Shared Notes: đăng nhập trang bằng một tài khoản, đợi tin mới, gửi cho
// Claude Code / Antigravity CLI, rồi gửi câu trả lời bằng chính tài khoản đó.
//   npm run bot               chạy (lần đầu hỏi tài khoản + mật khẩu; trang chỉ lưu khoá đã dẫn xuất)
//   npm run bot:setup         đổi link, AI, cuộc hội thoại (mới / có sẵn), giữ lịch sử, tiền tố, chỉ dẫn
//   npm run bot:url -- <link> đổi link trang
//   npm run bot:new           lượt sau bắt đầu cuộc hội thoại mới
//   npm run bot:login | bot:logout | bot:status | bot:check
// Cờ khi chạy: --show (hiện cửa sổ Chrome), --answer-last (trả lời luôn tin mới nhất của tài khoản khác đang có)
// Không hỏi (thử nghiệm): SHARED_NOTES_BOT_USER / SHARED_NOTES_BOT_PASS, SHARED_NOTES_BOT_HOME
import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import { HOME, PROVIDERS, load, save, checkUrl, ensureHome, isUuid } from './config.mjs'
import { ask as askAI, sessions, check } from './llm.mjs'
import * as site from './site.mjs'

const args = process.argv.slice(2)
const cmd = args.find(a => !a.startsWith('--')) || 'start'
const flag = f => args.includes(f)
const MAX_POST = 4500 // trang cắt tin ở 5000 ký tự

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a)
function fail(msg) {
  console.error('✘ ' + msg)
  process.exit(1)
}

// Một readline dùng chung cho cả lượt hỏi: tạo mới mỗi câu sẽ làm mất các dòng đã gõ/dán trước
let rl = null, write = null
function ask(question, { hidden = false, def = '' } = {}) {
  if (!process.stdin.isTTY) fail('Run this in a terminal (Terminal / iTerm), not through a pipe.')
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    write = rl._writeToOutput.bind(rl)
    rl.on('SIGINT', () => {
      process.stdout.write('\nCancelled, nothing changed.\n')
      process.exit(130)
    })
  }
  const q = question + (def ? ` [${def}]` : '') + ': '
  return new Promise(resolve => {
    rl._writeToOutput = hidden ? s => { if (s.startsWith(q)) write(q) } : write // không in mật khẩu
    rl.question(q, a => {
      rl._writeToOutput = write
      if (hidden) process.stdout.write('\n')
      resolve(a.trim() || def)
    })
  })
}

function doneAsking() {
  rl?.close()
  rl = null
}

async function choose(question, options, current) {
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}${o.value === current ? '  (current)' : ''}`))
  const def = String(Math.max(1, options.findIndex(o => o.value === current) + 1))
  for (;;) {
    const a = await ask(question, { def })
    const o = options[+a - 1]
    if (o) return o.value
    console.log('  Pick a number from the list.')
  }
}

const yes = async (q, def) => /^y/i.test(await ask(q + ' (y/n)', { def: def ? 'y' : 'n' }))

function describe(cfg) {
  const p = cfg[cfg.provider]
  const chat = p.mode === 'existing' ? `continue ${p.sessionId}` : 'new conversation'
  return [
    `Link:          ${cfg.url}`,
    `AI:            ${PROVIDERS[cfg.provider]} (${p.path})`,
    `Conversation:  ${chat}${cfg.keepHistory ? ', keep history' : ', no history between replies'}`,
    `Answers:       ${cfg.trigger ? `messages starting with "${cfg.trigger}"` : 'every new message'}${cfg.answerOwnAccount ? '' : ' from other accounts'}, sent as ${cfg.format === 'md' ? 'Markdown' : 'plain text'}`,
    `Extra prompt:  ${cfg.prompt || '(none)'}`,
  ].join('\n')
}

/* ================= LỆNH ================= */
async function setup() {
  const cfg = load()
  console.log('Shared Notes bot settings. Press Enter to keep the current value.\n')
  for (;;) {
    try {
      cfg.url = checkUrl(await ask('Site link', { def: cfg.url }))
      break
    } catch (e) {
      console.log('  ' + e.message)
    }
  }
  console.log('\nAI:')
  cfg.provider = await choose('AI', Object.entries(PROVIDERS).map(([value, label]) => ({ value, label })), cfg.provider)
  await pickConversation(cfg)
  cfg.keepHistory = await yes('\nKeep history (each reply continues the same conversation)?', cfg.keepHistory)
  cfg.trigger = (await ask('\nOnly answer messages starting with (Enter = answer every message, "-" = clear)', { def: cfg.trigger })).replace(/^-$/, '')
  cfg.answerOwnAccount = await yes('Also answer messages from this same account on other devices?', cfg.answerOwnAccount)
  cfg.format = await choose('\nSend answers as', [{ value: 'md', label: 'Markdown (code blocks, lists, bold)' }, { value: 'plain', label: 'Plain text' }], cfg.format)
  cfg.prompt = (await ask('\nExtra instructions for the AI (Enter = keep, "-" = none)', { def: cfg.prompt })).replace(/^-$/, '')
  doneAsking()
  save(cfg)
  console.log('\n✔ Saved.\n\n' + describe(cfg))
}

async function pickConversation(cfg) {
  const p = cfg[cfg.provider]
  console.log(`\nConversation for ${PROVIDERS[cfg.provider]}:`)
  const mode = await choose('Conversation', [
    { value: 'new', label: 'Start a new conversation' },
    { value: 'existing', label: 'Continue an existing conversation' },
  ], p.mode)
  if (mode === 'new') {
    p.mode = 'new'
    p.sessionId = ''
    return
  }
  const list = await sessions(cfg.provider, 15)
  if (list.length) {
    console.log('\nRecent conversations:')
    list.forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}) ${new Date(s.modified).toLocaleString()}  ${s.title}`))
  } else console.log('  No recent conversations found.')
  for (;;) {
    const a = await ask('Number from the list, or paste a conversation ID', { def: p.mode === 'existing' ? p.sessionId : '' })
    const id = list[+a - 1]?.id || a
    if (isUuid(id)) {
      p.mode = 'existing'
      p.sessionId = id.toLowerCase()
      return
    }
    console.log('  That is not a number from the list or a conversation ID.')
  }
}

function setUrl() {
  const url = args.filter(a => !a.startsWith('--'))[1]
  if (!url) fail('Usage: npm run bot:url -- https://your-site/')
  const cfg = load()
  try {
    cfg.url = checkUrl(url)
  } catch (e) {
    fail(e.message)
  }
  save(cfg)
  console.log('✔ Link set to ' + cfg.url)
}

function newChat() {
  const cfg = load()
  cfg[cfg.provider].mode = 'new'
  cfg[cfg.provider].sessionId = ''
  save(cfg)
  console.log(`✔ The next reply starts a new ${PROVIDERS[cfg.provider]} conversation.`)
}

async function status() {
  const cfg = load()
  console.log(describe(cfg))
  console.log(`Settings:      ${HOME}`)
  const pid = running()
  console.log(`Running:       ${pid ? 'yes (pid ' + pid + ')' : 'no'}`)
}

async function checkAll() {
  const cfg = load()
  for (const p of Object.keys(PROVIDERS)) {
    const r = await check(cfg, p)
    console.log(`${r.ok ? '✔' : '✘'} ${PROVIDERS[p]}: ${r.detail}`)
  }
  const { ctx, page } = await site.open(cfg).catch(e => fail(e.message))
  const s = await site.state(page)
  console.log(`✔ ${cfg.url} is a Shared Notes site · ${s === 'in' ? 'signed in as ' + await site.accountName(page) : s === 'none' ? 'it has no accounts yet' : 'not signed in (run: npm run bot:login)'}`)
  await ctx.close()
}

async function signIn(page) {
  const env = process.env
  let user = env.SHARED_NOTES_BOT_USER, pass = env.SHARED_NOTES_BOT_PASS
  if (!user || !pass) {
    console.log('Sign in to Shared Notes with the account the bot will reply as.')
    console.log('(The password is used once and never saved; the site keeps only a derived key.)')
    user = await ask('  Account')
    pass = await ask('  Password', { hidden: true })
    doneAsking() // trả lại Ctrl+C cho bot
  }
  await site.login(page, user, pass)
  return site.accountName(page)
}

async function loginCmd(force) {
  const cfg = load()
  const { ctx, page } = await site.open(cfg).catch(e => fail(e.message))
  try {
    let s = await site.state(page)
    if (s === 'none') fail('This site has no accounts yet.')
    if (s === 'in' && force) {
      await site.logout(page)
      s = 'out'
    }
    if (s === 'in') console.log('✔ Already signed in as ' + await site.accountName(page))
    else console.log('✔ Signed in as ' + await signIn(page).catch(e => fail(e.message)))
  } finally {
    await ctx.close()
  }
}

async function logoutCmd() {
  const cfg = load()
  const { ctx, page } = await site.open(cfg).catch(e => fail(e.message))
  if (await site.state(page) === 'in') {
    await site.logout(page)
    console.log('✔ Signed out. The saved key was removed.')
  } else console.log('Not signed in.')
  await ctx.close()
}

/* ---- Chỉ một bot chạy cùng lúc (hai bot sẽ trả lời hai lần) ---- */
const PID = () => path.join(HOME, 'bot.pid')
function running() {
  try {
    const pid = +fs.readFileSync(PID(), 'utf8')
    process.kill(pid, 0)
    return pid
  } catch {
    return 0
  }
}

/* ================= CHẠY ================= */
async function start() {
  let cfg = load()
  ensureHome()
  const other = running()
  if (other) fail(`The bot is already running (pid ${other}). Stop it first (Ctrl+C in its terminal).`)
  fs.writeFileSync(PID(), String(process.pid), { mode: 0o600 })
  const cleanup = () => { try { if (+fs.readFileSync(PID(), 'utf8') === process.pid) fs.rmSync(PID()) } catch { /* đã xoá */ } }
  process.on('exit', cleanup)

  const handled = new Set() // id tin đã xử lý (trang đồng bộ lại tin cũ khi có máy mới vào)
  const pending = []
  let startedAt = Infinity, me = '', busy = false, timer = 0, latest = null, page, ctx

  const eligible = n => {
    if (n.own || handled.has(n.id)) return false
    handled.add(n.id)
    if (n.at < startedAt) {
      // tin cũ: chỉ nhớ tin mới nhất của tài khoản KHÁC (tin cũ của chính tài khoản này có thể là câu trả lời của bot)
      if (!n.mine && (!latest || n.at > latest.at)) latest = n
      return false
    }
    if (n.mine && !cfg.answerOwnAccount) return false
    if (!n.text.trim() && !n.images.length) return false // chỉ có ghi âm / tệp: không đọc được
    if (cfg.trigger && !n.text.trim().toLowerCase().startsWith(cfg.trigger.toLowerCase())) return false
    return true
  }

  const onNote = n => {
    if (!eligible(n)) return
    log(`New message from ${n.by || (n.mine ? me : 'unknown')}${n.images.length ? ` (+${n.images.length} image${n.images.length > 1 ? 's' : ''})` : ''}: ${preview(n.text)}`)
    pending.push(n)
    clearTimeout(timer)
    timer = setTimeout(flush, cfg.settleSeconds * 1000) // đợi thêm tin gửi liền nhau (ảnh trước, câu hỏi sau)
  }

  async function flush() {
    if (busy || !pending.length) return
    busy = true
    const batch = pending.splice(0)
    cfg = load() // áp dụng ngay khi đổi cài đặt trong lúc bot đang chạy (bot:setup, bot:new)
    const name = PROVIDERS[cfg.provider]
    try {
      log(`Asking ${name}…`)
      const { text, sessionId } = await askAI({ cfg, text: buildPrompt(batch, cfg, me), images: batch.flatMap(n => n.images) })
      const parts = split(text)
      for (const part of parts) await site.post(page, part, cfg.format)
      log(`✔ Replied (${text.length} characters${parts.length > 1 ? `, ${parts.length} messages` : ''})`)
      if (cfg.keepHistory) {
        const fresh = load() // giữ thay đổi người dùng vừa lưu trong lúc chờ AI
        if (fresh.provider === cfg.provider && JSON.stringify(fresh[cfg.provider]) === JSON.stringify(cfg[cfg.provider])) {
          fresh[cfg.provider] = { ...fresh[cfg.provider], mode: 'existing', sessionId }
          save(fresh)
        }
      }
    } catch (e) {
      log('✘ ' + e.message)
      await site.post(page, `⚠️ ${name} couldn't answer: ${e.message}`, 'plain').catch(() => {})
    } finally {
      busy = false
      if (pending.length) flush()
    }
  }

  async function connect() {
    ({ ctx, page } = await site.open(cfg, { show: flag('--show'), onNote }))
    const s = await site.state(page)
    if (s === 'none') throw new Error('This site has no accounts yet.')
    me = s === 'in' ? await site.accountName(page) : await signIn(page)
    if (startedAt === Infinity) startedAt = Date.now()
    page.on('crash', () => { log('The page crashed, reopening…'); reopen() })
    ctx.on('close', () => { if (!stopping) { log('Chrome closed, reopening…'); reopen() } })
  }

  let stopping = false, reopening = false
  async function reopen() {
    if (reopening || stopping) return // ctx.close() bên dưới cũng phát sự kiện 'close'
    reopening = true
    try {
      await ctx?.close().catch(() => {})
      await connect()
    } catch (e) {
      fail(e.message)
    } finally {
      reopening = false
    }
  }

  process.on('SIGINT', async () => {
    stopping = true
    log('Stopping…')
    await ctx?.close().catch(() => {})
    process.exit(0)
  })

  log('Opening ' + cfg.url)
  try {
    await connect()
  } catch (e) {
    fail(e.message)
  }
  console.log('\n' + describe(cfg) + '\n')
  log(`✔ Signed in as ${me}. Waiting for new messages… (Ctrl+C to stop)`)
  let lastPeers = -1
  setInterval(async () => {
    const n = await site.peers(page).catch(() => null)
    if (n !== null && n !== lastPeers) log(n ? `Connected · ${n} other device${n > 1 ? 's' : ''}` : 'Waiting for other devices…')
    lastPeers = n
  }, 5000)

  if (flag('--answer-last')) {
    await new Promise(r => setTimeout(r, 8000)) // đợi các máy khác gửi tin đang có
    if (latest) {
      log('Answering the latest message: ' + preview(latest.text))
      pending.push(latest)
      flush()
    } else log('No earlier message to answer.')
  }
}

const preview = t => {
  const s = t.replace(/\s+/g, ' ').trim()
  return s.length > 60 ? s.slice(0, 59) + '…' : s || '(no text)'
}

function buildPrompt(batch, cfg, me) {
  const head = [
    `You are replying in a private chat app called Shared Notes, signed in as the account "${me}".`,
    'Reply with the answer only, in the same language as the message.',
    cfg.format === 'md'
      ? 'Your reply is rendered as Markdown: use ``` code blocks with a language for code.'
      : 'Your reply is shown as plain text: do not use Markdown.',
    cfg.prompt && 'Instructions: ' + cfg.prompt,
  ].filter(Boolean).join('\n')
  const body = batch.map(n => {
    let t = n.text.trim()
    if (cfg.trigger && t.toLowerCase().startsWith(cfg.trigger.toLowerCase())) t = t.slice(cfg.trigger.length).trim()
    const extra = [n.images.length && `${n.images.length} image(s) attached`, n.files.length && `files not readable: ${n.files.join(', ')}`,
      n.voice && 'a voice message (not readable)'].filter(Boolean).join('; ')
    return `[${n.by || me}, ${new Date(n.at).toLocaleString()}]${extra ? ` (${extra})` : ''}\n${t || '(no text)'}`
  }).join('\n\n')
  return `${head}\n\nNew message${batch.length > 1 ? 's' : ''}:\n${body}`
}

// Câu trả lời dài → nhiều tin ≤ MAX_POST; cắt giữa khối ``` thì đóng khối rồi mở lại ở tin sau
function split(text) {
  if (text.length <= MAX_POST) return [text]
  const parts = []
  let cur = '', fence = null
  const push = () => {
    if (fence) cur += '\n```'
    parts.push(cur.trim())
    cur = fence ? fence + '\n' : ''
  }
  for (let line of text.split('\n')) {
    while (line.length > MAX_POST - 20) { // dòng quá dài
      if (cur.length) push()
      cur += line.slice(0, MAX_POST - 20)
      line = line.slice(MAX_POST - 20)
      push()
    }
    if (cur.length + line.length + 5 > MAX_POST) push()
    cur += (cur && !cur.endsWith('\n') ? '\n' : '') + line
    const m = /^\s*```(\S*)/.exec(line)
    if (m) fence = fence ? null : '```' + m[1]
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts.filter(Boolean)
}

const COMMANDS = { start, setup, url: setUrl, new: newChat, status, check: checkAll, login: () => loginCmd(true), logout: logoutCmd }
if (!COMMANDS[cmd]) fail(`Unknown command "${cmd}". Commands: ${Object.keys(COMMANDS).join(', ')}`)
try {
  await COMMANDS[cmd]()
  if (cmd !== 'start') process.exit(0)
} catch (e) {
  fail(e.message)
}
