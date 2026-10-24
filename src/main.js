import './style.css'
import account from './account.js'
import { deriveMaster, verifierOf, sessionKeys, b64, unb64 } from './crypto.js'
import { connect, MAX_BYTES } from './sync.js'

const $ = id => document.getElementById(id)
const html = document.documentElement
const SESSION = 'space_key' // khoá đã dẫn xuất (không phải mật khẩu)
const NAME = 'space_name'
const MAX_IMGS = 6
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
const presence = $('presence'), presenceText = $('presence-text'), me = $('me')
const composer = $('composer'), textBox = $('text'), fileInput = $('file'), previews = $('previews')
const sendBtn = $('send-btn'), composeErr = $('compose-error'), lightbox = $('lightbox')

// Dữ liệu chỉ nằm trong bộ nhớ — đóng hết các thiết bị là mất
const notes = new Map()
const dead = new Set() // id đã xoá: không cho bản cũ từ thiết bị khác "sống lại"
let link = null
let pending = [] // ảnh đã nén, chờ gửi
let busy = 0
let unread = 0

/* ================= LOGIN ================= */
async function boot() {
  if (!account) {
    store.del(SESSION) // tài khoản đã bị xoá → đăng xuất mọi thiết bị
    $('lock-text').innerHTML = 'No account has been set up yet. Run <code>npm run account</code>, then push.'
    for (const x of [lockUser, lockPass, lockBtn]) x.disabled = true
    html.classList.remove('resume')
    return
  }
  const saved = store.get(SESSION)
  if (saved) {
    try {
      const s = JSON.parse(saved)
      const master = unb64(s.key)
      if (s.salt === account.salt && (await verifierOf(master)) === account.verify) return enter(master)
    } catch { /* phiên hỏng */ }
    store.del(SESSION) // đổi mật khẩu → phiên cũ hết hiệu lực
  }
  html.classList.remove('resume')
}

lock.addEventListener('submit', async e => {
  e.preventDefault()
  lockBtn.disabled = true
  lockBtn.textContent = 'Signing in…'
  lockErr.textContent = ''
  try {
    const master = await deriveMaster(lockUser.value, lockPass.value, account.salt, account.iterations)
    if ((await verifierOf(master)) !== account.verify) {
      lockErr.textContent = 'Incorrect account or password.'
      lock.classList.remove('shake')
      void lock.offsetWidth
      lock.classList.add('shake')
      lockPass.select()
      return
    }
    store.set(SESSION, JSON.stringify({ salt: account.salt, key: b64(master) }))
    lockPass.value = ''
    await enter(master)
  } catch (err) {
    console.error(err)
    lockErr.textContent = 'Something went wrong, please try again'
  } finally {
    lockBtn.disabled = false
    lockBtn.textContent = 'Sign in'
  }
})

async function enter(master) {
  const keys = await sessionKeys(master)
  html.classList.remove('resume')
  gate.hidden = true
  space.hidden = false
  me.value = store.get(NAME) || deviceName()
  setPresence(0)
  updateEmpty()
  link = connect(keys, { onOp, onPeers })
  if (!coarse) textBox.focus()
}

$('logout-btn').addEventListener('click', () => {
  link?.leave()
  link = null
  store.del(SESSION)
  notes.clear()
  dead.clear()
  list.replaceChildren()
  resetComposer()
  space.hidden = true
  gate.hidden = false // hiện lại → animation của thẻ chạy lại
  lockUser.focus()
})

function deviceName() {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android'
  if (/Mac/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'PC'
  return 'Me'
}

/* ================= ĐỒNG BỘ ================= */
function onPeers(count, peerId, joined) {
  setPresence(count)
  // thiết bị mới vào → gửi cho nó toàn bộ ghi chú đang có
  if (joined && link) link.send({ t: 'sync', notes: [...notes.values()], dead: [...dead] }, peerId)
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

// Dữ liệu từ thiết bị khác cũng kiểm tra lại cho chắc
function clean(n) {
  if (!n || typeof n.id !== 'string' || n.id.length > 64 || !Number.isFinite(n.at)) return null
  const text = typeof n.text === 'string' ? n.text.slice(0, 5000) : ''
  const imgs = (Array.isArray(n.imgs) ? n.imgs : [])
    .filter(i => i && typeof i.src === 'string' && IMG_RE.test(i.src))
    .slice(0, MAX_IMGS)
    .map(i => ({ src: i.src, w: Math.max(0, i.w | 0), h: Math.max(0, i.h | 0) }))
  if (!text.trim() && !imgs.length) return null
  return { id: n.id, at: n.at, by: typeof n.by === 'string' ? n.by.slice(0, 24) : '', text, imgs }
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
  updateEmpty()
  if (stick) scrollDown()
  return true
}

function killNote(id) {
  if (typeof id !== 'string') return
  dead.add(id)
  if (!notes.delete(id)) return
  list.querySelector(`li[data-id="${CSS.escape(id)}"]`)?.remove()
  updateEmpty()
}

function isMine(n) {
  return n.by.trim().toLowerCase() === me.value.trim().toLowerCase()
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
  const card = make('article', 'note-card')

  const head = make('header', 'note-head')
  const by = n.by || 'Unknown'
  const time = make('time', 'note-time', when(n.at))
  time.dateTime = new Date(n.at).toISOString()
  time.title = new Date(n.at).toLocaleString()
  const del = make('button', 'note-del', 'Delete')
  del.type = 'button'
  del.title = 'Delete on all devices'
  armed(del, 'Confirm', () => {
    killNote(n.id)
    link?.send({ t: 'del', id: n.id })
  })
  head.append(make('span', 'avatar', initials(by)), make('span', 'note-by', by), time, del)
  card.append(head)

  if (n.text.trim()) {
    const p = make('p', 'note-text')
    linkify(p, n.text)
    card.append(p)
  }
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
    card.append(grid)
  }
  li.append(card)
  return li
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
  empty.hidden = notes.size > 0
}

function nearBottom() {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120
}

function scrollDown() {
  requestAnimationFrame(() => feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' }))
}

// Bấm lần 1 hỏi lại, lần 2 mới làm (không dùng confirm())
function armed(btn, label, action) {
  let timer = 0
  const target = btn.querySelector('.label') || btn
  const original = target.textContent
  btn.addEventListener('click', () => {
    if (btn.classList.contains('armed')) {
      clearTimeout(timer)
      btn.classList.remove('armed')
      target.textContent = original
      action()
      return
    }
    btn.classList.add('armed')
    target.textContent = label
    timer = setTimeout(() => {
      btn.classList.remove('armed')
      target.textContent = original
    }, 2500)
  })
}

armed($('clear-btn'), 'Confirm clear', () => {
  const ids = [...notes.keys()]
  ids.forEach(killNote)
  link?.send({ t: 'clear', ids })
})

me.addEventListener('input', () => {
  store.set(NAME, me.value.trim())
  for (const li of list.children) li.classList.toggle('mine', isMine(notes.get(li.dataset.id)))
})
me.addEventListener('blur', () => {
  if (!me.value.trim()) me.value = deviceName()
  store.set(NAME, me.value.trim())
})

/* ================= SOẠN & GỬI ================= */
composer.addEventListener('submit', async e => {
  e.preventDefault()
  const text = textBox.value.replace(/\s+$/, '')
  if ((!text.trim() && !pending.length) || busy) return
  const note = {
    id: crypto.randomUUID(),
    at: Date.now(),
    by: me.value.trim() || deviceName(),
    text: text.trim() ? text : '',
    imgs: pending.map(({ src, w, h }) => ({ src, w, h })),
  }
  if (JSON.stringify(note).length > MAX_BYTES) {
    composeErr.textContent = 'This note is too large. Try attaching fewer images.'
    return
  }
  resetComposer()
  addNote(note)
  if (!link) return
  const li = list.querySelector(`li[data-id="${CSS.escape(note.id)}"]`)
  const big = note.imgs.length > 0 && link.peers() > 0
  if (big && li) li.classList.add('sending')
  try {
    await link.send({ t: 'add', note }, null, big && li ? p => li.style.setProperty('--p', p) : null)
  } catch (err) {
    console.warn('[space] send failed', err)
  } finally {
    li?.classList.remove('sending')
  }
})

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

function grow() {
  textBox.style.height = 'auto'
  textBox.style.height = textBox.scrollHeight + 'px'
}

function refreshSend() {
  sendBtn.disabled = busy > 0 || (!textBox.value.trim() && !pending.length)
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
  const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'))
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

async function addFiles(files) {
  const imgs = [...files].filter(f => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name))
  if (!imgs.length) return
  const room = MAX_IMGS - pending.length
  if (room <= 0) {
    composeErr.textContent = `You can attach up to ${MAX_IMGS} images per note.`
    return
  }
  busy++
  refreshSend()
  composeErr.textContent = imgs.length > room ? `You can attach up to ${MAX_IMGS} images per note.` : ''
  for (const f of imgs.slice(0, room)) {
    try {
      pending.push(await prepImage(f))
      renderPreviews()
    } catch (err) {
      console.warn(err)
      composeErr.textContent = `Couldn't read the image “${f.name}”.`
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
    const box = make('div', 'preview')
    const img = make('img')
    img.src = p.src
    img.alt = ''
    const x = make('button', 'preview-x', '×')
    x.type = 'button'
    x.setAttribute('aria-label', 'Remove image')
    x.addEventListener('click', () => {
      pending.splice(i, 1)
      renderPreviews()
      refreshSend()
    })
    box.append(img, x)
    return box
  }))
}

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
  if (e.key === 'Escape' && !lightbox.hidden) closeLightbox()
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
