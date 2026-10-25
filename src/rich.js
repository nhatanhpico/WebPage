// Định dạng kiểu Word: ô soạn contenteditable + execCommand (B, I, U, S, cỡ chữ, màu, danh sách, thụt lề)
// - Gửi đi: duyệt DOM của ô soạn → HTML rút gọn, chỉ gồm thẻ + lớp cho phép (không bao giờ gửi innerHTML thô)
// - Nhận về: DOMPurify với danh sách cho phép rất hẹp, lọc lại lớp, rồi tự gắn link
import DOMPurify from 'dompurify'

// Màu gửi đi là tên lớp; hiển thị trộn với màu chữ của bong bóng nên đọc được trên mọi giao diện
export const COLORS = { red: '#e53935', orange: '#f57c00', green: '#2e9d4a', blue: '#1e88e5', purple: '#9c3dbf' }
// cỡ của execCommand('fontSize') ↔ lớp
export const SIZES = { s: '2', l: '5', xl: '6' }
const SIZE_OF = { 1: 's', 2: 's', 4: 'l', 5: 'l', 6: 'xl', 7: 'xl' }
const CLASSES = new Set([...Object.keys(COLORS).map(c => 'c-' + c), 'c-def', 'fs-s', 'fs-l', 'fs-xl', 'ind'])
const TAGS = ['b', 'i', 'u', 's', 'span', 'div', 'br', 'ul', 'ol', 'li']
export const MAX_RICH = 20000

const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// '#e53935' | 'rgb(229, 57, 53)' → 'e53935'
function hex(c) {
  const h = /^#?([0-9a-f]{6})$/i.exec((c || '').trim())
  if (h) return h[1].toLowerCase()
  const m = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(c || '')
  return m ? m.slice(1, 4).map(x => (+x).toString(16).padStart(2, '0')).join('') : ''
}
const COLOR_OF = Object.fromEntries(Object.entries(COLORS).map(([k, v]) => [hex(v), k]))

// Thẻ (và lớp) tương ứng với một phần tử trong ô soạn; phần tử lạ → chỉ giữ nội dung
function wrappers(el, tag) {
  const out = []
  if (tag === 'ul' || tag === 'ol' || tag === 'li') out.push([tag])
  else if (tag === 'div' || tag === 'p') out.push(['div'])
  else if (tag === 'blockquote') out.push(['div', 'ind']) // Chrome thụt lề ngoài danh sách bằng blockquote
  if (tag === 'b' || tag === 'strong') out.push(['b'])
  if (tag === 'i' || tag === 'em') out.push(['i'])
  if (tag === 'u') out.push(['u'])
  if (tag === 's' || tag === 'strike' || tag === 'del') out.push(['s'])
  if (tag === 'font') {
    // màu ngoài bảng (= nút "mặc định") → c-def: về màu chữ thường, kể cả khi nằm trong đoạn đã tô màu
    if (el.hasAttribute('color')) out.push(['span', 'c-' + (COLOR_OF[hex(el.getAttribute('color'))] || 'def')])
    const s = SIZE_OF[el.getAttribute('size')]
    if (s) out.push(['span', 'fs-' + s])
  }
  const st = el.style
  if (st?.length) {
    if (st.fontWeight === 'bold' || +st.fontWeight >= 600) out.push(['b'])
    if (st.fontStyle === 'italic') out.push(['i'])
    const deco = st.textDecorationLine || st.textDecoration || ''
    if (deco.includes('underline')) out.push(['u'])
    if (deco.includes('line-through')) out.push(['s'])
    if (st.color) out.push(['span', 'c-' + (COLOR_OF[hex(st.color)] || 'def')])
  }
  return out
}

export function serialize(root) {
  const out = []
  const walk = (node, depth) => {
    for (const c of node.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) out.push(esc(c.data))
      if (c.nodeType !== Node.ELEMENT_NODE || depth > 24) continue
      const tag = c.tagName.toLowerCase()
      if (tag === 'br') {
        out.push('<br>')
        continue
      }
      const wrap = wrappers(c, tag)
      for (const [t, cls] of wrap) out.push(cls ? `<${t} class="${cls}">` : `<${t}>`)
      walk(c, depth + 1)
      for (let i = wrap.length - 1; i >= 0; i--) out.push(`</${wrap[i][0]}>`)
    }
  }
  walk(root, 0)
  return out.join('')
}

export function renderRich(html) {
  const frag = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true, ALLOWED_TAGS: TAGS, ALLOWED_ATTR: ['class'] })
  for (const el of frag.querySelectorAll('[class]')) {
    const keep = [...el.classList].filter(c => CLASSES.has(c))
    if (keep.length) el.className = keep.join(' ')
    else el.removeAttribute('class')
  }
  linkifyIn(frag)
  return frag
}

/* ---- Link bấm được trong chữ thường ---- */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi

function trimUrl(u) {
  while (/[.,;:!?'"*]$/.test(u) || (u.endsWith(')') && !u.includes('('))) u = u.slice(0, -1)
  return u
}

export function linkText(text) {
  const frag = document.createDocumentFragment()
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0])
    if (!url.includes('.', url.indexOf('//') + 2)) continue
    frag.append(text.slice(last, m.index))
    const a = document.createElement('a')
    a.href = url.startsWith('www.') ? 'https://' + url : url
    a.textContent = url
    a.className = 'link'
    a.target = '_blank'
    a.rel = 'noopener noreferrer nofollow'
    frag.append(a)
    last = m.index + url.length
  }
  frag.append(text.slice(last))
  return frag
}

function linkifyIn(root) {
  for (const c of [...root.childNodes]) {
    if (c.nodeType === Node.ELEMENT_NODE) linkifyIn(c)
    else if (c.nodeType === Node.TEXT_NODE && c.data.search(URL_RE) >= 0) c.replaceWith(linkText(c.data))
  }
}
