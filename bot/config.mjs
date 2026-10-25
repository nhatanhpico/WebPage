// Cấu hình bot: ~/Library/Application Support/SharedNotesBot/config.json (quyền 0600), KHÔNG nằm trong repo.
// SHARED_NOTES_BOT_HOME đổi thư mục này (dùng khi thử nghiệm, không đụng tới cấu hình thật).
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

export const HOME = process.env.SHARED_NOTES_BOT_HOME || path.join(os.homedir(), 'Library/Application Support/SharedNotesBot')
export const PROFILE = path.join(HOME, 'chrome-profile') // phiên đăng nhập của trang (chỉ khoá đã dẫn xuất, không có mật khẩu)
export const CONVERSATIONS = path.join(HOME, 'Conversations') // thư mục làm việc cố định cho phiên Claude mới
const FILE = path.join(HOME, 'config.json')

export const PROVIDERS = { claude: 'Claude Code', antigravity: 'Antigravity CLI' }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const DEFAULTS = {
  url: 'https://nhatanhpico.github.io/WebPage/',
  provider: 'claude',
  claude: { path: path.join(os.homedir(), '.local/bin/claude'), mode: 'new', sessionId: '' },
  antigravity: { path: path.join(os.homedir(), '.local/bin/agy'), mode: 'new', sessionId: '' },
  keepHistory: true, // sau mỗi câu trả lời, lượt sau tiếp tục đúng cuộc hội thoại đó
  effort: 'low',
  timeoutSeconds: 300,
  settleSeconds: 3, // đợi thêm tin (vd. ảnh rồi mới tới chữ) trước khi gửi cho AI
  trigger: '', // rỗng = trả lời mọi tin mới; vd. "@ai" = chỉ tin bắt đầu bằng @ai
  answerOwnAccount: true, // trả lời cả tin của chính tài khoản này gửi từ thiết bị khác
  format: 'md', // câu trả lời gửi dạng Markdown (code, danh sách…) hay chữ thường
  prompt: '', // chỉ dẫn thêm cho AI
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
}

export function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 })
  fs.chmodSync(HOME, 0o700)
}

export function load() {
  let saved = {}
  if (fs.existsSync(FILE)) {
    try {
      saved = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    } catch (e) {
      throw new Error(`Can't read ${FILE}: ${e.message}`) // không âm thầm thay bằng mặc định
    }
  }
  const cfg = {
    ...DEFAULTS,
    ...saved,
    claude: { ...DEFAULTS.claude, ...saved.claude },
    antigravity: { ...DEFAULTS.antigravity, ...saved.antigravity },
  }
  validate(cfg)
  return cfg
}

export function save(cfg) {
  validate(cfg)
  ensureHome()
  const tmp = FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, FILE)
}

export function checkUrl(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    throw new Error(`"${url}" is not a valid link.`)
  }
  const local = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)
  if (u.protocol !== 'https:' && !local) throw new Error('The link must start with https:// (http:// only for localhost).')
  return u.href
}

export function validate(cfg) {
  checkUrl(cfg.url)
  if (!PROVIDERS[cfg.provider]) throw new Error(`provider must be ${Object.keys(PROVIDERS).join(' or ')}.`)
  for (const p of Object.keys(PROVIDERS)) {
    const c = cfg[p]
    if (!['new', 'existing'].includes(c.mode)) throw new Error(`${p}.mode must be "new" or "existing".`)
    if (c.mode === 'existing' && !UUID_RE.test(c.sessionId)) throw new Error(`${p}.sessionId must be a conversation ID (UUID).`)
  }
  if (!['low', 'medium', 'high'].includes(cfg.effort)) throw new Error('effort must be low, medium or high.')
  if (!(cfg.timeoutSeconds >= 10 && cfg.timeoutSeconds <= 1800)) throw new Error('timeoutSeconds must be 10–1800.')
  if (!(cfg.settleSeconds >= 0 && cfg.settleSeconds <= 60)) throw new Error('settleSeconds must be 0–60.')
  if (!['md', 'plain'].includes(cfg.format)) throw new Error('format must be "md" or "plain".')
  if (typeof cfg.trigger !== 'string' || typeof cfg.prompt !== 'string') throw new Error('trigger and prompt must be text.')
}

export const isUuid = s => UUID_RE.test(s)
