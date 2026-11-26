import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const helper = fileURLToPath(new URL('./progress-card.py', import.meta.url))
const steps = {
  cua_linux_probe: '检查桌面环境',
  cua_linux_windows: '查找目标窗口',
  cua_linux_observe: '读取窗口控件',
  cua_linux_element: '操作窗口控件',
  cua_linux_activate: '激活目标窗口',
  cua_linux_screenshot: '截取桌面画面',
  cua_linux_click: '点击目标窗口',
  cua_linux_key: '发送快捷键',
  cua_linux_type: '输入文字',
  cua_linux_paste: '粘贴文字',
  cua_linux_scroll: '滚动窗口',
  cua_browser_launch: '启动独立浏览器',
  cua_browser_pages: '查找浏览器标签页',
  cua_browser_goto: '打开网页',
  cua_browser_fill: '填写网页表单',
  cua_browser_click: '点击网页控件',
  cua_browser_key: '向网页发送按键',
  cua_browser_read: '读取网页内容',
  cua_browser_screenshot: '截取网页画面',
}

const outcomes = { completed: '任务完成', aborted: '任务已取消', failed: '任务未完成' }
const cleanTitle = (value) => typeof value === 'string'
  ? Array.from(value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, 120).join('')
  : ''

export function createProgress(ctx) {
  const enabled = !!process.env.DISPLAY && process.env.XDG_SESSION_TYPE !== 'wayland' &&
    process.env.DSH_CUA_PROGRESS !== '0'
  const sessions = new WeakMap()
  let child, active, timer, pendingHide
  let unavailable = false
  let suppression = 0
  let nextId = 0

  function stop() {
    const previous = child
    child = undefined
    previous?.kill()
    pendingHide?.finish()
  }

  function renderer() {
    if (!enabled || unavailable) return
    if (child) return child
    const running = spawn('/usr/bin/python3', [helper], { stdio: ['pipe', 'pipe', 'ignore'] })
    child = running
    const fail = () => {
      if (child !== running) return
      unavailable = true
      stop()
    }
    running.once('error', fail)
    running.once('exit', fail)
    running.stdin.on('error', fail)
    const lines = createInterface({ input: running.stdout })
    lines.on('line', (line) => {
      try {
        if (child === running && pendingHide?.id === JSON.parse(line).id) pendingHide.finish()
      } catch {
        fail()
      }
    })
    running.unref()
    running.stdin.unref?.()
    running.stdout.unref?.()
    return running
  }

  function paint() {
    if (!active?.visible || suppression) return
    renderer()?.stdin.write(JSON.stringify({ type: 'show', ...active.display }) + '\n')
  }

  function display(state, display, lifetime) {
    clearTimeout(timer)
    active = state
    state.display = display
    state.visible = true
    paint()
    timer = setTimeout(() => {
      state.visible = false
      child?.stdin.write('{"type":"hide"}\n')
    }, lifetime)
    timer.unref()
  }

  function getState(session) {
    let state = sessions.get(session)
    if (!state) {
      state = { count: 0 }
      sessions.set(session, state)
    }
    return state
  }

  function title(session, state) {
    if (state.task) return state.task
    try {
      return cleanTitle(ctx.get?.('sessionTitle')?.get?.(session)?.title) || 'DSH 电脑操作'
    } catch {
      return 'DSH 电脑操作'
    }
  }

  function track(tool, execute) {
    return async (args, exec) => {
      const session = exec?.agent?.session
      if (!enabled || !session || exec.signal?.aborted || !steps[tool]) return execute(args, exec)
      const state = getState(session)
      const count = ++state.count
      const number = state.total && count <= state.total ? `${count} / ${state.total}` : String(count)
      const view = { task: title(session, state), step: `第 ${number} 步 · ${steps[tool]}`, result: '执行中…' }
      display(state, view, 60_000)
      const settle = (result) => {
        if (active === state && state.count === count && sessions.get(session) === state) {
          display(state, { ...view, result }, 8_000)
        }
      }
      const onAbort = () => settle('已取消')
      exec.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const out = await execute(args, exec)
        const result = exec.signal?.aborted ? '已取消'
          : !out.ok ? '工具执行失败'
            : /Verify: \?|Action dispatched|Paste shortcut sent/.test(out.result) ? '已派发 · 效果待确认' : '工具执行完成'
        settle(result)
        return out
      } catch (error) {
        settle(exec.signal?.aborted ? '已取消' : '工具执行失败')
        throw error
      } finally {
        exec.signal?.removeEventListener('abort', onAbort)
      }
    }
  }

  async function withoutOverlays(capture) {
    suppression++
    try {
      if (child) {
        if (!pendingHide) {
          const id = ++nextId
          const promise = Promise.withResolvers()
          const timeout = setTimeout(stop, 800)
          pendingHide = { id, promise: promise.promise, finish() {
            clearTimeout(timeout)
            pendingHide = undefined
            promise.resolve()
          } }
          child.stdin.write(JSON.stringify({ type: 'hide-all', id }) + '\n')
        }
        await pendingHide.promise
      }
      return await capture()
    } finally {
      if (--suppression === 0) {
        child?.stdin.write('{"type":"resume"}\n')
        paint()
      }
    }
  }

  function finish(session, outcome) {
    const state = sessions.get(session)
    sessions.delete(session)
    if (state && active === state) {
      display(state, { ...state.display, result: outcomes[outcome] }, 2_500)
    }
  }

  ctx.on?.('session/event', (session, event) => {
    if (event.type === 'turn/end') {
      const reason = event.data.reason.kind
      finish(session, reason === 'completed' ? 'completed' : reason === 'aborted' ? 'aborted' : 'failed')
    }
  })
  ctx.on?.('session/disposed', (session) => {
    const state = sessions.get(session)
    sessions.delete(session)
    if (state && active === state) {
      state.visible = false
      clearTimeout(timer)
      child?.stdin.write('{"type":"hide"}\n')
    }
  })
  ctx.on?.('dispose', () => {
    clearTimeout(timer)
    active = undefined
    unavailable = true
    stop()
  })

  return {
    track, withoutOverlays, finish,
    pointer(point, click) {
      const target = child || (!suppression && renderer())
      target?.stdin?.write(JSON.stringify({ type: 'pointer', ...point, click }) + '\n')
    },
    start(session, task, total) {
      const state = { task: cleanTitle(task), total, count: 0 }
      sessions.set(session, state)
      display(state, { task: title(session, state), step: '等待操作', result: '任务已开始' }, 15_000)
    },
    available: () => enabled && !unavailable,
  }
}
