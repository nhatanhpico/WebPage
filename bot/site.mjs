// Điều khiển trang Shared Notes bằng Chrome không giao diện (playwright-core + Chrome có sẵn trên máy):
// mở link, xác nhận đúng là trang Shared Notes, đăng nhập, theo dõi tin mới, gửi câu trả lời.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import { PROFILE, ensureHome } from './config.mjs'

// Chạy trong trang trước mọi script của trang: báo về mọi tin được thêm vào #notes
function watchNotes() {
  const read = li => {
    const t = li.querySelector('.note-text')
    let text = ''
    if (t) {
      // khối code: lấy lại dạng ``` (bỏ nhãn ngôn ngữ + nút Copy); innerText chỉ đúng khi phần tử đang hiển thị
      const c = t.cloneNode(true)
      for (const b of c.querySelectorAll('.code-block')) {
        const lang = (b.querySelector('.code-lang')?.textContent || '').replace(/ · auto$/, '')
        const pre = document.createElement('pre')
        pre.textContent = '```' + (lang === 'Plain text' ? '' : lang.toLowerCase()) + '\n' + (b.querySelector('pre code')?.textContent || '').replace(/\n$/, '') + '\n```'
        b.replaceWith(pre)
      }
      const box = document.createElement('div')
      box.style.cssText = 'position:fixed;left:-10000px;top:0;width:640px;opacity:0;pointer-events:none'
      box.append(c)
      document.body.append(box)
      text = c.innerText
      box.remove()
    }
    return {
      id: li.dataset.id,
      at: +li.dataset.at,
      by: li.querySelector('.note-by')?.textContent || '',
      mine: li.classList.contains('mine'),
      own: li.classList.contains('mine') && !!window.__botPosting, // do chính bot vừa gửi
      text,
      images: [...li.querySelectorAll('.note-imgs img')].map(i => i.src),
      files: [...li.querySelectorAll('.file-name')].map(f => f.textContent),
      voice: !!li.querySelector('.voice'),
    }
  }
  document.addEventListener('DOMContentLoaded', () => {
    const list = document.querySelector('#notes')
    if (!list) return
    new MutationObserver(muts => {
      for (const m of muts) {
        for (const li of m.addedNodes) {
          if (li.nodeType === 1 && li.dataset?.id) window.__botNote?.(read(li))
        }
      }
    }).observe(list, { childList: true })
  })
}

export async function open(cfg, { show = false, onNote } = {}) {
  ensureHome()
  if (!fs.existsSync(cfg.chrome)) throw new Error(`Google Chrome not found at ${cfg.chrome}`)
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: cfg.chrome,
    headless: !show,
    viewport: { width: 1000, height: 800 },
    // không giấu IP nội bộ sau tên mDNS: Chrome không giao diện cần để nối WebRTC với các máy cùng mạng
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
  })
  const page = ctx.pages()[0] || await ctx.newPage()
  if (onNote) {
    await page.exposeBinding('__botNote', (_, n) => onNote(n))
    await page.addInitScript(watchNotes)
  }
  await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await verify(page)
  return { ctx, page }
}

// Chỉ chạy trên trang Shared Notes: kiểm tra đúng các thành phần của trang trước khi làm gì khác
async function verify(page) {
  try {
    await page.waitForFunction(() => document.title === 'Shared Notes' &&
      document.querySelector('.signin-app')?.textContent.trim() === 'Shared Notes' &&
      ['#lock', '#lock-user', '#lock-pass', '#notes', '#composer', '#text', '#send-btn', '#plus-menu'].every(s => document.querySelector(s)) &&
      !document.documentElement.classList.contains('resume'), null, { timeout: 20000 })
  } catch {
    throw new Error(`${page.url()} is not a Shared Notes site (or it did not finish loading).`)
  }
}

// 'in' (đã đăng nhập) | 'out' | 'none' (trang chưa có tài khoản nào)
export async function state(page) {
  await page.waitForFunction(() => !document.querySelector('#space').hidden || !document.querySelector('#gate').hidden, null, { timeout: 20000 })
  return page.evaluate(() => {
    if (!document.querySelector('#space').hidden) return 'in'
    return document.querySelector('#lock-btn').disabled ? 'none' : 'out'
  })
}

export async function login(page, user, pass) {
  await page.fill('#lock-user', user)
  await page.fill('#lock-pass', pass)
  await page.click('#lock-btn')
  const r = await page.waitForFunction(() => {
    if (!document.querySelector('#space').hidden) return 'ok'
    const err = document.querySelector('#lock-error').textContent.trim()
    return err && !document.querySelector('#lock-btn').disabled ? err : false
  }, null, { timeout: 30000 })
  const v = await r.jsonValue()
  if (v !== 'ok') throw new Error(v)
}

export async function logout(page) {
  await page.click('#account-btn')
  await page.click('#logout-btn')
  await page.waitForSelector('#gate:not([hidden])')
}

export const accountName = page => page.textContent('#my-name')

// Kiểu soạn của trang: 'md' (Markdown) hoặc '' (chữ thường); tắt định dạng kiểu Word nếu đang bật
async function setFormat(page, format) {
  if (await page.isVisible('#format-bar')) await page.click('#rich-off')
  const md = await page.isVisible('#md-bar')
  if (format === 'md' && !md) {
    await page.click('#plus-btn')
    await page.click('#mode-md')
  } else if (format !== 'md' && md) {
    await page.click('#md-off')
  }
}

// Gửi một tin bằng ô soạn của trang (như người dùng gõ rồi bấm gửi)
export async function post(page, text, format) {
  await setFormat(page, format)
  await page.fill('#text', text)
  await page.evaluate(() => { window.__botPosting = true })
  try {
    await page.click('#send-btn')
  } finally {
    await page.evaluate(() => { window.__botPosting = false })
  }
}

export const peers = page => page.evaluate(() => {
  const m = /(\d+) other/.exec(document.querySelector('#presence-text')?.textContent || '')
  return m ? +m[1] : 0
})
