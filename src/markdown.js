// Markdown → DOM an toàn: marked (GFM) + highlight.js + DOMPurify
// - HTML thô trong tin nhắn hiển thị nguyên văn (không bao giờ chạy)
// - Ảnh markdown không được tải (tránh ảnh theo dõi từ ngoài) — chỉ hiện chữ thay thế
// - Khối code: ```python → dùng ngôn ngữ đã gõ; không gõ → tự nhận diện
import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'

const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// Dấu hiệu rõ ràng của các ngôn ngữ phổ biến — highlight.js đoán kém với đoạn code ngắn
const SIGNS = [
  ['python', /^\s*(def |class \w+(\(.*\))?:|from \w[\w.]* import |import \w+$|print\(|elif |if __name__)/m],
  ['javascript', /\b(console\.log|document\.|require\(|module\.exports)|=>|^\s*(const|let|var) \w+\s*=|\bfunction\s*\w*\s*\(/m],
  ['typescript', /^\s*(interface|type) \w+.*[{=]|:\s*(string|number|boolean)\b/m],
  ['go', /^\s*(package \w+|func \w*\(|import \()/m],
  ['rust', /\bfn \w+\s*\(|\blet mut \b|println!\(/],
  ['cpp', /^\s*#include\s*<|\bstd::|cout\s*<</m],
  ['java', /\bpublic (static )?(class|void)\b|System\.out\.print/],
  ['csharp', /\busing System\b|Console\.Write(Line)?\(|\bnamespace \w+/],
  ['php', /<\?php/],
  ['ruby', /^\s*(def \w+|end)$|\bputs\b/m],
  ['sql', /^\s*(SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE)\b/im],
  ['bash', /^\s*(#!\/bin\/(ba)?sh|\$ |sudo |npm |git |cd |echo |export \w+=)/m],
  ['xml', /^\s*<(!DOCTYPE|html|div|svg|\?xml)/im],
  ['css', /^\s*[.#]?[\w-]+\s*\{[^}]*:[^}]*\}/m],
]
const POPULAR = ['javascript', 'typescript', 'python', 'java', 'c', 'cpp', 'csharp', 'go', 'rust', 'php', 'ruby', 'kotlin',
  'swift', 'sql', 'bash', 'json', 'yaml', 'xml', 'css', 'scss', 'markdown', 'diff', 'ini']

function detect(code) {
  const t = code.trim()
  if (/^[[{]/.test(t)) {
    try {
      JSON.parse(t)
      return 'json'
    } catch { /* không phải JSON */ }
  }
  for (const [lang, re] of SIGNS) if (re.test(code)) return lang
  return hljs.highlightAuto(code, POPULAR).language || null
}

function highlight(code, lang) {
  const name = (lang || '').trim().split(/\s+/)[0].toLowerCase()
  const known = name && hljs.getLanguage(name)
  if (known) return { html: hljs.highlight(code, { language: name, ignoreIllegals: true }).value, label: known.name }
  const found = !name && detect(code)
  const def = found && hljs.getLanguage(found)
  // gõ tên lạ (vd. ```foo) → giữ tên đó làm nhãn, không tô màu
  if (!def) return { html: esc(code), label: name || 'Plain text' }
  return { html: hljs.highlight(code, { language: found, ignoreIllegals: true }).value, label: `${def.name} · auto` }
}

const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      const { html, label } = highlight(text, lang)
      return `<div class="code-block"><div class="code-head"><span class="code-lang">${esc(label)}</span>` +
        `<button type="button" class="code-copy">Copy</button></div><pre><code class="hljs">${html}</code></pre></div>`
    },
    html({ text }) {
      return esc(text)
    },
    image({ text }) {
      return esc(text)
    },
  },
})

DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer nofollow')
    node.classList.add('link')
  }
})

const PURIFY = {
  RETURN_DOM_FRAGMENT: true,
  FORBID_TAGS: ['img', 'style', 'form', 'input', 'textarea', 'select', 'iframe', 'svg', 'math', 'video', 'audio'],
  FORBID_ATTR: ['style'],
}

export function renderMarkdown(text) {
  return DOMPurify.sanitize(md.parse(text), PURIFY)
}

// Tóm tắt một dòng cho thanh "tin đã ghim": bỏ ký hiệu markdown
export function plainSnippet(text, max = 90) {
  const s = text
    .replace(/```[\s\S]*?(```|$)/g, ' [code] ')
    .replace(/[`*_~>#|]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}
