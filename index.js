/**
 * dsh-cua-linux —— 给 DSH 补上 Linux（X11 / XWayland）的 computer-use 后端。
 *
 * 通道优先级：CDP（浏览器，见 M2） > X11 像素。
 *
 * 工具：
 *   cua_linux_probe       只读探测：这台机器能怎么操作
 *   cua_linux_windows     枚举可见窗口（含 app / 标题 / 屏幕坐标 / 尺寸）
 *   cua_linux_screenshot  截图（整屏或单窗口）写 PNG 到磁盘，返回路径
 *   cua_linux_click       点击（窗口本地坐标，默认先置顶）
 *   cua_linux_key         组合键 / 特殊键
 *   cua_linux_type        输入 ASCII 文本（非 ASCII 明确报错，不静默失败）
 *   cua_linux_scroll      滚轮
 *
 * 已知边界：
 *   - 只对 X11 / XWayland 客户端有效；原生 Wayland 窗口收不到 XTEST 事件。
 *   - 中文无法用 XTEST 注入（XTEST 只能发 keycode），需要 CDP 或剪贴板，M2 补。
 *   - 目标窗口必须先置顶，否则命中会落到上层窗口（工具默认自动置顶）。
 */
export const name = 'dsh-cua-linux'

export const inject = ['tools']

// 宿主提供则用官方 defineTool 校验参数/输出；否则退化为身份函数，便于本地单测。
let defineTool = (def) => def
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  if (mod && typeof mod.defineTool === 'function') defineTool = mod.defineTool
} catch {
  // 非 DSH 环境：走兜底
}

const OUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      result: { type: 'string', required: true },
    },
  },
  render: (_args, value) => [{ type: 'text', text: value.result }],
}

const ok = (result) => ({ ok: true, result })
const fail = (result) => ({ ok: false, result })

/** 统一包一层：把异常变成 ok:false，而不是把栈抛给模型。 */
const guard = (fn) => async (args) => {
  try {
    return await fn(args || {})
  } catch (err) {
    return fail(`✗ ${err && err.message ? err.message : String(err)}`)
  }
}

function fmtWindow(w) {
  return `0x${w.wid.toString(16)}  ${(w.app || '?').padEnd(16)} ${String(w.title || '(无标题)').slice(0, 40).padEnd(40)} ${w.w}x${w.h}+${w.x}+${w.y}`
}

export function apply(ctx) {
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error('dsh-cua-linux: 需要 ctx.tools.register（宿主未注入 tools 服务）')
  }

  const x11 = () => import('./lib/x11.js')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /**
   * X11 动作闭环：拍前图 → 执行 → 等界面响应 → 拍后图 → 比像素。
   * wid 为空时比较整个屏幕（用于不知道焦点在哪的操作，比如 cua_linux_type）。
   */
  /**
   * 动作闭环（区域版）：
   *   1) 动作前连拍两张 → 判断该区域本身是否在动（光标闪烁/动画/视频）
   *   2) 动作后再拍一张 → 先比动作点附近，再比整窗（影响可能在别处）
   * 只有区域稳定时，前后比对才有意义。
   */
  async function actVerifiedVisual({ wid = null, point = null, radius = 90, label = null, settleMs = 280 }, action) {
    const x = await x11()
    const v = await import('./lib/verify.js')
    const shoot = () => x.captureRaw(wid)

    // 采三帧：光标闪烁周期约 530ms，单次 130ms 间隔会漏掉整个闪烁
    const b1 = await shoot()
    await sleep(250)
    const b2 = await shoot()
    await sleep(250)
    const b3 = await shoot()

    const width = b2.width
    const box = point
      ? { x: point.x - radius, y: point.y - radius, w: radius * 2, h: radius * 2 }
      : null

    // 噪声 = 动作前两帧之间的自发变化（光标闪烁/动画）
    const noise = Math.max(
      (v.diffRGBA(b1.rgba, b2.rgba, 8, { width, box }) || {}).ratio || 0,
      (v.diffRGBA(b2.rgba, b3.rgba, 8, { width, box }) || {}).ratio || 0,
    )

    await action(x)
    await sleep(settleMs)
    const after = await shoot()

    const regionDiff = box
      ? v.diffRGBA(b2.rgba, after.rgba, 8, { width, box })
      : v.diffRGBA(b2.rgba, after.rgba)
    const windowDiff = box ? v.diffRGBA(b2.rgba, after.rgba) : null

    return v.judgeTwoTier({
      noise,
      signal: regionDiff,
      window: windowDiff,
      areaLabel: box ? 'Area around the action point' : label || (wid ? 'Window' : 'Whole screen'),
    })
  }

  /** 把判定结果渲染成一行，失败时用 ⚠ 而不是静默的 ✓。 */
  // verified: true=✓ / false=⚠ / null=?(无法判定)。三种状态必须能区分开，
  // 把 null 画成 ✓ 等于撒谎。
  const line = (j) => `${j.verified === true ? '✓' : j.verified === false ? '⚠' : '?'} ${j.text}`

  ctx.tools.register(defineTool({
    name: 'cua_linux_probe',
    description:
      '探测本机 Linux 桌面当前可用的 computer-use 通道：会话类型（X11/Wayland）、' +
      'X11 socket 与 XTEST 扩展是否可用、cua-driver 是否存在、uinput 是否可用、' +
      '以及本机是否已有 Chromium 调试端口（用于 CDP 直控）。' +
      '只读取环境信息，不点击、不输入、不修改任何状态。',
    parameters: {
      cdpPorts: {
        type: 'string',
        description: '可选：要探测的 Chromium 调试端口，逗号分隔，默认 "9222,9333"。',
      },
    },
    output: OUT,
    execute: guard(async (args) => {
      const { probe } = await import('./lib/probe.js')
      const ports = String(args.cdpPorts || '9222,9333')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0 && n < 65536)
      const report = await probe({ cdpPorts: ports })
      return ok(report.text)
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'cua_linux_windows',
    description:
      '列出当前可见的 X11 窗口：窗口 id、程序名（WM_CLASS）、标题、屏幕绝对坐标、尺寸，' +
      '按叠放顺序自上而下。用于先看清桌面再决定操作哪个窗口。只读。',
    parameters: {
      minArea: {
        type: 'integer',
        description: '可选：最小面积（像素²），默认 4，用于过滤 1x1 的辅助窗口。',
      },
    },
    output: OUT,
    execute: guard(async (args) => {
      const x = await x11()
      const wins = await x.listWindows({ minArea: args.minArea || 4 })
      if (!wins.length) return ok('（没有可见窗口）')
      const lines = wins.map((w, i) => `${i + 1}. ${fmtWindow(w)}`)
      return ok(`${wins.length} visible window(s), top to bottom:\n${lines.join('\n')}`)
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'cua_linux_screenshot',
    description:
      '截图并写入 PNG 文件，返回绝对路径与尺寸。不传 wid 抓全屏；传 wid 抓该窗口（内部抓 root 再裁，' +
      '避免 compositor 下对子窗口取图拿到黑图）。文件写在系统临时目录，可用路径直接查看。',
    parameters: {
      wid: { type: 'integer', description: '可选：窗口 id（cua_linux_windows 输出，十六进制转十进制）。' },
      path: { type: 'string', description: '可选：输出路径，默认写到系统临时目录。' },
    },
    output: OUT,
    execute: guard(async (args) => {
      const fs = await import('node:fs')
      const os = await import('node:os')
      const path = await import('node:path')
      const x = await x11()
      const shot = await x.screenshot(args.wid || null)
      const out = args.path || path.join(os.tmpdir(), `cua-linux-${Date.now()}.png`)
      fs.writeFileSync(out, shot.png)
      const kb = (shot.png.length / 1024).toFixed(0)
      return ok(`Screenshot ${shot.width}x${shot.height} (${kb}KB)\nPath: ${out}`)
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'cua_linux_click',
    description:
      '在窗口本地像素坐标处点击。默认先把窗口置顶（activate=true）——X11 下指针命中永远是最上层窗口，' +
      '不置顶的点击会静默落到别的窗口。坐标以窗口左上角为原点。',
    parameters: {
      wid: { type: 'integer', required: true, description: '目标窗口 id。' },
      x: { type: 'integer', required: true, description: '窗口本地 x（像素）。' },
      y: { type: 'integer', required: true, description: '窗口本地 y（像素）。' },
      button: { type: 'integer', description: '1=左键（默认）2=中键 3=右键。' },
      count: { type: 'integer', description: '点击次数，默认 1（2 即双击）。' },
      activate: { type: 'boolean', description: '是否先置顶窗口，默认 true。' },
    },
    output: OUT,
    execute: guard(async (args) => {
      const x = await x11()
      // 先校验坐标：越界是确定性失败，不该靠"看画面有没有变"来发现
      const size = await x.windowSize(args.wid)
      if (args.x < 0 || args.y < 0 || args.x >= size.width || args.y >= size.height) {
        return fail(`✗ Out of bounds: window 0x${Number(args.wid).toString(16)} is ${size.width}x${size.height}, got (${args.x},${args.y})`)
      }
      if (args.activate !== false) await x.ensureOnTop(args.wid)
      const j = await actVerifiedVisual({ wid: args.wid, point: { x: args.x, y: args.y } }, (X) =>
        X.click(args.wid, args.x, args.y, { button: args.button || 1, count: args.count || 1 }))
      return ok(`Clicked 0x${Number(args.wid).toString(16)} at (${args.x},${args.y}) button=${args.button || 1} count=${args.count || 1}\nVerify: ${line(j)}`)
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'cua_linux_key',
    description:
      '按组合键或特殊键，例如 "ctrl+t" / "shift+tab" / "Return" / "Escape" / "F5"。' +
      '发给当前焦点窗口，因此通常需要先 cua_linux_click 把焦点点进去。',
    parameters: {
      combo: { type: 'string', required: true, description: '组合键，用 + 连接，如 "ctrl+shift+t"。' },
    },
    output: OUT,
    execute: guard(async (args) => {
      const j = await actVerifiedVisual({}, (X) => X.pressKey(args.combo))
      return ok(`Sent key: ${args.combo}\nVerify: ${line(j)}`)
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'cua_linux_type',
    description:
      '逐字输入 ASCII 文本（字母、数字、常用符号）。非 ASCII 字符（中文、emoji）会明确报错——' +
      'XTEST 只能发 keycode，产生不了输入法的 commit 事件，中文请走 CDP 通道。' +
      '注意：目标输入框若开着中文输入法，字母会进入候选串（composition）而不是直接上屏。',
    parameters: {
      text: { type: 'string', required: true, description: '要输入的 ASCII 文本。' },
    },
    output: OUT,
    execute: guard(async (args) => {
      const text = String(args.text ?? '')
      const bad = [...text].find((c) => c.charCodeAt(0) > 0x7e)
      if (bad !== undefined) {
        return fail(`✗ Non-ASCII character ${JSON.stringify(bad)}: XTEST cannot inject it — use the CDP channel (browsers) or the clipboard`)
      }
      const j = await actVerifiedVisual({}, (X) => X.typeAscii(text))
      return ok(`Typed ${text.length} character(s): ${text}\nVerify: ${line(j)}`)
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'cua_linux_scroll',
    description: '在窗口本地坐标处滚动滚轮。axis=v 垂直（默认），h 水平；dir=1 向下/向右，-1 向上/向左。',
    parameters: {
      wid: { type: 'integer', required: true, description: '目标窗口 id。' },
      x: { type: 'integer', required: true, description: '窗口本地 x。' },
      y: { type: 'integer', required: true, description: '窗口本地 y。' },
      notches: { type: 'integer', description: '滚动格数，默认 3。' },
      axis: { type: 'string', description: '"v"（默认）或 "h"。' },
      dir: { type: 'integer', description: '1 向下/向右（默认），-1 反向。' },
      activate: { type: 'boolean', description: '是否先置顶，默认 true。' },
    },
    output: OUT,
    execute: guard(async (args) => {
      const x = await x11()
      const size = await x.windowSize(args.wid)
      if (args.x < 0 || args.y < 0 || args.x >= size.width || args.y >= size.height) {
        return fail(`✗ Out of bounds: window is ${size.width}x${size.height}, got (${args.x},${args.y})`)
      }
      if (args.activate !== false) await x.ensureOnTop(args.wid)
      const j = await actVerifiedVisual({ wid: args.wid, point: { x: args.x, y: args.y }, radius: 220 }, (X) =>
        X.scroll(args.wid, args.x, args.y, {
          notches: args.notches || 3,
          axis: args.axis === 'h' ? 'h' : 'v',
          dir: args.dir === -1 ? -1 : 1,
        }))
      return ok(`Scrolled 0x${Number(args.wid).toString(16)} at (${args.x},${args.y}) by ${args.notches || 3} notch(es)\nVerify: ${line(j)}`)
    }),
  }))
  // ================= M2：Chromium CDP 通道 =================
  // 浏览器场景不要用像素：selector 定位、insertText 免输入法、视口坐标与窗口是否可见无关。

  const cdp = () => import('./lib/cdp.js')

  /** 每次调用按需建连（~10ms），不跨调用持有连接，避免失效 WS。 */
  async function withTab(args, fn) {
    const m = await cdp()
    const port = Number(args.port) || 9222
    const c = new m.Cdp(port)
    try {
      const tab = await c.attach(args.tab || null)
      return await fn(c, tab)
    } finally {
      c.close()
    }
  }

  const PORT_PARAM = { type: 'integer', description: '可选：Chromium 调试端口，默认 9222。' }
  const TAB_PARAM = { type: 'string', description: '可选：按 URL 子串选 tab，缺省取第一个。' }

  ctx.tools.register(defineTool({
    name: 'cua_browser_launch',
    description:
      '启动一个带 DevTools 调试端口的 Chromium（独立 profile，不影响用户正在用的浏览器），' +
      '等待端口就绪后返回。之后可用 cua_browser_* 系列工具直控。' +
      '注意：已运行的 Chrome 无法事后附加调试端口，必须这样才能接管。',
    parameters: {
      port: { type: 'integer', description: '调试端口，默认 9222。' },
      url: { type: 'string', description: '启动后打开的地址，默认 about:blank。' },
      headless: { type: 'boolean', description: '是否无头，默认 false。' },
    },
    output: OUT,
    execute: guard(async (args) => {
      const m = await cdp()
      const port = args.port || 9222
      if (await m.hasDebugPort(port)) {
        return ok(`Port ${port} already exposes a DevTools endpoint; reusing it (nothing was launched).`)
      }
      const proc = await m.launch({ port, url: args.url || 'about:blank', headless: !!args.headless })
      await m.waitReady(port, 25000)
      return ok(`Launched Chromium: pid=${proc.pid} port=${port}\nURL: ${args.url || 'about:blank'}`)
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'cua_browser_pages',
    description: '列出调试端口上的所有页面（标题 + URL），用于选择目标 tab。只读。',
    parameters: { port: PORT_PARAM },
    output: OUT,
    execute: guard(async (args) => {
      const m = await cdp()
      const port = args.port || 9222
      const c = new m.Cdp(port)
      const tabs = await c.listTabs()
      if (!tabs.length) return ok('（没有页面）')
      return ok(tabs.map((t, i) => `${i + 1}. ${t.title || '(无标题)'} — ${t.url}`).join('\n'))
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'cua_browser_goto',
    description: '在指定 tab 内导航到 URL，并等到 document.readyState 为 complete。',
    parameters: {
      url: { type: 'string', required: true, description: '目标地址。' },
      port: PORT_PARAM, tab: TAB_PARAM,
    },
    output: OUT,
    execute: guard(async (args) => {
      const r = await withTab(args, async (c) => {
        await c.navigate(args.url)
        await c.settle({ timeoutMs: 12000 })
        return c.evaluate('({ url: location.href, title: document.title })')
      })
      // 闭环：实际落地的 URL 可能与请求的不同（重定向 / 登录墙 / 错误页）
      const landed = r?.url || ''
      const host = (() => { try { return new URL(args.url).host } catch { return '' } })()
      const okHost = host ? landed.includes(host) : true
      return ok(`Navigated to ${args.url}\nLanded on: ${landed}${okHost ? '' : ' ⚠ host differs from the target'}\nTitle: ${r?.title || '(empty)'}`)
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'cua_browser_fill',
    description:
      '按 CSS selector 聚焦输入框并填入文本。走 Input.insertText，中文/emoji 直接写入，' +
      '不经过输入法、不占用剪贴板，也不会出现候选串。',
    parameters: {
      selector: { type: 'string', required: true, description: 'CSS selector，如 "#sb_form_q"。' },
      text: { type: 'string', required: true, description: '要填入的文本（任意 Unicode）。' },
      port: PORT_PARAM, tab: TAB_PARAM,
    },
    output: OUT,
    execute: guard(async (args) => {
      const val = await withTab(args, async (c) => {
        await c.fill(args.selector, args.text)
        return c.evaluate(
          `(() => { const e = document.querySelector(${JSON.stringify(args.selector)});
            return e ? e.value : null; })()`)
      })
      // 闭环：读回值必须与写入一致，否则就是没进框（比如元素是只读的或被遮挡层接管）
      if (val === null) return fail(`✗ Element not found: ${args.selector}; nothing was written`)
      if (val !== String(args.text)) {
        return fail(`✗ Write did not stick: expected ${JSON.stringify(args.text)}, read back ${JSON.stringify(val)}`)
      }
      return ok(`Filled ${JSON.stringify(args.text)}\nVerify: ✓ read-back matches`)
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'cua_browser_click',
    description:
      '按 CSS selector 点击元素。发的是真实鼠标事件（dispatchMouseEvent + 元素中心点），' +
      '会触发 pointerdown/mousedown/up，比 el.click() 更接近人手；坐标是视口坐标。',
    parameters: {
      selector: { type: 'string', required: true, description: 'CSS selector。' },
      port: PORT_PARAM, tab: TAB_PARAM,
    },
    output: OUT,
    execute: guard(async (args) => {
      const v = await import('./lib/verify.js')
      const j = await withTab(args, async (c) => {
        await c.watchBegin()
        await c.click(args.selector)
        await sleep(350)
        return v.judgeDom(await c.watchRead())
      })
      return ok(`Clicked ${args.selector}\nVerify: ${line(j)}`)
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'cua_browser_key',
    description: '向当前页面发送按键：Enter / Tab / Escape / Backspace / ArrowUp / ArrowDown。',
    parameters: {
      key: { type: 'string', required: true, description: '按键名，如 "Enter"。' },
      port: PORT_PARAM, tab: TAB_PARAM,
    },
    output: OUT,
    execute: guard(async (args) => {
      const v = await import('./lib/verify.js')
      const j = await withTab(args, async (c) => {
        await c.watchBegin()
        await c.press(args.key)
        await sleep(400)
        return v.judgeDom(await c.watchRead())
      })
      return ok(`Sent key: ${args.key}\nVerify: ${line(j)}`)
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'cua_browser_read',
    description: '读取页面文本：传 selector 取该元素 innerText，缺省取整个 body。',
    parameters: {
      selector: { type: 'string', description: '可选：CSS selector，默认 body。' },
      maxChars: { type: 'integer', description: '可选：最多返回多少字符，默认 4000。' },
      port: PORT_PARAM, tab: TAB_PARAM,
    },
    output: OUT,
    execute: guard(async (args) => {
      const text = await withTab(args, (c) => c.text(args.selector || 'body'))
      const max = args.maxChars || 4000
      const clipped = text.length > max ? `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）` : text
      return ok(clipped || '（空）')
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'cua_browser_screenshot',
    description:
      '页面截图写 PNG（走渲染管线，与窗口是否可见、是否被遮挡无关），返回路径。',
    parameters: {
      path: { type: 'string', description: '可选：输出路径，默认写到系统临时目录。' },
      port: PORT_PARAM, tab: TAB_PARAM,
    },
    output: OUT,
    execute: guard(async (args) => {
      const fs = await import('node:fs')
      const os = await import('node:os')
      const path = await import('node:path')
      const png = await withTab(args, (c) => c.screenshot())
      const out = args.path || path.join(os.tmpdir(), `cua-browser-${Date.now()}.png`)
      fs.writeFileSync(out, png)
      return ok(`Screenshot (${(png.length / 1024).toFixed(0)}KB)\nPath: ${out}`)
    }),
  }))

}
