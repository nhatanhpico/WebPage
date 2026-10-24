import './style.css'
import account from './account.js'
import { b64, unb64 } from './crypto.js'
import { isV2, login, openWith } from './accounts.js'
import { connect, MAX_BYTES } from './sync.js'

const $ = id => document.getElementById(id)
const html = document.documentElement
const SESSION = 'space_key' // khoá đã dẫn xuất (không phải mật khẩu)
const MAX_IMGS = 6
const MAX_FILES = 10
const MAX_FILE_BYTES = 25 * 1024 * 1024 // tổng dung lượng tệp mỗi ghi chú
const MAX_VOICE_SECS = 5 * 60
const MAX_SIDE = 1600
const coarse = matchMedia('(pointer: coarse)').matches

const store = {
  get(k) { try { return localStorage.getItem(k) } catch { return null } },
  set(k, v) { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k) } catch { /* private mode */ } },
}

const gate = $('gate'), lock = $('lock'), lockUser = $('lock-user'), lockPass = $('lock-pass')
const lockBtn = $('lock-btn'), lockErr = $('lock-error')
const space = $('space'), list = $('notes'), empty = $('empty'), feed = $('feed')
const presence = $('presence'), presenceText = $('presence-text'), appBar = $('app-bar')
const accountBtn = $('account-btn'), accountMenu = $('account-menu')
const snackbar = $('snackbar'), snackText = $('snackbar-text'), snackAction = $('snackbar-action')
const clearDialog = $('clear-dialog')
const micBtn = $('mic-btn'), recorder = $('recorder'), composeRow = $('compose-row'), recTime = $('rec-time')
const composer = $('composer'), textBox = $('text'), fileInput = $('file'), previews = $('previews')
const sendBtn = $('send-btn'), composeErr = $('compose-error'), lightbox = $('lightbox')

// Dữ liệu chỉ nằm trong bộ nhớ — đóng hết các thiết bị là mất
const notes = new Map()
const dead = new Set() // id đã xoá: không cho bản cũ từ thiết bị khác "sống lại"
let link = null
let pending = [] // đính kèm chờ gửi: { kind: 'img', src, w, h } | { kind: 'file', name, type, size, data }
let busy = 0
let unread = 0
let myName = '' // tên tài khoản đang đăng nhập (giải mã từ account.js)
let undo = null // xoá đang chờ: { id, li, timer }
const GROUP_MS = 5 * 60 * 1000

/* ================= LOGIN ================= */
async function boot() {
  if (!isV2(account)) {
    store.del(SESSION) // tài khoản đã bị xoá → đăng xuất mọi thiết bị
    $('lock-text').textContent = 'No account has been created.' // không gợi ý cách tạo tài khoản trên trang công khai
    for (const x of [lockUser, lockPass, lockBtn]) x.disabled = true
    html.classList.remove('resume')
    return
  }
  const saved = store.get(SESSION)
  if (saved) {
    try {
      const s = JSON.parse(saved)
      const opened = s.salt === account.salt && (await openWith(account, unb64(s.key)))
      if (opened) return enter(opened)
    } catch { /* phiên hỏng */ }
    store.del(SESSION) // đổi mật khẩu / xoá tài khoản → phiên cũ hết hiệu lực
  }
  html.classList.remove('resume')
}

function fieldError(msg) {
  lockErr.textContent = msg
  for (const id of ['field-user', 'field-pass']) $(id).classList.toggle('error', !!msg)
}

lock.addEventListener('submit', async e => {
  e.preventDefault()
  if (!lockUser.value.trim() || !lockPass.value) {
    fieldError('Enter your account and password.')
    return
  }
  lockBtn.disabled = true
  lockBtn.textContent = 'Signing in…'
  fieldError('')
  try {
    const opened = await login(account, lockUser.value, lockPass.value)
    if (!opened) {
      fieldError('Incorrect account or password.')
      lock.classList.remove('shake')
      void lock.offsetWidth
      lock.classList.add('shake')
      lockPass.select()
      return
    }
    store.set(SESSION, JSON.stringify({ salt: account.salt, key: b64(opened.master) }))
    lockPass.value = ''
    await enter(opened)
  } catch (err) {
    console.error(err)
    fieldError('Something went wrong. Please try again.')
  } finally {
    lockBtn.disabled = false
    lockBtn.textContent = 'Sign in'
  }
})

for (const x of [lockUser, lockPass]) x.addEventListener('input', () => lockErr.textContent && fieldError(''))

async function enter({ keys, name }) {
  myName = name
  html.classList.remove('resume')
  gate.hidden = true
  space.hidden = false
  $('my-name').textContent = name
  $('my-avatar').textContent = $('menu-avatar').textContent = initials(name)
  accountBtn.title = accountBtn.ariaLabel = `Account: ${name}`
  setPresence(0)
  updateEmpty()
  grow()
  refreshSend()
  link = connect(keys, { onOp, onPeers })
  if (!coarse) textBox.focus()
}

$('logout-btn').addEventListener('click', () => {
  stopRecording(false)
  commitUndo()
  closeMenu()
  link?.leave()
  link = null
  store.del(SESSION)
  notes.clear()
  dead.clear()
  list.replaceChildren()
  resetComposer()
  hideSnack()
  myName = ''
  space.hidden = true
  gate.hidden = false // hiện lại → animation của thẻ chạy lại
  lockUser.focus()
})

/* ---- Menu tài khoản ---- */
function openMenu() {
  accountMenu.hidden = false
  accountBtn.setAttribute('aria-expanded', 'true')
  $('logout-btn').focus()
}

function closeMenu() {
  accountMenu.hidden = true
  accountBtn.setAttribute('aria-expanded', 'false')
}

accountBtn.addEventListener('click', e => {
  e.stopPropagation()
  accountMenu.hidden ? openMenu() : closeMenu()
})
document.addEventListener('click', e => {
  if (!accountMenu.hidden && !accountMenu.contains(e.target)) closeMenu()
})

/* ================= ĐỒNG BỘ ================= */
function onPeers(count, peerId, joined) {
  setPresence(count)
  // thiết bị mới vào → gửi cho nó toàn bộ ghi chú đang có
  if (!joined || !link) return
  link.send({ t: 'sync', notes: [], dead: [...dead] }, peerId)
  for (const n of notes.values()) link.send({ t: 'add', note: n }, peerId)
}

function onOp(op) {
  if (!op || typeof op !== 'object') return
  if (op.t === 'add') {
    if (addNote(op.note) && document.hidden) bumpUnread()
  } else if (op.t === 'del') {
    killNote(op.id)
  } else if (op.t === 'clear') {
    if (Array.isArray(op.ids)) op.ids.forEach(killNote)
  } else if (op.t === 'sync') {
    if (Array.isArray(op.dead)) op.dead.forEach(killNote)
    const stick = nearBottom()
    if (Array.isArray(op.notes)) op.notes.forEach(n => addNote(n, false))
    if (stick) scrollDown()
  }
}

function setPresence(count) {
  presence.classList.toggle('on', count > 0)
  presenceText.textContent = count > 0
    ? `Connected · ${count} other device${count > 1 ? 's' : ''}`
    : 'Waiting for other devices…'
}

function bumpUnread() {
  unread++
  document.title = `(${unread}) Shared Notes`
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && unread) {
    unread = 0
    document.title = 'Shared Notes'
  }
})

/* ================= GHI CHÚ ================= */
const IMG_RE = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/
const AUDIO_RE = /^data:audio\/[a-z0-9.+-]+(;[a-z0-9=.+-]+)*;base64,[A-Za-z0-9+/=]+$/i
const FILE_RE = /^data:[^,]*;base64,[A-Za-z0-9+/=]*$/

// Dữ liệu từ thiết bị khác cũng kiểm tra lại cho chắc
function clean(n) {
  if (!n || typeof n.id !== 'string' || n.id.length > 64 || !Number.isFinite(n.at)) return null
  const text = typeof n.text === 'string' ? n.text.slice(0, 5000) : ''
  const imgs = (Array.isArray(n.imgs) ? n.imgs : [])
    .filter(i => i && typeof i.src === 'string' && IMG_RE.test(i.src))
    .slice(0, MAX_IMGS)
    .map(i => ({ src: i.src, w: Math.max(0, i.w | 0), h: Math.max(0, i.h | 0) }))
  const files = (Array.isArray(n.files) ? n.files : [])
    .filter(f => f && typeof f.name === 'string' && typeof f.data === 'string' && FILE_RE.test(f.data))
    .slice(0, MAX_FILES)
    .map(f => ({ name: safeName(f.name), type: typeof f.type === 'string' ? f.type.slice(0, 100) : '', size: Math.max(0, +f.size || 0), data: f.data }))
  const v = n.voice
  const voice = v && typeof v.src === 'string' && AUDIO_RE.test(v.src) ? { src: v.src, dur: Math.max(0, Math.min(+v.dur || 0, MAX_VOICE_SECS + 5)) } : null
  if (!text.trim() && !imgs.length && !files.length && !voice) return null
  return { id: n.id, at: n.at, by: typeof n.by === 'string' ? n.by.slice(0, 32) : '', text, imgs, files, voice }
}

// Tên tệp an toàn để tải về (bỏ đường dẫn, ký tự điều khiển)
function safeName(name) {
  return name.replace(/[\u0000-\u001f\\/:*?"<>|]+/g, '_').trim().slice(0, 200) || 'file'
}

function addNote(raw, scroll = true) {
  const n = clean(raw)
  if (!n || notes.has(n.id) || dead.has(n.id)) return false
  notes.set(n.id, n)
  const li = renderNote(n)
  // chèn đúng thứ tự thời gian (thường là cuối danh sách)
  let ref = list.lastElementChild
  while (ref && +ref.dataset.at > n.at) ref = ref.previousElementSibling
  const stick = scroll && (isMine(n) || nearBottom())
  list.insertBefore(li, ref ? ref.nextSibling : list.firstChild)
  regroup(li)
  regroup(li.nextElementSibling)
  updateEmpty()
  if (stick) scrollDown()
  return true
}

function killNote(id) {
  if (typeof id !== 'string') return
  dead.add(id)
  if (undo?.id === id) {
    clearTimeout(undo.timer)
    undo = null
    hideSnack()
  }
  if (!notes.delete(id)) return
  const li = list.querySelector(`li[data-id="${CSS.escape(id)}"]`)
  const next = li?.nextElementSibling
  li?.remove()
  regroup(next)
  updateEmpty()
}

function isMine(n) {
  return !!myName && n.by.trim().toLowerCase() === myName.toLowerCase()
}

// Tin liên tiếp của cùng một người trong 5 phút → gộp nhóm (ẩn tên + avatar lặp lại)
function regroup(li) {
  if (!li) return
  let prev = li.previousElementSibling
  while (prev?.hidden) prev = prev.previousElementSibling
  const a = prev && notes.get(prev.dataset.id)
  const b = notes.get(li.dataset.id)
  li.classList.toggle('cont', !!(a && b && a.by.toLowerCase() === b.by.toLowerCase() && b.at - a.at < GROUP_MS))
}

function make(tag, cls, text) {
  const x = document.createElement(tag)
  if (cls) x.className = cls
  if (text != null) x.textContent = text
  return x
}

function renderNote(n) {
  const li = make('li', 'note' + (isMine(n) ? ' mine' : ''))
  li.dataset.id = n.id
  li.dataset.at = n.at
  const by = n.by || 'Unknown'
  const body = make('div', 'note-body')
  body.append(make('span', 'note-by', by))

  const bubble = make('div', 'bubble')
  if (n.imgs.length) {
    const grid = make('div', 'note-imgs n' + Math.min(n.imgs.length, 4))
    for (const im of n.imgs) {
      const img = make('img')
      img.src = im.src
      img.alt = 'Attached image'
      img.decoding = 'async'
      if (im.w && im.h) {
        img.width = im.w
        img.height = im.h
      }
      img.addEventListener('click', () => openLightbox(im.src))
      grid.append(img)
    }
    bubble.append(grid)
  }
  if (n.voice) bubble.append(voicePlayer(n.voice))
  for (const f of n.files) bubble.append(fileChip(f))
  if (n.text.trim()) {
    const p = make('p', 'note-text')
    linkify(p, n.text)
    bubble.append(p)
  }

  const meta = make('div', 'note-meta')
  const time = make('time', 'note-time', when(n.at))
  time.dateTime = new Date(n.at).toISOString()
  time.title = new Date(n.at).toLocaleString()
  const del = make('button', 'icon-btn note-del')
  del.type = 'button'
  del.title = 'Delete for everyone'
  del.setAttribute('aria-label', 'Delete note')
  del.append(icon('i-delete'))
  del.addEventListener('click', () => deleteWithUndo(n.id))
  meta.append(time, del)

  body.append(bubble, meta)
  li.append(make('span', 'avatar', initials(by)), body)
  return li
}

// Tệp: luôn TẢI VỀ dưới dạng octet-stream, không bao giờ mở trong trang (tệp HTML lạ không chạy được ở đây)
function fileChip(f) {
  const a = make('button', 'file-chip')
  a.type = 'button'
  a.title = `Download ${f.name}`
  const ic = make('span', 'file-icon')
  ic.append(icon('i-file'))
  const info = make('span', 'file-info')
  info.append(make('span', 'file-name', f.name), make('span', 'file-meta', [fileKind(f), fmtSize(f.size)].filter(Boolean).join(' · ')))
  a.append(ic, info, icon('i-download'))
  a.addEventListener('click', async () => {
    const blob = new Blob([await (await fetch(f.data)).arrayBuffer()], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const link = make('a')
    link.href = url
    link.download = f.name
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30000)
  })
  return a
}

function fileKind(f) {
  const ext = /\.([a-z0-9]{1,6})$/i.exec(f.name)?.[1]
  return ext ? ext.toUpperCase() : (f.type.split('/')[1] || '').toUpperCase()
}

function fmtSize(n) {
  if (!n) return ''
  if (n < 1024) return n + ' B'
  if (n < 1024 ** 2) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB'
  return (n / 1024 ** 2).toFixed(1) + ' MB'
}

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec))
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0')
}

// Trình phát tin nhắn thoại: nút phát/dừng + thanh tiến độ (bấm để tua) + thời lượng
function voicePlayer(v) {
  const box = make('div', 'voice')
  const btn = make('button', 'icon-btn voice-btn')
  btn.type = 'button'
  btn.setAttribute('aria-label', 'Play voice message')
  btn.append(icon('i-play'))
  const track = make('div', 'voice-track')
  const fill = make('div', 'voice-fill')
  track.append(fill)
  const time = make('span', 'voice-time', fmtDur(v.dur))
  box.append(btn, track, time)
  let audio = null
  const setIcon = playing => {
    btn.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play')
    btn.setAttribute('aria-label', playing ? 'Pause voice message' : 'Play voice message')
  }
  const ensure = async () => {
    if (audio) return audio
    const url = URL.createObjectURL(await (await fetch(v.src)).blob())
    audio = new Audio(url)
    audio.addEventListener('timeupdate', () => {
      const d = Number.isFinite(audio.duration) ? audio.duration : v.dur
      fill.style.width = (d ? Math.min(1, audio.currentTime / d) * 100 : 0) + '%'
      time.textContent = fmtDur(audio.currentTime)
    })
    audio.addEventListener('play', () => setIcon(true))
    audio.addEventListener('pause', () => setIcon(false))
    audio.addEventListener('ended', () => {
      fill.style.width = '0%'
      time.textContent = fmtDur(v.dur)
    })
    return audio
  }
  btn.addEventListener('click', async () => {
    const a = await ensure()
    if (a.paused) {
      for (const other of players) if (other !== a) other.pause()
      players.add(a)
      a.play()
    } else a.pause()
  })
  track.addEventListener('click', async e => {
    const a = await ensure()
    const d = Number.isFinite(a.duration) ? a.duration : v.dur
    const r = track.getBoundingClientRect()
    a.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d
  })
  return box
}
const players = new Set()

function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'i')
  svg.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', '#' + id)
  svg.append(use)
  return svg
}

/* ---- Xoá kèm "Hoàn tác" (snackbar M3): ẩn ngay, chỉ gửi lệnh xoá sau 5 giây ---- */
function deleteWithUndo(id) {
  commitUndo()
  const li = list.querySelector(`li[data-id="${CSS.escape(id)}"]`)
  if (!li) return
  li.hidden = true
  regroup(li.nextElementSibling)
  updateEmpty()
  undo = { id, li, timer: setTimeout(commitUndo, 5000) }
  showSnack('Note deleted', 'Undo', () => {
    if (!undo) return
    clearTimeout(undo.timer)
    undo.li.hidden = false
    regroup(undo.li)
    regroup(undo.li.nextElementSibling)
    undo = null
    updateEmpty()
  })
}

function commitUndo() {
  if (!undo) return
  const { id, timer } = undo
  clearTimeout(timer)
  undo = null
  killNote(id)
  link?.send({ t: 'del', id })
  hideSnack()
}

let snackTimer = 0
function showSnack(text, action, onAction) {
  clearTimeout(snackTimer)
  snackText.textContent = text
  snackAction.hidden = !action
  snackAction.textContent = action || ''
  snackAction.onclick = () => {
    hideSnack()
    onAction?.()
  }
  snackbar.hidden = false
  snackTimer = setTimeout(hideSnack, action ? 5000 : 3000)
}

function hideSnack() {
  clearTimeout(snackTimer)
  snackbar.hidden = true
}

function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const s = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] || '?')[0]
  return s.toUpperCase()
}

function when(at) {
  const d = new Date(at)
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? t : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + t
}

// Link bấm được — dựng bằng text node, không bao giờ dùng innerHTML với nội dung người dùng
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi

function linkify(p, text) {
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0].replace(/[.,;:!?]+$/, '')
    if (url.endsWith(')') && !url.includes('(')) url = url.slice(0, -1)
    const href = /^www\./i.test(url) ? 'https://' + url : url
    let ok = false
    try {
      ok = /^https?:$/.test(new URL(href).protocol)
    } catch { /* link hỏng → để chữ thường */ }
    p.append(text.slice(last, m.index))
    if (ok) {
      const a = make('a', 'link', url)
      a.href = href
      a.target = '_blank'
      a.rel = 'noopener noreferrer nofollow'
      p.append(a)
    } else {
      p.append(url)
    }
    last = m.index + url.length
  }
  p.append(text.slice(last))
}

function updateEmpty() {
  empty.hidden = notes.size - (undo ? 1 : 0) > 0
}

function nearBottom() {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120
}

function scrollDown() {
  requestAnimationFrame(() => feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' }))
}

/* ---- Xoá tất cả: hộp thoại xác nhận (dialog M3) ---- */
$('clear-btn').addEventListener('click', () => {
  if (!notes.size) {
    showSnack('There are no notes to clear')
    return
  }
  clearDialog.showModal()
})

clearDialog.addEventListener('close', () => {
  if (clearDialog.returnValue !== 'clear') return
  commitUndo()
  const ids = [...notes.keys()]
  ids.forEach(killNote)
  link?.send({ t: 'clear', ids })
  showSnack('All notes cleared')
})

feed.addEventListener('scroll', () => appBar.classList.toggle('scrolled', feed.scrollTop > 0), { passive: true })

/* ================= SOẠN & GỬI ================= */
composer.addEventListener('submit', async e => {
  e.preventDefault()
  const text = textBox.value.replace(/\s+$/, '')
  if ((!text.trim() && !pending.length) || busy) return
  const note = {
    id: crypto.randomUUID(),
    at: Date.now(),
    by: myName,
    text: text.trim() ? text : '',
    imgs: pending.filter(p => p.kind === 'img').map(({ src, w, h }) => ({ src, w, h })),
    files: pending.filter(p => p.kind === 'file').map(({ name, type, size, data }) => ({ name, type, size, data })),
  }
  if (JSON.stringify(note).length > MAX_BYTES) {
    composeErr.textContent = 'This note is too large. Try attaching fewer images.'
    return
  }
  resetComposer()
  addNote(note)
  if (!link) return
  await sendNote(note)
})

async function sendNote(note) {
  const li = list.querySelector(`li[data-id="${CSS.escape(note.id)}"]`)
  const big = (note.imgs.length > 0 || note.files.length > 0 || !!note.voice) && link.peers() > 0
  if (big && li) li.classList.add('sending')
  try {
    await link.send({ t: 'add', note }, null, big && li ? p => li.style.setProperty('--p', p) : null)
  } catch (err) {
    console.warn('[space] send failed', err)
  } finally {
    li?.classList.remove('sending')
  }
}

textBox.addEventListener('keydown', e => {
  // máy tính: Enter gửi, Shift+Enter xuống dòng; điện thoại: Enter xuống dòng. Bỏ qua khi đang gõ bộ gõ (IME)
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse) {
    e.preventDefault()
    composer.requestSubmit()
  }
})
if (coarse) textBox.enterKeyHint = 'enter'

textBox.addEventListener('input', () => {
  grow()
  refreshSend()
})

// Cao theo nội dung; chỉ hiện thanh cuộn khi đã chạm max-height
function grow() {
  textBox.style.height = 'auto'
  const max = parseFloat(getComputedStyle(textBox).maxHeight) || Infinity
  const h = Math.min(textBox.scrollHeight, max)
  textBox.style.height = h + 'px'
  textBox.style.overflowY = textBox.scrollHeight > max ? 'auto' : 'hidden'
}

// Ô trống → hiện micro (ghi âm); có nội dung → hiện nút gửi (giống Google Messages)
function refreshSend() {
  const has = !!textBox.value.trim() || pending.length > 0
  sendBtn.hidden = !has
  micBtn.hidden = has || !canRecord
  sendBtn.disabled = busy > 0 || !has
  composeErr.textContent = ''
}

function resetComposer() {
  textBox.value = ''
  pending = []
  renderPreviews()
  grow()
  refreshSend()
}

fileInput.addEventListener('change', () => {
  addFiles(fileInput.files)
  fileInput.value = ''
})

textBox.addEventListener('paste', e => {
  const files = [...(e.clipboardData?.files || [])]
  if (files.length) {
    e.preventDefault()
    addFiles(files)
  }
})

space.addEventListener('dragover', e => {
  if ([...e.dataTransfer.types].includes('Files')) {
    e.preventDefault()
    space.classList.add('drop')
  }
})
space.addEventListener('dragleave', e => {
  if (e.target === space || !space.contains(e.relatedTarget)) space.classList.remove('drop')
})
space.addEventListener('drop', e => {
  e.preventDefault()
  space.classList.remove('drop')
  addFiles(e.dataTransfer.files)
})

const isImage = f => /^image\/(jpeg|png|webp|gif|heic|heif|avif|bmp)$/i.test(f.type) || /\.(heic|heif)$/i.test(f.name)

async function addFiles(list) {
  const files = [...list]
  if (!files.length) return
  busy++
  refreshSend()
  for (const f of files) {
    const imgs = pending.filter(p => p.kind === 'img').length
    const others = pending.filter(p => p.kind === 'file')
    try {
      if (isImage(f) && imgs < MAX_IMGS) {
        try {
          pending.push({ kind: 'img', ...(await prepImage(f)) })
          renderPreviews()
          continue
        } catch { /* trình duyệt không đọc được ảnh (vd. HEIC) → gửi như tệp */ }
      }
      if (others.length >= MAX_FILES) {
        composeErr.textContent = `You can attach up to ${MAX_FILES} files per note.`
        break
      }
      if (others.reduce((t, x) => t + x.size, 0) + f.size > MAX_FILE_BYTES) {
        composeErr.textContent = `Files can add up to ${fmtSize(MAX_FILE_BYTES)} per note. “${f.name}” is too large.`
        continue
      }
      pending.push({ kind: 'file', name: safeName(f.name), type: f.type, size: f.size, data: await dataURL(f) })
      renderPreviews()
    } catch (err) {
      console.warn(err)
      composeErr.textContent = `Couldn't read “${f.name}”.`
    }
  }
  busy--
  refreshSend()
  if (!coarse) textBox.focus()
}

// Thu nhỏ + nén ngay trên máy (JPEG 1600px); GIF nhỏ giữ nguyên để còn chuyển động
async function prepImage(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    if (file.type === 'image/gif' && file.size <= 4e6) {
      return { src: await dataURL(file), w: bmp.width, h: bmp.height }
    }
    const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height))
    const w = Math.round(bmp.width * k)
    const h = Math.round(bmp.height * k)
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const g = c.getContext('2d')
    g.fillStyle = '#fff' // PNG trong suốt → nền trắng
    g.fillRect(0, 0, w, h)
    g.drawImage(bmp, 0, 0, w, h)
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85))
    return { src: await dataURL(blob), w, h }
  } finally {
    bmp.close()
  }
}

function dataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

function renderPreviews() {
  previews.hidden = !pending.length
  previews.replaceChildren(...pending.map((p, i) => {
    const box = make('div', 'preview' + (p.kind === 'file' ? ' file' : ''))
    if (p.kind === 'img') {
      const img = make('img')
      img.src = p.src
      img.alt = ''
      box.append(img)
    } else {
      const ic = make('span', 'file-icon')
      ic.append(icon('i-file'))
      const info = make('span', 'file-info')
      info.append(make('span', 'file-name', p.name), make('span', 'file-meta', fmtSize(p.size)))
      box.append(ic, info)
    }
    const x = make('button', 'icon-btn preview-x')
    x.type = 'button'
    x.append(icon('i-close'))
    x.setAttribute('aria-label', 'Remove attachment')
    x.addEventListener('click', () => {
      pending.splice(i, 1)
      renderPreviews()
      refreshSend()
    })
    box.append(x)
    return box
  }))
}

/* ================= GHI ÂM ================= */
const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder)
let rec = null // { mr, stream, chunks, start, timer, send }

function recMime() {
  for (const t of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported?.(t)) return t
  }
  return ''
}

micBtn.addEventListener('click', async () => {
  if (rec) return
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (err) {
    console.warn(err)
    showSnack(err.name === 'NotAllowedError' ? 'Microphone access was blocked' : 'No microphone available')
    return
  }
  const type = recMime()
  const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
  rec = { mr, stream, chunks: [], start: Date.now(), send: false }
  mr.addEventListener('dataavailable', e => e.data.size && rec?.chunks.push(e.data))
  mr.addEventListener('stop', finishRecording)
  mr.start(250)
  composeRow.hidden = true
  previews.hidden = true
  recorder.hidden = false
  recTime.textContent = '0:00'
  rec.timer = setInterval(() => {
    const secs = (Date.now() - rec.start) / 1000
    recTime.textContent = fmtDur(secs)
    if (secs >= MAX_VOICE_SECS) stopRecording(true)
  }, 250)
  $('rec-send').focus()
})

function stopRecording(send) {
  if (!rec) return
  rec.send = send
  clearInterval(rec.timer)
  if (rec.mr.state !== 'inactive') rec.mr.stop()
}

async function finishRecording() {
  const r = rec
  rec = null
  r.stream.getTracks().forEach(t => t.stop())
  recorder.hidden = true
  composeRow.hidden = false
  previews.hidden = !pending.length
  const dur = (Date.now() - r.start) / 1000
  if (!r.send) return
  if (dur < 0.7 || !r.chunks.length) {
    showSnack('Recording too short')
    return
  }
  const blob = new Blob(r.chunks, { type: r.mr.mimeType || r.chunks[0].type || 'audio/webm' })
  const note = { id: crypto.randomUUID(), at: Date.now(), by: myName, text: '', imgs: [], files: [], voice: { src: await dataURL(blob), dur } }
  addNote(note)
  if (link) await sendNote(note)
}

$('rec-cancel').addEventListener('click', () => stopRecording(false))
$('rec-send').addEventListener('click', () => stopRecording(true))

/* ================= XEM ẢNH ================= */
function openLightbox(src) {
  lightbox.firstElementChild.src = src
  lightbox.hidden = false
}

function closeLightbox() {
  lightbox.hidden = true
  lightbox.firstElementChild.removeAttribute('src')
}

lightbox.addEventListener('click', closeLightbox)
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return
  if (rec) stopRecording(false)
  else if (!lightbox.hidden) closeLightbox()
  else if (!accountMenu.hidden) {
    closeMenu()
    accountBtn.focus()
  }
})

/* ================= BÀN PHÍM ĐIỆN THOẠI ================= */
// iOS không thu nhỏ layout khi bàn phím mở → bám theo visualViewport để ô soạn luôn nằm trên bàn phím
const vv = window.visualViewport
if (vv) {
  const fit = () => {
    html.style.setProperty('--app-h', vv.height + 'px')
    html.style.setProperty('--app-top', vv.offsetTop + 'px')
  }
  vv.addEventListener('resize', fit)
  vv.addEventListener('scroll', fit)
  fit()
}

boot()
