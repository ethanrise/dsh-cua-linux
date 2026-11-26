/**
 * x11.js —— X11 后端（纯 JS，经 x11 包）。
 *
 * 设计要点（都是这次踩出来的）：
 *   1. 坐标统一：对外一律「窗口本地像素」，进出接口时换算成 root 坐标。
 *   2. 动作前必须 ensureOnTop：X11 指针命中永远是最上层窗口，窗口被挡时点击会
 *      静默打到别的窗口上，而且 XRaiseWindow 在 mutter 下无效，必须发 EWMH。
 *   3. 截图抓 root 再裁：对子窗口直接 GetImage 在 compositor 下常拿到黑图。
 *   4. 键盘走 GetKeyboardMapping 建 keysym→(keycode, shift) 表，不写死键码。
 */
import x11 from 'x11'
import { encodePNG, xImageToRGBA } from './png.js'

export const call = (X, method, ...args) =>
  new Promise((resolve, reject) => X[method](...args, (error, value) => {
    if (error) {
      reject(error)
      // node-x11 emits the error again unless the callback marks it handled.
      return true
    }
    resolve(value)
  }))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const KEYSYMS = {
  Return: 0xff0d, Tab: 0xff09, Escape: 0xff1b, BackSpace: 0xff08, Delete: 0xffff,
  Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54,
  Home: 0xff50, End: 0xff57, Prior: 0xff55, Next: 0xff56,
  shift: 0xffe1, control: 0xffe3, alt: 0xffe9, super: 0xffeb,
}
for (let i = 1; i <= 12; i++) KEYSYMS[`F${i}`] = 0xffbe + i - 1

const MOD_ALIASES = {
  ctrl: 'control', control: 'control', shift: 'shift', alt: 'alt', super: 'super', meta: 'super',
}

let state = null

/** 建立（并复用）到 X server 的连接。 */
export async function connect() {
  if (state) return state
  const display = await new Promise((res, rej) => {
    x11.createClient((err, d) => (err ? rej(err) : res(d)))
  })
  const X = display.client
  // Fire-and-forget XTEST requests can still emit asynchronous errors.
  X.on('error', (error) => {
    console.warn('[dsh-cua-linux] X11 client error:', error.message)
  })
  const root = display.screen[0].root
  // require(name, cb) —— 不传 cb 会在扩展加载完成时抛 'callback is not a function'
  const xtest = await new Promise((res, rej) =>
    X.require('xtest', (error, extension) => {
      if (error) {
        rej(error)
        return true
      }
      res(extension)
    }))

  const atoms = {
    netWmName: await call(X, 'InternAtom', false, '_NET_WM_NAME'),
    utf8: await call(X, 'InternAtom', false, 'UTF8_STRING'),
    netClientListStacking: await call(X, 'InternAtom', false, '_NET_CLIENT_LIST_STACKING'),
    netActiveWindow: await call(X, 'InternAtom', false, '_NET_ACTIVE_WINDOW'),
    netWmPid: await call(X, 'InternAtom', false, '_NET_WM_PID'),
  }

  state = {
    display, X, root, xtest, atoms,
    screen: { width: display.screen[0].pixel_width, height: display.screen[0].pixel_height },
    keymap: null,
  }
  return state
}

export function close() {
  if (state) {
    try { state.X.terminate?.() } catch { /* ignore */ }
    state = null
  }
}

async function getPropData(wid, atom, maxLen = 4096) {
  const { X } = await connect()
  const p = await call(X, 'GetProperty', false, wid, atom, 0, 0, maxLen)
  return p?.data && p.data.length ? p.data : null
}

async function getTitle(wid) {
  const { atoms } = await connect()
  const utf8 = await getPropData(wid, atoms.netWmName)
  if (utf8) return utf8.toString('utf8')
  const legacy = await getPropData(wid, (await connect()).X.atoms.WM_NAME)
  return legacy ? legacy.toString('latin1').replace(/\0+$/, '') : ''
}

async function getApp(wid) {
  const { X } = await connect()
  const data = await getPropData(wid, X.atoms.WM_CLASS)
  if (!data) return ''
  const parts = data.toString('latin1').split('\0').filter(Boolean)
  return parts[1] || parts[0] || ''
}

async function getPid(wid) {
  const { atoms } = await connect()
  const data = await getPropData(wid, atoms.netWmPid, 16)
  return data && data.length >= 4 ? data.readUInt32LE(0) : null
}

/**
 * 枚举可见窗口。
 * @returns {Promise<Array<{wid:number,app:string,title:string,x:number,y:number,w:number,h:number,pid:number|null}>>}
 */
export async function listWindows({ minArea = 4, onlyMapped = true } = {}) {
  const { X, root, atoms } = await connect()
  const managed = await getPropData(root, atoms.netClientListStacking)
  const windows = []
  if (managed) {
    for (let offset = 0; offset + 4 <= managed.length; offset += 4) {
      windows.push(managed.readUInt32LE(offset))
    }
  } else {
    windows.push(...(await call(X, 'QueryTree', root)).children)
  }

  const rows = await Promise.all(windows.map(async (wid) => {
    try {
      const attrs = await call(X, 'GetWindowAttributes', wid)
      if (onlyMapped && attrs.mapState !== 2) return null
      const g = await call(X, 'GetGeometry', wid)
      if (g.width * g.height < minArea) return null
      const tc = await call(X, 'TranslateCoordinates', wid, root, 0, 0)
      const [app, title, pid] = await Promise.all([getApp(wid), getTitle(wid), getPid(wid)])
      return { wid, app, title, pid, x: tc.destX, y: tc.destY, w: g.width, h: g.height }
    } catch {
      return null
    }
  }))

  // QueryTree 是自下而上，反过来 = 自顶向下（越靠前越上层）
  return rows.filter(Boolean).reverse()
}

/** 把窗口提到最前并抢焦点（EWMH _NET_ACTIVE_WINDOW，mutter 只认这个）。 */
export async function windowIdentity(wid) {
  const [pid, title] = await Promise.all([getPid(wid), getTitle(wid)])
  return { wid, pid, title }
}

export async function hasFocus(wid) {
  const { X, root } = await connect()
  let { focus } = await call(X, 'GetInputFocus')
  while (focus > 1 && focus !== root) {
    if (focus === wid) return true
    focus = (await call(X, 'QueryTree', focus)).parent
  }
  return false
}

export async function requireFocus(wid) {
  if (!(await hasFocus(wid))) throw new Error('The target window does not have keyboard focus.')
}

export async function ensureOnTop(wid) {
  if (await hasFocus(wid)) return
  const { X, root, atoms } = await connect()
  const ev = Buffer.alloc(32)
  ev[0] = 33            // ClientMessage
  ev[1] = 32            // format = 32
  ev.writeUInt32LE(wid >>> 0, 4)
  ev.writeUInt32LE(atoms.netActiveWindow >>> 0, 8)
  ev.writeUInt32LE(2, 12)   // source indication: 2 = pager（绕过防焦点窃取）
  ev.writeUInt32LE(0, 16)   // timestamp: CurrentTime
  const active = await getPropData(root, atoms.netActiveWindow, 1)
  ev.writeUInt32LE(active?.length >= 4 ? active.readUInt32LE(0) : 0, 20)
  ev.writeUInt32LE(0, 24)
  ev.writeUInt32LE(0, 28)
  // SubstructureRedirectMask | SubstructureNotifyMask
  await call(X, 'SendEvent', root, false, 0x00180000, ev)
  for (let attempt = 0; attempt < 12; attempt++) {
    if (await hasFocus(wid)) return
    await sleep(25)
  }
  throw new Error('The window manager did not focus the requested window.')
}

/** 窗口本地坐标 -> root 坐标。 */
export async function toRoot(wid, x, y) {
  const { X, root } = await connect()
  const tc = await call(X, 'TranslateCoordinates', wid, root, Math.round(x), Math.round(y))
  return { x: tc.destX, y: tc.destY }
}

async function fakeInput(type, detail, x = 0, y = 0) {
  // ⚠️ 第 4 个参数是 root window，不是「窗口 id 可有可无」——传 0 时按键会被
  //    服务器静默丢弃（按钮/移动恰好还能用，所以很容易误判成"注入器是好的"）。
  const { xtest, X, root } = await connect()
  xtest.FakeInput(type, detail, 0, root, Math.round(x), Math.round(y))
  X.Flush?.()
  await sleep(18)
}

/** 把指针移到窗口本地坐标。 */
export async function movePointer(wid, x, y) {
  const p = await toRoot(wid, x, y)
  await fakeInput(6, 0, p.x, p.y)   // 6 = MotionNotify
  return p
}

/**
 * 点击。button: 1 左 / 2 中 / 3 右。
 * 依赖：调用方应先 ensureOnTop，否则命中的可能是别的窗口。
 */
async function requirePointerTarget(wid, point) {
  const { X, root } = await connect()
  let current = root
  while (current) {
    const hit = await call(X, 'QueryPointer', current)
    if (hit.rootX !== point.x || hit.rootY !== point.y) break
    if (current === wid) return
    current = hit.child
  }
  throw new Error('The pointer does not hit the target window at the requested position.')
}

export async function click(wid, x, y, { button = 1, count = 1, onPointer } = {}) {
  const p = await movePointer(wid, x, y)
  for (let i = 0; i < count; i++) {
    await requirePointerTarget(wid, p)
    onPointer?.(p)
    await fakeInput(4, button, p.x, p.y)   // ButtonPress
    await fakeInput(5, button, p.x, p.y)   // ButtonRelease
  }
}

/** 滚轮：vertical -> 4/5，horizontal -> 6/7。dir=1 向下/向右。 */
export async function scroll(wid, x, y, { notches = 3, axis = 'v', dir = 1, onPointer } = {}) {
  const p = await movePointer(wid, x, y)
  const btn = axis === 'h' ? (dir > 0 ? 7 : 6) : (dir > 0 ? 5 : 4)
  for (let i = 0; i < Math.abs(notches); i++) {
    await requirePointerTarget(wid, p)
    onPointer?.(p)
    await fakeInput(4, btn, p.x, p.y)
    await fakeInput(5, btn, p.x, p.y)
  }
}

async function ensureKeymap() {
  const { X, keymap } = await connect()
  if (keymap) return keymap
  const rows = await call(X, 'GetKeyboardMapping', 8, 248)
  const map = new Map()
  rows.forEach((row, i) => {
    const keycode = 8 + i
    row.forEach((ks, level) => {
      if (ks && !map.has(ks)) map.set(ks, { keycode, shift: level % 2 === 1 })
    })
  })
  state.keymap = map
  return map
}

function keysymOf(name) {
  if (Object.prototype.hasOwnProperty.call(KEYSYMS, name)) return KEYSYMS[name]
  if (name.length === 1) {
    const o = name.charCodeAt(0)
    if (o >= 0x20 && o <= 0x7e) return o
    throw new Error(`非 ASCII 字符 ${name} 无法用 XTEST 注入，请走剪贴板/CDP`)
  }
  throw new Error(`未知按键: ${name}`)
}

/** 按组合键，如 "ctrl+shift+t" / "Return" / "a"。 */
export async function pressKey(combo, wid) {
  const parts = String(combo).split('+').map((s) => s.trim()).filter(Boolean)
  const mods = parts.slice(0, -1).map((m) => MOD_ALIASES[m.toLowerCase()] || m.toLowerCase())
  const base = parts[parts.length - 1]
  const map = await ensureKeymap()
  const modCodes = mods.map((m) => {
    const hit = map.get(KEYSYMS[m])
    if (!hit) throw new Error(`不支持的修饰键: ${m}`)
    return hit.keycode
  })
  const keysym = keysymOf(base)
  if (!map.has(keysym)) throw new Error('The current keyboard layout cannot send that key.')
  if (wid !== undefined) await requireFocus(wid)
  const held = []
  try {
    for (const code of modCodes) {
      await fakeInput(2, code)
      held.push(code)
    }
    await tapKeysymNoMods(keysym)
  } finally {
    for (const code of held.reverse()) await fakeInput(3, code)
  }
}

/** 只按主键（Shift 由 keymap 自动处理）。 */
async function tapKeysymNoMods(ks) {
  const map = await ensureKeymap()
  const hit = map.get(ks)
  if (!hit) throw new Error(`当前键盘布局里没有 keysym 0x${ks.toString(16)}`)
  if (hit.shift) {
    const shiftCode = map.get(KEYSYMS.shift)?.keycode
    await fakeInput(2, shiftCode)
    await fakeInput(2, hit.keycode)
    await fakeInput(3, hit.keycode)
    await fakeInput(3, shiftCode)
  } else {
    await fakeInput(2, hit.keycode)
    await fakeInput(3, hit.keycode)
  }
}

/** 逐字输入 ASCII（中文会明确报错，不静默失败）。 */
export async function typeAscii(text, wid) {
  for (const ch of String(text)) {
    if (wid !== undefined) await requireFocus(wid)
    if (ch === ' ') await tapKeysymNoMods(0x20)
    else await tapKeysymNoMods(keysymOf(ch))
  }
}

/**
 * 抓原始像素（RGBA），用于动作前后的差异比较——不做 PNG 编码，快得多。
 * @returns {Promise<{width:number,height:number,rgba:Buffer}>}
 */
export async function captureRaw(win = null) {
  const { X, root, screen } = await connect()
  let x = 0, y = 0, w = screen.width, h = screen.height
  let offsetX = 0, offsetY = 0
  if (win) {
    const g = await call(X, 'GetGeometry', win)
    const tc = await call(X, 'TranslateCoordinates', win, root, 0, 0)
    x = Math.max(0, tc.destX)
    y = Math.max(0, tc.destY)
    offsetX = x - tc.destX
    offsetY = y - tc.destY
    w = Math.min(tc.destX + g.width, screen.width) - x
    h = Math.min(tc.destY + g.height, screen.height) - y
    if (w <= 0 || h <= 0) throw new Error('窗口不在屏幕可见区域')
  }
  const img = await call(X, 'GetImage', 2, root, x, y, w, h, 0xffffffff)
  return { width: w, height: h, offsetX, offsetY, rgba: xImageToRGBA(img.data, w, h) }
}

/**
 * 截图。win 为空则抓全屏。
 * @returns {Promise<{width:number,height:number,png:Buffer}>}
 */
export async function screenshot(win = null) {
  const raw = await captureRaw(win)
  const { width, height, offsetX, offsetY, rgba } = raw
  return { width, height, offsetX, offsetY, png: encodePNG(width, height, rgba) }
}

/**
 * 只抓一块区域（比全窗便宜，且 diff 时不需要再切片）。
 * box 是「窗口本地坐标」；越界部分会被裁掉。
 * @returns {Promise<{width:number,height:number,rgba:Buffer,box:{x:number,y:number,w:number,h:number}}>}
 */
export async function captureBox(win, box) {
  const { X, root, screen } = await connect()
  let ox = 0, oy = 0, ww = screen.width, wh = screen.height
  if (win) {
    const g = await call(X, 'GetGeometry', win)
    const tc = await call(X, 'TranslateCoordinates', win, root, 0, 0)
    ox = Math.max(0, tc.destX); oy = Math.max(0, tc.destY)
    ww = Math.min(g.width, screen.width - ox); wh = Math.min(g.height, screen.height - oy)
  }
  const x = Math.max(0, Math.min(ww - 1, Math.round(box.x)))
  const y = Math.max(0, Math.min(wh - 1, Math.round(box.y)))
  const w = Math.max(1, Math.min(ww - x, Math.round(box.w)))
  const h = Math.max(1, Math.min(wh - y, Math.round(box.h)))
  const img = await call(X, 'GetImage', 2, root, ox + x, oy + y, w, h, 0xffffffff)
  return { width: w, height: h, rgba: xImageToRGBA(img.data, w, h), box: { x, y, w, h } }
}

/** 窗口尺寸，用于动作前校验坐标是否越界。 */
export async function windowSize(wid) {
  const { X } = await connect()
  const g = await call(X, 'GetGeometry', wid)
  return { width: g.width, height: g.height }
}
