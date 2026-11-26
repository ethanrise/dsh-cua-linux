import { randomUUID } from 'node:crypto'
import { requestAtspi } from './lib/atspi.js'
import { createProgress } from './lib/progress.js'

// Linux desktop control through AT-SPI and X11, with a separate Chromium CDP path.
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
const guard = (fn) => async (args, exec) => {
  try {
    return await fn(args || {}, exec)
  } catch (err) {
    return fail(`✗ ${err && err.message ? err.message : String(err)}`)
  }
}

function fmtWindow(w) {
  return `wid=${w.wid} (0x${w.wid.toString(16)})  ${(w.app || '?').padEnd(16)} ${String(w.title || '(无标题)').slice(0, 40).padEnd(40)} ${w.w}x${w.h}+${w.x}+${w.y}`
}

export function apply(ctx) {
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error('dsh-cua-linux: 需要 ctx.tools.register（宿主未注入 tools 服务）')
  }

  const progress = createProgress(ctx)
  const register = (definition) => ctx.tools.register(defineTool({
    ...definition,
    execute: progress.track(definition.name, definition.execute),
  }))

  register({
    name: 'cua_linux_progress',
    description: '为当前桌面任务设置进度卡标题，或报告任务最终结果。后续 CUA 工具会自动更新当前步骤。',
    parameters: {
      action: { type: 'string', enum: ['start', 'finish'], required: true, description: '开始任务或报告结果。' },
      task: { type: 'string', description: '开始时传入简短的总任务标题。' },
      total: { type: 'integer', description: '已知的 CUA 操作总步数。没有确定计划时省略。' },
      outcome: { type: 'string', enum: ['completed', 'aborted', 'failed'], description: '可选的最终结果，默认为 completed。' },
    },
    output: OUT,
    execute: guard(async ({ action, task, total, outcome = 'completed' }, exec) => {
      const session = exec?.agent?.session
      if (!session || !progress.available()) return fail('The X11 progress card is unavailable in this session.')
      if (action === 'finish') {
        if (!['completed', 'aborted', 'failed'].includes(outcome)) return fail('Unknown task outcome.')
        progress.finish(session, outcome)
        return ok('Task result reported to the progress card.')
      }
      if (action !== 'start' || !task?.trim()) return fail('Provide a task title to start progress.')
      if (total !== undefined && (!Number.isInteger(total) || total < 1)) {
        return fail('The optional step count must be a positive integer.')
      }
      progress.start(session, task, total)
      return ok('Task title registered. Subsequent CUA calls update the card automatically.')
    }),
  })

  const x11 = () => import('./lib/x11.js')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // Serialize desktop input within this plugin instance. CDP uses its own connection.
  let desktop = Promise.resolve()
  const desktopGuard = (fn) => guard((args, exec) => {
    const run = desktop.then(() => {
      exec?.signal?.throwIfAborted()
      return fn(args, exec)
    })
    desktop = run.catch(() => {})
    return run
  })

  async function actVerifiedVisual({ wid = null, point = null, radius = 90, label = null }, action) {
    const x = await x11()
    const v = await import('./lib/verify.js')
    const before = await progress.withoutOverlays(() => x.captureRaw(wid))
    const box = point
      ? { x: point.x - before.offsetX - radius, y: point.y - before.offsetY - radius, w: radius * 2, h: radius * 2 }
      : null
    await action(x)
    for (const delay of [35, 65, 120, 180]) {
      await sleep(delay)
      let after
      try {
        after = await progress.withoutOverlays(() => x.captureRaw(wid))
      } catch {
        return { verified: null, text: 'Input dispatched; the resulting window could not be captured' }
      }
      if (before.width !== after.width || before.height !== after.height ||
          before.offsetX !== after.offsetX || before.offsetY !== after.offsetY) {
        return { verified: null, text: 'Input dispatched; the captured area changed size' }
      }
      const region = v.diffRGBA(before.rgba, after.rgba, 8, { width: before.width, box })
      const window = box ? v.diffRGBA(before.rgba, after.rgba) : null
      if (Math.max(region.ratio, window?.ratio || 0) >= 0.001) {
        return { verified: null, text: `Input dispatched; ${label || 'screen'} pixels changed. Verify the intended result.` }
      }
    }
    return { verified: null, text: 'Input dispatched; no visible result confirmed within the observation period' }
  }

  // A new observation of a window supersedes its previous element IDs.
  const snapshots = new Map()
  async function accessibleWindow(wid) {
    const x = await x11()
    const target = await x.windowIdentity(wid)
    // Chromium-derived apps may publish the accessibility tree from a child process.
    target.allowDescendants = !!(target.pid && target.title) &&
      (await x.listWindows({ onlyMapped: false })).filter(
        (window) => window.pid === target.pid && window.title === target.title,
      ).length === 1
    return target
  }

  const snapshotLimit = 16
  register({
    name: 'cua_linux_observe',
    description: 'Read the AT-SPI controls for an X11 window. Use returned element IDs for actions, or a screenshot if controls are unavailable.',
    parameters: {
      wid: { type: 'integer', required: true, description: 'Target X11 window id.' },
      limit: { type: 'integer', description: 'Maximum nodes, 1–500. Default 120.' },
    },
    output: OUT,
    execute: desktopGuard(async ({ wid, limit = 120 }, exec) => {
      snapshots.delete(wid)
      const window = await accessibleWindow(wid)
      if (!window.pid || !window.title) return fail('This X11 window has no PID or title for AT-SPI matching.')
      limit = Math.max(1, Math.min(500, limit))
      const { nodes } = await requestAtspi({ operation: 'observe', window, limit }, exec?.signal)
      const id = randomUUID()
      if (snapshots.size >= snapshotLimit) snapshots.delete(snapshots.keys().next().value)
      snapshots.set(wid, { id, nodes, window, limit, expires: Date.now() + 120_000 })
      const controls = nodes.map(({ path, pid, ...node }, index) => ({ id: index + 1, ...node }))
      return ok(JSON.stringify({ snapshot: id, controls }))
    }),
  })

  register({
    name: 'cua_linux_element',
    description: 'Invoke a listed AT-SPI action or replace an editable control’s text with Unicode. Observe again after a dispatched action.',
    parameters: {
      wid: { type: 'integer', required: true, description: 'Target X11 window id.' },
      snapshot: { type: 'string', required: true, description: 'Snapshot from cua_linux_observe.' },
      element: { type: 'integer', required: true, description: 'Element id in that snapshot.' },
      action: { type: 'string', description: 'Exact action name from the observation.' },
      text: { type: 'string', description: 'Replacement text. Provide either action or text.' },
    },
    output: OUT,
    execute: desktopGuard(async (args, exec) => {
      if ((args.action === undefined) === (args.text === undefined)) return fail('Provide either action or text.')
      const snapshot = snapshots.get(args.wid)
      const node = snapshot?.nodes[args.element - 1]
      if (!node || snapshot.id !== args.snapshot || snapshot.expires < Date.now()) {
        return fail('Invalid or stale element. Observe the target window again.')
      }
      const window = await accessibleWindow(args.wid)
      if (window.pid !== snapshot.window.pid || window.title !== snapshot.window.title) {
        return fail('The X11 window changed. Observe it again.')
      }
      snapshots.delete(args.wid)
      const result = await requestAtspi({
        operation: args.text === undefined ? 'action' : 'set_text',
        window, node, limit: snapshot.limit, action: args.action, text: args.text,
      }, exec?.signal)
      return ok(result.verified ? 'Text updated and read-back matches.'
        : 'Action dispatched; observe the window to confirm the intended result.')
    }),
  })

  /** 把判定结果渲染成一行，失败时用 ⚠ 而不是静默的 ✓。 */
  // verified: true=✓ / false=⚠ / null=?(无法判定)。三种状态必须能区分开，
  // 把 null 画成 ✓ 等于撒谎。
  const line = (j) => `${j.verified === true ? '✓' : j.verified === false ? '⚠' : '?'} ${j.text}`

  register({
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
  })

  register({
    name: 'cua_linux_windows',
    description:
      '列出当前可见的 X11 窗口：可直接传给其他工具的十进制 wid、程序名（WM_CLASS）、标题、屏幕绝对坐标、尺寸，' +
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
  })

  register({
    name: 'cua_linux_activate',
    description: '将指定 X11 窗口提到前台并确认键盘焦点。不会点击窗口，也不会切换浏览器标签页。',
    parameters: {
      wid: { type: 'integer', required: true, description: '使用 cua_linux_windows 返回的十进制 wid。' },
    },
    output: OUT,
    execute: desktopGuard(async ({ wid }) => {
      const x = await x11()
      await x.ensureOnTop(wid)
      return ok(`Window wid=${wid} has keyboard focus.`)
    }),
  })

  const screenshotImages = new WeakMap()
  register({
    name: 'cua_linux_screenshot',
    description:
      '截图并写入 PNG 文件，返回绝对路径与尺寸，支持图像的模型可直接查看。不传 wid 抓全屏；传 wid 抓该窗口（内部抓 root 再裁，' +
      '避免 compositor 下对子窗口取图拿到黑图）。文件写在系统临时目录，可用路径直接查看。',
    parameters: {
      wid: { type: 'integer', description: '可选：直接使用 cua_linux_windows 输出的十进制 wid。' },
      path: { type: 'string', description: '可选：输出路径，默认写到系统临时目录。' },
    },
    output: OUT,
    finalizeContent(exec, result) {
      const attachment = screenshotImages.get(exec)
      screenshotImages.delete(exec)
      if (attachment && !result.isError) return [...result.content, { type: 'image', attachment }]
    },
    execute: desktopGuard(async (args, exec) => {
      const fs = await import('node:fs')
      const os = await import('node:os')
      const path = await import('node:path')
      const x = await x11()
      const shot = await progress.withoutOverlays(() => x.screenshot(args.wid || null))
      const out = args.path || path.join(os.tmpdir(), `cua-linux-${randomUUID()}.png`)
      fs.writeFileSync(out, shot.png, { mode: 0o600 })
      const attachments = ctx.get?.('attachments')
      const llm = ctx.get?.('llm')
      const config = exec?.agent?.session?.requestHeader?.()?.config
      const provider = config?.provider ?? exec?.agent?.options?.provider
      const model = config?.model ?? exec?.agent?.options?.model
      if (attachments?.saveImages && llm?.resolveModelInfo && provider && model && !exec.signal?.aborted) {
        try {
          const info = await llm.resolveModelInfo(provider, model, exec.signal)
          if (info.inputModalities?.includes('image') && !exec.signal?.aborted) {
            const [attachment] = await attachments.saveImages([{ data: shot.png, mediaType: 'image/png' }])
            if (attachment) screenshotImages.set(exec, attachment)
          }
        } catch {
          // The returned PNG path is still usable.
        }
      }
      const kb = (shot.png.length / 1024).toFixed(0)
      const offset = shot.offsetX || shot.offsetY
        ? `\nAdd (${shot.offsetX}, ${shot.offsetY}) to image coordinates for window-local input.`
        : ''
      return ok(`Screenshot ${shot.width}x${shot.height} (${kb}KB)\nPath: ${out}${offset}`)
    }),
  })

  register({
    name: 'cua_linux_click',
    description:
      '在窗口本地像素坐标处点击。默认先把窗口置顶（activate=true）——X11 下指针命中永远是最上层窗口，' +
      '如果坐标命中其他窗口，工具会拒绝点击。坐标以窗口左上角为原点。',
    parameters: {
      wid: { type: 'integer', required: true, description: '目标窗口 id。' },
      x: { type: 'integer', required: true, description: '窗口本地 x（像素）。' },
      y: { type: 'integer', required: true, description: '窗口本地 y（像素）。' },
      button: { type: 'integer', description: '1=左键（默认）2=中键 3=右键。' },
      count: { type: 'integer', description: '点击次数，默认 1（2 即双击）。' },
      activate: { type: 'boolean', description: '是否先置顶窗口，默认 true。' },
    },
    output: OUT,
    execute: desktopGuard(async (args) => {
      const x = await x11()
      // 先校验坐标：越界是确定性失败，不该靠"看画面有没有变"来发现
      const size = await x.windowSize(args.wid)
      if (args.x < 0 || args.y < 0 || args.x >= size.width || args.y >= size.height) {
        return fail(`✗ Out of bounds: window 0x${Number(args.wid).toString(16)} is ${size.width}x${size.height}, got (${args.x},${args.y})`)
      }
      if (args.activate !== false) await x.ensureOnTop(args.wid)
      const j = await actVerifiedVisual({ wid: args.wid, point: { x: args.x, y: args.y } }, (X) =>
        X.click(args.wid, args.x, args.y, {
          button: args.button || 1, count: args.count || 1,
          onPointer: (point) => progress.pointer(point, true),
        }))
      return ok(`Clicked 0x${Number(args.wid).toString(16)} at (${args.x},${args.y}) button=${args.button || 1} count=${args.count || 1}\nVerify: ${line(j)}`)
    }),
  })

  register({
    name: 'cua_linux_key',
    description:
      '按组合键或特殊键，例如 "ctrl+t" / "shift+tab" / "Return" / "Escape" / "F5"。' +
      '已知目标时传 wid 校验焦点。若目标不在前台，先用 cua_linux_click 聚焦。',
    parameters: {
      wid: { type: 'integer', description: 'Optional target window id. If set, the window must have keyboard focus.' },
      combo: { type: 'string', required: true, description: '组合键，用 + 连接，如 "ctrl+shift+t"。' },
    },
    output: OUT,
    execute: desktopGuard(async (args) => {
      const j = await actVerifiedVisual({ wid: args.wid }, async (X) => {
        await X.pressKey(args.combo, args.wid)
      })
      return ok(`Sent key: ${args.combo}\nVerify: ${line(j)}`)
    }),
  })

  register({
    name: 'cua_linux_type',
    description:
      '逐字输入 ASCII 文本（字母、数字、常用符号）。非 ASCII 字符（中文、emoji）会明确报错——' +
      'XTEST 只能发 keycode，产生不了输入法的 commit 事件，中文请用 cua_linux_element、cua_linux_paste 或浏览器 CDP。' +
      '注意：目标输入框若开着中文输入法，字母会进入候选串（composition）而不是直接上屏。',
    parameters: {
      wid: { type: 'integer', description: 'Optional target window id. If set, the window must have keyboard focus.' },
      text: { type: 'string', required: true, description: '要输入的 ASCII 文本。' },
    },
    output: OUT,
    execute: desktopGuard(async (args) => {
      const text = String(args.text ?? '')
      const bad = [...text].find((c) => c.charCodeAt(0) > 0x7e)
      if (bad !== undefined) {
        return fail(`✗ Non-ASCII character ${JSON.stringify(bad)}: XTEST cannot inject it — use cua_linux_element, cua_linux_paste, or the browser CDP tools`)
      }
      const j = await actVerifiedVisual({ wid: args.wid }, async (X) => {
        await X.typeAscii(text, args.wid)
      })
      return ok(`Typed ${text.length} character(s): ${text}\nVerify: ${line(j)}`)
    }),
  })

  register({
    name: 'cua_linux_paste',
    description: 'Paste Unicode into an explicitly focused X11 window. Replaces the clipboard; prefer cua_linux_element when an editable control is available.',
    parameters: {
      wid: { type: 'integer', required: true, description: 'Focused target window id.' },
      text: { type: 'string', required: true, description: 'Text to place on the clipboard and paste.' },
    },
    output: OUT,
    execute: desktopGuard(async ({ wid, text }) => {
      const { paste } = await import('./lib/clipboard.js')
      const j = await actVerifiedVisual({ wid }, () => paste(wid, text))
      return ok(`Paste shortcut sent to window.\nVerify: ${line(j)}`)
    }),
  })

  register({
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
    execute: desktopGuard(async (args) => {
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
          onPointer: (point) => progress.pointer(point, false),
        }))
      return ok(`Scrolled 0x${Number(args.wid).toString(16)} at (${args.x},${args.y}) by ${args.notches || 3} notch(es)\nVerify: ${line(j)}`)
    }),
  })
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

  register({
    name: 'cua_browser_launch',
    description:
      '启动一个带 DevTools 调试端口的 Chromium（独立 profile，不影响用户正在用的浏览器），' +
      '等待端口就绪后返回。之后可用 cua_browser_* 系列工具直控。' +
      '注意：普通 Chrome 实例未开放调试端口时，可用本工具启动一个独立实例走 CDP。若必须使用现有窗口或登录状态，改用 cua_linux_*。',
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
  })

  register({
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
  })

  register({
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
  })

  register({
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
  })

  register({
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
  })

  register({
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
  })

  register({
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
  })

  register({
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
  })

}
