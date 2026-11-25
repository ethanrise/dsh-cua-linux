/**
 * cdp.js —— Chromium DevTools Protocol 客户端（零依赖：node 内置 fetch + WebSocket）
 *
 * 为什么浏览器必须走这条路：
 *   像素通道                    CDP 通道
 *   ───────────────            ────────────────────────
 *   要置顶、要焦点              不需要，窗口最小化/被遮挡都行
 *   中文要靠剪贴板              Input.insertText 直接插任意 Unicode
 *   定位靠坐标/OCR             CSS selector，精确
 *   一次操作 ~500ms            一次往返 ~5-20ms
 *
 * 前提：目标 Chromium 启动时带 --remote-debugging-port=PORT。
 * 注意：Chrome 111+ 会校验 WS 的 Origin，需要 --remote-allow-origins=*（launch() 已带）。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 探测某个端口上是否有可用的 DevTools 端点。 */
export async function hasDebugPort(port, timeoutMs = 800) {
  try {
    const ctrl = AbortSignal.timeout(timeoutMs)
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ctrl })
    return res.ok
  } catch {
    return false
  }
}

/**
 * 起一个可调试的 Chromium（独立 profile，不碰用户正在用的实例）。
 * @returns {import('node:child_process').ChildProcess}
 */
export async function launch({ port = 9222, url = 'about:blank', profileDir, headless = false, bin } = {}) {
  const { spawn } = await import('node:child_process')
  const os = await import('node:os')
  const path = await import('node:path')
  const fs = await import('node:fs')

  const exe = bin || process.env.CUA_CHROME || '/usr/bin/google-chrome'
  const profile = profileDir || path.join(os.tmpdir(), `cua-chrome-profile-${port}`)
  fs.mkdirSync(profile, { recursive: true })

  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--window-size=1280,900',
  ]
  if (headless) args.push('--headless=new')
  args.push(url)

  const proc = spawn(exe, args, { detached: true, stdio: 'ignore' })
  proc.unref()
  return proc
}

/** 等 DevTools 端口就绪。 */
export async function waitReady(port, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await hasDebugPort(port)) return true
    await sleep(250)
  }
  throw new Error(`DevTools 端口 ${port} 在 ${timeoutMs}ms 内未就绪（Chrome 是否带 --remote-debugging-port 启动？）`)
}

/** 一条到某个 page target 的 CDP 会话。 */
export class Cdp {
  constructor(port = 9222, timeoutMs = 10000) {
    this.port = port
    this.timeoutMs = timeoutMs
    this.ws = null
    this.seq = 0
    this.pending = new Map()
    this.target = null
  }

  async listTabs() {
    const res = await fetch(`http://127.0.0.1:${this.port}/json/list`)
    if (!res.ok) throw new Error(`/json/list 返回 ${res.status}`)
    const all = await res.json()
    return all.filter((t) => t.type === 'page')
  }

  /** 连接到某个 tab；urlSubstr 为空则取第一个。 */
  async attach(urlSubstr = null, index = 0) {
    let tabs = await this.listTabs()
    if (urlSubstr) tabs = tabs.filter((t) => (t.url || '').toLowerCase().includes(urlSubstr.toLowerCase()))
    if (!tabs.length) throw new Error(`没有匹配的 tab（urlSubstr=${JSON.stringify(urlSubstr)}）`)
    this.target = tabs[index] ?? tabs[0]
    await this._open(this.target.webSocketDebuggerUrl)
    for (const domain of ['Page', 'Runtime', 'DOM']) {
      await this.send(`${domain}.enable`)
    }
    return this.target
  }

  _open(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), this.timeoutMs)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        this.ws = ws
        ws.addEventListener('message', (ev) => this._onMessage(ev))
        ws.addEventListener('close', () => {
          for (const [, p] of this.pending) p.reject(new Error('CDP 连接已关闭'))
          this.pending.clear()
        })
        resolve()
      })
      ws.addEventListener('error', (ev) => {
        clearTimeout(timer)
        reject(new Error(`WebSocket 连接失败（Chrome 111+ 需 --remote-allow-origins=*）：${ev.message || ''}`))
      })
    })
  }

  _onMessage(ev) {
    let msg
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
    } catch {
      return
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.method || 'CDP'} 失败: ${msg.error.message}`))
      else resolve(msg.result || {})
    }
    // 其余是事件推送，M2 不需要
  }

  send(method, params = {}) {
    if (!this.ws) throw new Error('未 attach')
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时 ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    try { this.ws?.close() } catch { /* ignore */ }
    this.ws = null
  }

  // ---------------- 高层封装 ----------------

  async navigate(url, { wait = true, timeoutMs = 15000 } = {}) {
    await this.send('Page.navigate', { url })
    if (!wait) return
    await sleep(300)
    await this.waitFor("document.readyState === 'complete'", timeoutMs)
  }

  async evaluate(expression, { awaitPromise = false } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise, userGesture: true,
    })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error(`JS 异常: ${d.text} ${d.exception?.description || ''}`.trim())
    }
    return r.result?.value
  }

  async waitFor(expression, timeoutMs = 10000, intervalMs = 120) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      try {
        if (await this.evaluate(expression)) return true
      } catch { /* 页面跳转中会短暂报错 */ }
      await sleep(intervalMs)
    }
    throw new Error(`等待条件超时: ${expression}`)
  }

  waitForSelector(selector, timeoutMs) {
    return this.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, timeoutMs)
  }

  /**
   * 等元素**真正可见**（有布局尺寸），而不是「DOM 里存在」。
   * ⚠️ 只等 selector 命中会在 DOM 已解析、还没绘制时截到空白页——Bing 上就复现过。
   */
  waitVisible(selector, timeoutMs = 10000) {
    return this.waitFor(
      `(() => { const e = document.querySelector(${JSON.stringify(selector)});
        if (!e) return false; const r = e.getBoundingClientRect();
        return r.height > 0 && r.width > 0; })()`, timeoutMs)
  }

  /** 聚焦元素（不改值）。 */
  async focus(selector) {
    const okFocus = await this.evaluate(
      `(() => { const e = document.querySelector(${JSON.stringify(selector)});
        if (!e) return false; e.scrollIntoView({block:'center'}); e.focus(); return true; })()`)
    if (!okFocus) throw new Error(`找不到元素: ${selector}`)
  }

  /**
   * 填输入框。先 select() 再 insertText —— 任意 Unicode 都能进，中文不需要输入法。
   */
  async fill(selector, text) {
    await this.focus(selector)
    await this.evaluate(
      `(() => { const e = document.querySelector(${JSON.stringify(selector)});
        if (e && e.select) e.select(); else if (e) e.value = ''; return true; })()`)
    await this.send('Input.insertText', { text: String(text) })
  }

  /** 按键：Enter / Tab / Escape / Backspace / ArrowDown 等。 */
  async press(key) {
    const table = {
      Enter: [13, 'Enter'], Tab: [9, 'Tab'], Escape: [27, 'Escape'],
      Backspace: [8, 'Backspace'], ArrowDown: [40, 'ArrowDown'], ArrowUp: [38, 'ArrowUp'],
    }
    const [vk, code] = table[key] || [0, key]
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
    if (key === 'Enter') await this.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...base })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  /**
   * 真实鼠标点击（不是 el.click()）：触发 pointerdown/mousedown/up，行为接近人手。
   * 坐标是视口坐标，和窗口在屏幕哪里、有没有被遮挡无关。
   */
  async click(selector) {
    await this.evaluate(
      `(() => { const e = document.querySelector(${JSON.stringify(selector)});
        if (e) e.scrollIntoView({block:'center'}); return true; })()`)
    const box = await this.evaluate(
      `(() => { const e = document.querySelector(${JSON.stringify(selector)});
        if (!e) return null; const r = e.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`)
    if (!box) throw new Error(`找不到元素: ${selector}`)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left', clickCount: 1,
      })
    }
  }

  /**
   * 等页面「静默」：readyState=complete 且 body 文本长度连续两次一致。
   * ⚠️ 只等 selector 出现是不够的——点提交后页面会开始一次导航，
   *    旧文档里的 selector 可能仍然命中，于是你截到的是导航后的空白新页。
   */
  async settle({ timeoutMs = 10000, quietMs = 250, needStable = 2 } = {}) {
    const end = Date.now() + timeoutMs
    let last = -1
    let stable = 0
    while (Date.now() < end) {
      try {
        const st = await this.evaluate(
          "({ rs: document.readyState, len: document.body ? document.body.innerText.length : -1 })")
        if (st.rs === 'complete' && st.len > 0 && st.len === last) stable++
        else stable = 0
        last = st.len
        if (stable >= needStable) return true
      } catch {
        stable = 0   // 导航中执行上下文会被销毁，属正常
      }
      await sleep(quietMs)
    }
    return false
  }

  /** 装 MutationObserver 计数器（动作前调用），配合 watchRead 判断动作是否真的产生了变化。 */
  async watchBegin() {
    const { WATCH_BEGIN } = await import('./verify.js')
    return this.evaluate(WATCH_BEGIN)
  }

  /** 读突变数与 URL 变化（动作后调用）。 */
  async watchRead() {
    const { WATCH_READ } = await import('./verify.js')
    return this.evaluate(WATCH_READ)
  }

  /** 取文本：selector 为空取 body。 */
  async text(selector = 'body') {
    const t = await this.evaluate(
      `(() => { const e = document.querySelector(${JSON.stringify(selector)});
        return e ? e.innerText : null; })()`)
    return t || ''
  }

  /** 截图（返回 PNG Buffer）。渲染管线直接出图，不依赖窗口是否可见。 */
  async screenshot() {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    return Buffer.from(r.data, 'base64')
  }
}
