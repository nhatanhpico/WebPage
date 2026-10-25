import './style.css'
import account from './account.js'
import { b64, unb64 } from './crypto.js'
import { isV2, login, openWith } from './accounts.js'
import { connect, MAX_BYTES } from './sync.js'
import { renderMarkdown, plainSnippet } from './markdown.js'
import { COLORS, SIZES, MAX_RICH, serialize, renderRich, linkText } from './rich.js'

const $ = id => document.getElementById(id)
const html = document.documentElement
const SESSION = 'space_key' // khoá đã dẫn xuất (không phải mật khẩu)
const THEME = 'space_theme'
const FORMAT = 'space_format' // kiểu soạn tin: '' (chữ thường) | 'md' | 'rich'
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
const confirmDialog = $('confirm-dialog'), pinBar = $('pin-bar')
const themeBtn = $('theme-btn'), themeMenu = $('theme-menu')
const micBtn = $('mic-btn'), recorder = $('recorder'), composeRow = $('compose-row'), recTime = $('rec-time')
const composer = $('composer'), textBox = $('text'), fileInput = $('file'), previews = $('previews')
const sendBtn = $('send-btn'), composeErr = $('compose-error'), lightbox = $('lightbox')
const richBox = $('rich'), formatBar = $('format-bar'), mdBar = $('md-bar'), plusBtn = $('plus-btn'), plusMenu = $('plus-menu')

// Dữ liệu chỉ nằm trong bộ nhớ — đóng hết các thiết bị là mất
const notes = new Map()
const dead = new Set() // id đã xoá: không cho bản cũ từ thiết bị khác "sống lại"
let link = null
let pending = [] // đính kèm chờ gửi: { kind: 'img', src, w, h } | { kind: 'file', name, type, size, data }
let busy = 0
let unread = 0
let myName = '' // tên tài khoản đang đăng nhập (giải mã từ account.js)
let pin = { id: null, at: 0, by: '' } // tin đang ghim (chỉ 1); bên nào ghim/bỏ ghim sau cùng thì thắng
let mode = ['md', 'rich'].includes(store.get(FORMAT)) ? store.get(FORMAT) : ''
const GROUP_MS = 5 * 60 * 1000

/* ================= LOGIN ================= */
async function boot() {
  if (!isV2(account)) {
    store.del(SESSION) // tài khoản đã bị xoá → đăng xuất mọi thiết bị
    $('lock-text').textContent = 'No account has been created.' // không gợi ý cách tạo tài khoản trên trang công khai
    for (const x of [lockUser, lockPass, lockBtn, $('toggle-pass')]) x.disabled = true
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
    showPassword(false)
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

/* ---- Hiện / ẩn mật khẩu (trailing icon của text field) ---- */
const togglePass = $('toggle-pass')

function showPassword(show) {
  lockPass.type = show ? 'text' : 'password'
  const label = show ? 'Hide password' : 'Show password'
  togglePass.setAttribute('aria-pressed', String(show))
  togglePass.setAttribute('aria-label', label)
  togglePass.title = label
  togglePass.querySelector('use').setAttribute('href', show ? '#i-eye-off' : '#i-eye')
}

// giữ focus + vị trí con trỏ trong ô mật khẩu khi bấm nút
togglePass.addEventListener('pointerdown', e => e.preventDefault())
togglePass.addEventListener('click', () => {
  showPassword(lockPass.type === 'password')
  lockPass.focus()
})

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
  if (!coarse) focusInput()
}

$('logout-btn').addEventListener('click', () => {
  stopRecording(false)
  closeMenus()
  link?.leave()
  link = null
  store.del(SESSION)
  notes.clear()
  dead.clear()
  pin = { id: null, at: 0, by: '' }
  renderPin()
  list.replaceChildren()
  resetComposer()
  hideSnack()
  myName = ''
  space.hidden = true
  gate.hidden = false // hiện lại → animation của thẻ chạy lại
  lockUser.focus()
})

/* ---- Đóng có hiệu ứng: thêm .closing (chạy animation thu lại) rồi mới ẩn ---- */
function afterAnim(el, fn) {
  let done = false
  const finish = () => {
    if (done) return
    done = true
    el.removeEventListener('animationend', onEnd)
    fn()
  }
  const onEnd = e => e.target === el && finish()
  el.addEventListener('animationend', onEnd)
  setTimeout(finish, 300) // dự phòng nếu animationend không chạy
}

function showEl(el) {
  el.classList.remove('closing') // mở lại khi đang đóng → chạy lại hiệu ứng mở
  el.hidden = false
}

function hideEl(el, after) {
  if (!isShown(el)) return
  el.classList.add('closing')
  afterAnim(el, () => {
    if (!el.classList.contains('closing')) return // đã mở lại giữa chừng
    el.classList.remove('closing')
    el.hidden = true
    after?.()
  })
}

const isShown = el => !el.hidden && !el.classList.contains('closing')

/* ---- Menu (tài khoản, bảng màu, nút +) ---- */
const menus = [[accountBtn, accountMenu], [themeBtn, themeMenu], [plusBtn, plusMenu]]

function openMenu(btn, menu) {
  closeMenus()
  showEl(menu)
  btn.setAttribute('aria-expanded', 'true')
  menu.querySelector('[aria-checked="true"], button')?.focus()
}

function closeMenus() {
  for (const [btn, menu] of menus) {
    hideEl(menu)
    btn.setAttribute('aria-expanded', 'false')
  }
}

for (const [btn, menu] of menus) {
  btn.addEventListener('click', e => {
    e.stopPropagation()
    isShown(menu) ? closeMenus() : openMenu(btn, menu)
  })
}
document.addEventListener('click', e => {
  if (!menus.some(([, m]) => m.contains(e.target))) closeMenus()
})

/* ---- Giao diện màu (lưu riêng từng thiết bị) ---- */
const THEMES = { navy: '#0f1b33', purple: '#1a1029', black: '#131314', white: '#f8fafd', paper: '#f7f0dc' }

function applyTheme(name) {
  if (!THEMES[name]) name = 'navy'
  html.dataset.theme = name
  $('theme-meta').content = THEMES[name]
  for (const b of themeMenu.querySelectorAll('.swatch')) b.setAttribute('aria-checked', String(b.dataset.theme === name))
  store.set(THEME, name)
}

themeMenu.addEventListener('click', e => {
  const b = e.target.closest('.swatch')
  if (!b) return
  applyTheme(b.dataset.theme)
  closeMenus()
  themeBtn.focus()
})
applyTheme(html.dataset.theme)

/* ================= ĐỒNG BỘ ================= */
function onPeers(count, peerId, joined) {
  setPresence(count)
  // thiết bị mới vào → gửi cho nó toàn bộ ghi chú đang có
  if (!joined || !link) return
  link.send({ t: 'sync', notes: [], dead: [...dead], pin }, peerId)
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
  } else if (op.t === 'pin') {
    applyPin(op.pin)
  } else if (op.t === 'sync') {
    if (Array.isArray(op.dead)) op.dead.forEach(killNote)
    applyPin(op.pin)
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
  // text luôn là bản chữ thường (máy cũ vẫn đọc được); rich = HTML rút gọn, lọc lại khi hiển thị
  const rich = n.fmt === 'rich' && typeof n.rich === 'string' && n.rich.length <= MAX_RICH ? n.rich : ''
  const fmt = n.fmt === 'md' ? 'md' : rich ? 'rich' : ''
  return { id: n.id, at: n.at, by: typeof n.by === 'string' ? n.by.slice(0, 32) : '', text, fmt, rich, imgs, files, voice }
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
  if (pin.id === n.id) renderPin() // ghim tới trước, tin tới sau (đồng bộ lúc mới vào)
  updateEmpty()
  if (stick) scrollDown()
  return true
}

function killNote(id) {
  if (typeof id !== 'string') return
  dead.add(id)
  if (!notes.delete(id)) return
  const li = list.querySelector(`li[data-id="${CSS.escape(id)}"]`)
  const next = li?.nextElementSibling
  li?.remove()
  regroup(next)
  if (pin.id === id) pin = { ...pin, id: null } // xoá tin đang ghim → bỏ ghim luôn
  renderPin()
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
    const p = make('div', 'note-text ' + (n.fmt || 'plain'))
    p.append(n.fmt === 'md' ? renderMarkdown(n.text) : n.fmt === 'rich' ? renderRich(n.rich) : linkText(n.text))
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
  del.addEventListener('click', () => deleteNote(n.id))
  const pinBtn = make('button', 'icon-btn note-pin')
  pinBtn.type = 'button'
  pinBtn.append(icon('i-pin'))
  pinBtn.addEventListener('click', () => (pin.id === n.id ? unpin() : pinNote(n.id)))
  const pinMark = make('span', 'pin-mark')
  pinMark.append(icon('i-pin'))
  pinMark.title = 'Pinned'
  meta.append(time, pinMark, pinBtn, del)

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

/* ---- Hộp thoại xác nhận (dialog M3) dùng chung ---- */
function confirmBox({ icon: ic, title, text, ok }) {
  $('confirm-icon').setAttribute('href', '#' + ic)
  $('confirm-title').textContent = title
  $('confirm-text').textContent = text
  $('confirm-ok').textContent = ok
  confirmDialog.returnValue = ''
  confirmDialog.classList.remove('closing')
  confirmDialog.showModal()
  return new Promise(resolve => confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'ok'), { once: true }))
}

// Nút trong hộp thoại và phím Esc: chạy hiệu ứng thu lại rồi mới đóng thật
function closeDialog(value) {
  if (confirmDialog.classList.contains('closing')) return
  confirmDialog.classList.add('closing')
  afterAnim(confirmDialog, () => {
    confirmDialog.classList.remove('closing')
    confirmDialog.close(value)
  })
}
confirmDialog.querySelector('form').addEventListener('submit', e => {
  e.preventDefault()
  closeDialog(e.submitter?.value || '')
})
confirmDialog.addEventListener('cancel', e => {
  e.preventDefault()
  closeDialog('')
})

async function deleteNote(id) {
  const ok = await confirmBox({
    icon: 'i-delete',
    title: 'Delete this message?',
    text: pin.id === id
      ? 'It will be removed from every signed-in device, and the pin will be removed too.'
      : 'It will be removed from every signed-in device.',
    ok: 'Delete',
  })
  if (!ok || !notes.has(id)) return
  killNote(id)
  link?.send({ t: 'del', id })
  showSnack('Message deleted')
}

/* ---- Ghim tin nhắn: chỉ 1 tin, đồng bộ mọi thiết bị ---- */
async function pinNote(id) {
  if (pin.id && pin.id !== id && notes.has(pin.id)) {
    const ok = await confirmBox({
      icon: 'i-pin',
      title: 'Replace pinned message?',
      text: 'Only one message can be pinned. The message that is pinned now will be unpinned.',
      ok: 'Pin',
    })
    if (!ok) return
  }
  if (!notes.has(id)) return
  setPin({ id, at: Date.now(), by: myName })
  showSnack('Message pinned')
}

function unpin() {
  if (!pin.id) return
  setPin({ id: null, at: Date.now(), by: myName })
  showSnack('Message unpinned')
}

function setPin(p) {
  pin = p
  renderPin()
  link?.send({ t: 'pin', pin: p })
}

function applyPin(p) {
  if (!p || !Number.isFinite(p.at)) return
  const id = typeof p.id === 'string' && !dead.has(p.id) ? p.id : null
  if (p.at < pin.at || (p.at === pin.at && String(id) <= String(pin.id))) return // giữ bản mới hơn
  pin = { id, at: p.at, by: typeof p.by === 'string' ? p.by.slice(0, 32) : '' }
  renderPin()
}

function noteSummary(n) {
  if (n.text.trim() && n.fmt === 'md') return plainSnippet(n.text)
  if (n.text.trim()) {
    const t = n.text.replace(/\s+/g, ' ').trim()
    return t.length > 90 ? t.slice(0, 89) + '…' : t
  }
  if (n.voice) return 'Voice message'
  if (n.files.length) return n.files.map(f => f.name).join(', ')
  return n.imgs.length > 1 ? `${n.imgs.length} photos` : 'Photo'
}

function renderPin() {
  const n = pin.id && notes.get(pin.id)
  pinBar.hidden = !n
  if (n) {
    $('pin-label').textContent = `Pinned · ${n.by || 'Unknown'}`
    $('pin-snippet').textContent = noteSummary(n)
  }
  for (const li of list.children) {
    const on = !!n && li.dataset.id === pin.id
    li.classList.toggle('pinned', on)
    const b = li.querySelector('.note-pin')
    if (b) {
      b.setAttribute('aria-pressed', String(on))
      b.title = on ? 'Unpin message' : 'Pin message'
      b.setAttribute('aria-label', b.title)
    }
  }
}

function jumpTo(id) {
  const li = list.querySelector(`li[data-id="${CSS.escape(id)}"]`)
  if (!li) return
  li.scrollIntoView({ behavior: 'smooth', block: 'center' })
  li.classList.remove('flash')
  void li.offsetWidth
  li.classList.add('flash')
}

$('pin-jump').addEventListener('click', () => pin.id && jumpTo(pin.id))
$('pin-close').addEventListener('click', unpin)

// Nút "Copy" trong khối code
list.addEventListener('click', async e => {
  const b = e.target.closest('.code-copy')
  if (!b) return
  const code = b.closest('.code-block').querySelector('code').textContent
  try {
    await navigator.clipboard.writeText(code)
    b.textContent = 'Copied'
  } catch {
    // trình duyệt cũ / không cho quyền clipboard → cách cũ
    const t = make('textarea')
    t.value = code
    t.style.position = 'fixed'
    t.style.opacity = '0'
    document.body.append(t)
    t.select()
    b.textContent = document.execCommand('copy') ? 'Copied' : 'Copy failed'
    t.remove()
  }
  setTimeout(() => (b.textContent = 'Copy'), 1500)
})

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
  showEl(snackbar)
  snackTimer = setTimeout(hideSnack, action ? 5000 : 3000)
}

function hideSnack() {
  clearTimeout(snackTimer)
  hideEl(snackbar)
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

function updateEmpty() {
  empty.hidden = notes.size > 0
}

function nearBottom() {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120
}

function scrollDown() {
  requestAnimationFrame(() => feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' }))
}

/* ---- Xoá tất cả ---- */
$('clear-btn').addEventListener('click', async () => {
  if (!notes.size) {
    showSnack('There are no messages to clear')
    return
  }
  const ok = await confirmBox({
    icon: 'i-sweep',
    title: 'Clear all messages?',
    text: "All messages are removed from every signed-in device. This can't be undone.",
    ok: 'Clear all',
  })
  if (!ok) return
  const ids = [...notes.keys()]
  ids.forEach(killNote)
  link?.send({ t: 'clear', ids })
  showSnack('All messages cleared')
})

feed.addEventListener('scroll', () => appBar.classList.toggle('scrolled', feed.scrollTop > 0), { passive: true })

/* ================= SOẠN & GỬI ================= */
composer.addEventListener('submit', async e => {
  e.preventDefault()
  const rich = mode === 'rich' && hasText() ? serialize(richBox) : ''
  const text = (mode === 'rich' ? richBox.innerText : textBox.value).replace(/\s+$/, '')
  if ((!text.trim() && !pending.length) || busy) return
  if (rich.length > MAX_RICH || text.length > 5000) {
    composeErr.textContent = 'This message is too long.'
    return
  }
  const note = {
    id: crypto.randomUUID(),
    at: Date.now(),
    by: myName,
    text: text.trim() ? text : '',
    fmt: text.trim() ? (rich ? 'rich' : mode === 'md' ? 'md' : '') : '',
    rich,
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
  const inFence = mode === 'md' && (textBox.value.slice(0, textBox.selectionStart).match(/```/g) || []).length % 2 === 1
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse && !inFence) {
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
function hasText() {
  return mode === 'rich' ? !!richBox.textContent.trim() : !!textBox.value.trim()
}

function focusInput() {
  ;(mode === 'rich' ? richBox : textBox).focus()
}

function refreshSend() {
  const has = hasText() || pending.length > 0
  sendBtn.hidden = !has
  micBtn.hidden = has || !canRecord
  sendBtn.disabled = busy > 0 || !has
  composeErr.textContent = ''
}

function resetComposer() {
  textBox.value = ''
  richBox.replaceChildren()
  richBox.classList.add('blank')
  pending = []
  renderPreviews()
  grow()
  refreshSend()
}

/* ---- Nút + : đính kèm, bật/tắt định dạng ---- */
$('pick-media').addEventListener('click', () => {
  closeMenus()
  $('media').click()
})
$('pick-file').addEventListener('click', () => {
  closeMenus()
  fileInput.click()
})
$('mode-rich').addEventListener('click', () => {
  closeMenus()
  setMode(mode === 'rich' ? '' : 'rich')
})
$('mode-md').addEventListener('click', () => {
  closeMenus()
  setMode(mode === 'md' ? '' : 'md')
})
$('rich-off').addEventListener('click', () => setMode(''))
$('md-off').addEventListener('click', () => setMode(''))

const HINTS = {
  '': 'Enter to post · Shift + Enter for a new line',
  md: 'Markdown on · Enter to post · inside a ``` block, Enter adds a line',
  rich: 'Formatting on · select text, then pick a style · Enter to post',
}

// Đổi kiểu soạn: chữ đã gõ được giữ lại (sang chữ thường thì bỏ định dạng)
function setMode(next) {
  if (next === mode) return
  if (next === 'rich') {
    richBox.innerText = textBox.value
  } else if (mode === 'rich') {
    textBox.value = richBox.innerText.replace(/\n$/, '')
    richBox.replaceChildren()
  }
  mode = next
  store.set(FORMAT, mode)
  renderMode()
  grow()
  refreshSend()
  focusInput()
}

function renderMode() {
  const rich = mode === 'rich'
  formatBar.hidden = !rich || !!rec
  mdBar.hidden = mode !== 'md' || !!rec
  richBox.hidden = !rich
  textBox.hidden = rich
  richBox.classList.toggle('blank', !richBox.textContent.trim() && !richBox.querySelector('li'))
  $('mode-rich').setAttribute('aria-checked', String(rich))
  $('mode-md').setAttribute('aria-checked', String(mode === 'md'))
  plusBtn.classList.toggle('on', !!mode)
  $('hint').textContent = HINTS[mode]
  if (!rich) setExpanded(false)
}

/* ---- Thanh định dạng kiểu Word ---- */
const sizePop = $('size-pop'), colorPop = $('color-pop')

function exec(cmd, value = null) {
  if (!richBox.contains(document.getSelection()?.anchorNode)) {
    richBox.focus() // mất vùng chọn → đặt con trỏ cuối ô soạn
    document.getSelection()?.selectAllChildren(richBox)
    document.getSelection()?.collapseToEnd()
  }
  document.execCommand('styleWithCSS', false, false) // <b>, <font> thay vì style="" → dễ chuyển sang thẻ cho phép
  document.execCommand(cmd, false, value)
  richBox.dispatchEvent(new Event('input'))
  updateStates() // bấm B khi chưa chọn chữ: vùng chọn không đổi nên selectionchange không chạy
}

// Bấm nút không được lấy focus khỏi ô soạn, nếu không vùng chữ đang chọn sẽ mất
for (const el of [formatBar, sizePop, colorPop]) el.addEventListener('pointerdown', e => {
  if (e.target.closest('button')) e.preventDefault()
})

formatBar.addEventListener('click', e => {
  const b = e.target.closest('button[data-cmd], button[data-pop]')
  if (!b) return
  if (b.dataset.pop) return togglePop($(b.dataset.pop), b)
  closePops()
  exec(b.dataset.cmd)
})

function togglePop(pop, btn) {
  const open = !isShown(pop)
  closePops()
  if (!open) return
  const dock = $('dock').getBoundingClientRect(), r = btn.getBoundingClientRect()
  showEl(pop)
  pop.style.left = Math.max(8, Math.min(r.left - dock.left, dock.width - pop.offsetWidth - 8)) + 'px'
  pop.style.bottom = dock.bottom - r.top + 4 + 'px'
  btn.setAttribute('aria-expanded', 'true')
}

function closePops() {
  for (const p of [sizePop, colorPop]) hideEl(p)
  for (const b of formatBar.querySelectorAll('[data-pop]')) b.setAttribute('aria-expanded', 'false')
}
document.addEventListener('click', e => {
  if (!e.target.closest('.fmt-pop, [data-pop]')) closePops()
})

sizePop.addEventListener('click', e => {
  const b = e.target.closest('[data-size]')
  if (!b) return
  closePops()
  exec('fontSize', SIZES[b.dataset.size] || '3')
})

colorPop.addEventListener('click', e => {
  const b = e.target.closest('[data-color]')
  if (!b) return
  closePops()
  const c = COLORS[b.dataset.color]
  // "mặc định" = màu chữ hiện tại của ô soạn; khi gửi không khớp màu nào nên bị bỏ
  exec('foreColor', c || getComputedStyle(richBox).color)
  $('color-btn').style.setProperty('--pick', c ? `var(--rc-${b.dataset.color})` : '')
})

$('expand-btn').addEventListener('click', () => setExpanded(!composer.classList.contains('expanded')))

function setExpanded(on) {
  composer.classList.toggle('expanded', on)
  const b = $('expand-btn')
  b.setAttribute('aria-pressed', String(on))
  b.title = b.ariaLabel = on ? 'Smaller editor' : 'Larger editor'
  b.querySelector('use').setAttribute('href', on ? '#i-collapse' : '#i-expand')
}

// Nút B / I / U / S / danh sách sáng lên theo vị trí con trỏ
const STATE_CMDS = ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList']
document.addEventListener('selectionchange', updateStates)

function updateStates() {
  if (mode !== 'rich' || !richBox.contains(document.getSelection()?.anchorNode)) return
  for (const cmd of STATE_CMDS) {
    let on = false
    try { on = document.queryCommandState(cmd) } catch { /* trình duyệt không hỗ trợ */ }
    formatBar.querySelector(`[data-cmd="${cmd}"]`).setAttribute('aria-pressed', String(on))
  }
}

richBox.addEventListener('input', () => {
  if (!richBox.textContent.trim() && !richBox.querySelector('li')) {
    if (richBox.innerHTML === '<br>') richBox.replaceChildren()
    richBox.classList.add('blank')
  } else richBox.classList.remove('blank')
  refreshSend()
})

richBox.addEventListener('keydown', e => {
  // máy tính: Enter gửi (trừ trong danh sách: thêm dòng mới), Shift+Enter xuống dòng; điện thoại: Enter xuống dòng
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing || coarse) return
  const node = document.getSelection()?.anchorNode
  const li = (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest('li')
  if (li && richBox.contains(li)) return
  e.preventDefault()
  composer.requestSubmit()
})
if (coarse) richBox.enterKeyHint = 'enter'

// Dán / thả: chỉ lấy chữ thường (không mang HTML, ảnh từ trang khác vào)
richBox.addEventListener('paste', e => {
  e.preventDefault()
  const files = [...(e.clipboardData?.files || [])]
  if (files.length) return addFiles(files)
  document.execCommand('insertText', false, e.clipboardData?.getData('text/plain') || '')
})

// Cmd/Ctrl + Shift + X: bật/tắt định dạng (giống Zalo)
document.addEventListener('keydown', e => {
  if (e.key.toLowerCase() === 'x' && e.shiftKey && (e.metaKey || e.ctrlKey) && !space.hidden && !rec) {
    e.preventDefault()
    setMode(mode === 'rich' ? '' : 'rich')
  }
})

for (const input of [fileInput, $('media')]) {
  input.addEventListener('change', () => {
    addFiles(input.files)
    input.value = ''
  })
}

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
  if (!coarse) focusInput()
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
  formatBar.hidden = mdBar.hidden = true
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
  renderMode()
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
  showEl(lightbox)
}

function closeLightbox() {
  hideEl(lightbox, () => lightbox.firstElementChild.removeAttribute('src'))
}

lightbox.addEventListener('click', closeLightbox)
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return
  if (rec) stopRecording(false)
  else if (isShown(lightbox)) closeLightbox()
  else {
    const open = menus.find(([, m]) => isShown(m))
    if (open) {
      closeMenus()
      open[0].focus()
    }
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

renderMode()
boot()
