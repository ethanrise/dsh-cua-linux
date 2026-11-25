/**
 * probe.js —— 零依赖的 Linux 桌面能力探测。
 *
 * 只做观测：读环境变量、查 socket 是否可连、查二进制是否在 PATH 上。
 * 不注入输入、不写文件、不联网（CDP 端口只连 127.0.0.1）。
 */
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

const CONNECT_TIMEOUT_MS = 400

/** 连一下 socket/TCP，只判断「通不通」，不发任何数据。 */
function canConnect({ socketPath, host, port }) {
  return new Promise((resolve) => {
    let sock
    let settled = false
    const done = (ok, detail) => {
      if (settled) return
      settled = true
      try { sock?.destroy() } catch { /* ignore */ }
      resolve({ ok, detail })
    }
    try {
      sock = socketPath
        ? net.createConnection({ path: socketPath })
        : net.createConnection({ host, port })
    } catch (err) {
      return resolve({ ok: false, detail: err.code || String(err) })
    }
    sock.setTimeout(CONNECT_TIMEOUT_MS, () => done(false, 'timeout'))
    sock.on('connect', () => done(true, 'connected'))
    sock.on('error', (err) => done(false, err.code || String(err)))
  })
}

/** 在 PATH 里找可执行文件（不 spawn，避免依赖 shell）。 */
function which(bin) {
  const paths = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of paths) {
    const full = path.join(dir, bin)
    try {
      fs.accessSync(full, fs.constants.X_OK)
      const st = fs.statSync(full)
      if (st.isFile()) return full
    } catch { /* 继续找 */ }
  }
  return null
}

/** 用 xdpyinfo 查 X 扩展列表；没装就返回 null（不是失败，是未知）。 */
function xdpyinfoExtensions(display) {
  return new Promise((resolve) => {
    if (!which('xdpyinfo')) return resolve(null)
    execFile('xdpyinfo', ['-display', display], { timeout: 1500 }, (err, stdout) => {
      if (err || !stdout) return resolve(null)
      const hasXtest = /\bXTEST\b/.test(stdout)
      const exts = (stdout.match(/number of extensions:\s*(\d+)/) || [])[1]
      resolve({ hasXtest, count: exts ? Number(exts) : null })
    })
  })
}

function humanBytes(n) {
  if (!Number.isFinite(n)) return '?'
  const mb = n / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb.toFixed(0)}MB`
}

/**
 * 汇总一份能力报告。
 * @param {{cdpPorts?: number[]}} opts
 */
export async function probe(opts = {}) {
  const cdpPorts = opts.cdpPorts && opts.cdpPorts.length ? opts.cdpPorts : [9222, 9333]
  const env = process.env
  const sessionType = (env.XDG_SESSION_TYPE || '').toLowerCase() || 'unknown'
  const display = env.DISPLAY || ''
  const wayland = env.WAYLAND_DISPLAY || ''
  const isX11 = sessionType === 'x11' || (!wayland && !!display)

  // --- X11 socket 探测 ------------------------------------------------
  const displayNum = /:(\d+)/.exec(display)?.[1]
  const x11 = { display, socketPath: null, fsSocket: null, abstractSocket: null, tcp: null }
  if (displayNum) {
    const p = `/tmp/.X11-unix/X${displayNum}`
    x11.socketPath = p
    x11.fsSocket = fs.existsSync(p) ? { ok: true, detail: 'exists' } : { ok: false, detail: 'ENOENT' }
    // 抽象命名空间 socket（Xorg 常见），路径前加 \0
    x11.abstractSocket = await canConnect({ socketPath: `\0${p}` })
    x11.tcp = await canConnect({ host: '127.0.0.1', port: 6000 + Number(displayNum) })
  }

  // --- XTEST 扩展 ------------------------------------------------------
  const xdpy = display ? await xdpyinfoExtensions(display) : null

  // --- 其他输入后端 ----------------------------------------------------
  const drivers = {
    cuaDriver: env.CUA_DRIVER_BIN || which('cua-driver'),
    xdotool: which('xdotool'),
    ydotool: which('ydotool'),
    wmctrl: which('wmctrl'),
  }
  const uinput = fs.existsSync('/dev/uinput')
  const uinputWritable = (() => {
    try { fs.accessSync('/dev/uinput', fs.constants.W_OK); return true } catch { return false }
  })()
  const libei = ['/usr/lib/x86_64-linux-gnu/libei.so.1', '/usr/lib/libei.so.1']
    .some((p) => fs.existsSync(p))

  // --- Chromium 调试端口 ------------------------------------------------
  const cdp = []
  for (const port of cdpPorts) {
    const r = await canConnect({ host: '127.0.0.1', port })
    cdp.push({ port, ...r })
  }

  // --- 组织成人话 + 结论 ------------------------------------------------
  const ok = (v) => (v ? '✓' : '✗')
  const lines = []
  lines.push('## Linux computer-use capability probe')
  lines.push('')
  lines.push(`Session: ${sessionType || 'unknown'}  DISPLAY=${display || '(unset)'}  WAYLAND_DISPLAY=${wayland || '(unset)'}`)
  lines.push(`Node: ${process.version}  pid=${process.pid}`)
  lines.push('')
  lines.push('### Capture / input injection')
  lines.push(`- X11 socket file ${x11.socketPath || '(no DISPLAY)'}: ${x11.fsSocket ? (x11.fsSocket.ok ? 'present' : 'missing') : '-'}`)
  if (x11.socketPath) {
    lines.push(`- Abstract namespace socket: ${x11.abstractSocket.ok ? 'reachable' : `unreachable (${x11.abstractSocket.detail})`}`)
    lines.push(`- X11 TCP 6000+${displayNum}: ${x11.tcp.ok ? 'reachable' : `unreachable (${x11.tcp.detail})`}`)
  }
  lines.push(`- XTEST extension: ${xdpy ? (xdpy.hasXtest ? 'present (keyboard/mouse injection available)' : 'absent') : 'unknown (xdpyinfo not installed)'}`)
  lines.push(`- /dev/uinput: ${ok(uinput)}${uinput ? ` (${uinputWritable ? 'writable' : 'not writable; needs a udev rule or root'})` : ''}`)
  lines.push(`- libei: ${ok(libei)}${libei ? '' : ' (without it, Wayland can only fall back to uinput)'}`)
  lines.push('')
  lines.push('### Tooling')
  for (const [k, v] of Object.entries(drivers)) {
    lines.push(`- ${k}: ${v || '(not found)'}`)
  }
  lines.push('')
  lines.push('### Chromium DevTools ports (CDP)')
  for (const c of cdp) {
    lines.push(`- 127.0.0.1:${c.port}: ${c.ok ? 'open, CDP available' : `closed (${c.detail})`}`)
  }
  lines.push('')

  // 结论：哪条通道可用
  const verdict = []
  if (isX11 && (x11.fsSocket?.ok || x11.abstractSocket.ok) && xdpy?.hasXtest !== false) {
    verdict.push('X11 pixel channel: available (XTEST injection + root-capture-then-crop)')
  } else if (isX11) {
    verdict.push('X11 pixel channel: limited (socket or XTEST requirement not met)')
  }
  if (wayland && !isX11) {
    verdict.push(uinputWritable || libei
      ? 'Wayland native channel: needs a libei/uinput implementation (not built yet)'
      : 'Wayland native channel: unavailable (neither uinput nor libei)')
  }
  if (cdp.some((c) => c.ok)) {
    verdict.push(`CDP channel: available (port ${cdp.filter((c) => c.ok).map((c) => c.port).join('/')})`)
  } else {
    verdict.push('CDP channel: no DevTools port open (launch Chromium with --remote-debugging-port=9222)')
  }
  lines.push('### Verdict')
  for (const v of verdict) lines.push(`- ${v}`)

  const text = lines.join('\n')
  return {
    text,
    data: { sessionType, display, wayland, x11, xdpy, drivers, uinput, uinputWritable, libei, cdp, verdict },
  }
}

export { humanBytes }
