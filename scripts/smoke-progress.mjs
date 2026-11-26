import assert from 'node:assert/strict'
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { apply } from '../index.js'
import { call, close, connect, toRoot, windowIdentity } from '../lib/x11.js'

const tools = new Map()
const listeners = new Map()
apply({
  tools: { register: (tool) => tools.set(tool.name, tool) },
  on: (event, fn) => listeners.set(event, fn),
})
const session = {}
const exec = { agent: { session }, signal: new AbortController().signal }
const { X, root } = await connect()
const invoke = (name, args = {}) => tools.get(name).execute(args, exec)

async function visibleOverlay(title = 'DSH CUA Progress') {
  const { children } = await call(X, 'QueryTree', root)
  for (const wid of children) {
    try {
      if ((await windowIdentity(wid)).title === title &&
          (await call(X, 'GetWindowAttributes', wid)).mapState === 2) return wid
    } catch {
      // The window may have disappeared while enumerating.
    }
  }
}

async function waitForOverlay(title) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const wid = await visibleOverlay(title)
    if (wid) return wid
    await delay(25)
  }
  throw new Error(`The overlay did not appear: ${title}`)
}

const fixture = X.AllocID()
const directory = await mkdtemp(join(tmpdir(), 'dsh-cua-overlay-'))
const baseline = join(directory, 'baseline.png')
const screenshot = join(directory, 'screenshot.png')
const mouseBanner = 'DSH CUA Mouse Control'
const clickMarker = 'DSH CUA Click Marker'
try {
  const before = await call(X, 'GetInputFocus')
  const started = await invoke('cua_linux_progress', { action: 'start', task: '验证桌面提示', total: 5 })
  assert.ok(started.ok, started.result)
  const wid = await waitForOverlay()
  assert.equal((await call(X, 'GetInputFocus')).focus, before.focus)
  const shape = await call(X, 'require', 'shape')
  const { rectangles } = await call(shape, 'GetRectangles', wid, shape.Kind.Input)
  assert.deepEqual(rectangles, [], 'The card must not intercept mouse events.')

  assert.ok((await invoke('cua_linux_windows')).ok)
  assert.equal(await visibleOverlay(mouseBanner), undefined)

  const { screen } = await connect()
  const origin = { x: Math.floor(screen.width / 2), y: Math.floor(screen.height / 2) }
  await call(X, 'CreateWindow', fixture, root, origin.x, origin.y, 100, 80, 0, 0, 0, 0,
    { overrideRedirect: 1, backgroundPixel: 0x406080, eventMask: 4 })
  await call(X, 'MapWindow', fixture)
  assert.ok((await invoke('cua_linux_screenshot', { wid: fixture, path: baseline })).ok)
  let leftPresses = 0
  let wheelPresses = 0
  X.on('event', (event) => {
    if (event.name !== 'ButtonPress' || event.wid !== fixture) return
    if (event.keycode === 1) leftPresses++
    if (event.keycode === 5) wheelPresses++
  })
  const coordinates = { wid: fixture, x: 42, y: 36, activate: false }
  const scrolling = invoke('cua_linux_scroll', { ...coordinates, notches: 1 })
  const banner = await waitForOverlay(mouseBanner)
  const scrolled = await scrolling
  assert.ok(scrolled.ok, scrolled.result)
  assert.equal(wheelPresses, 1)
  assert.equal(await visibleOverlay(clickMarker), undefined, 'Scroll should show only the banner.')
  const clicking = invoke('cua_linux_click', coordinates)
  const marker = await waitForOverlay(clickMarker)
  const clicked = await clicking
  assert.ok(clicked.ok, clicked.result)
  assert.equal(leftPresses, 1)
  for (const overlay of [banner, marker]) {
    const input = await call(shape, 'GetRectangles', overlay, shape.Kind.Input)
    assert.deepEqual(input.rectangles, [])
  }
  assert.deepEqual(await toRoot(marker, 31, 31), await toRoot(fixture, 42, 36))
  assert.ok((await invoke('cua_linux_screenshot', { wid: fixture, path: screenshot })).ok)
  assert.deepEqual(await readFile(screenshot), await readFile(baseline),
    'The click marker must not change the captured image.')
  assert.equal((await call(X, 'GetInputFocus')).focus, before.focus)
  listeners.get('session/event')(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await delay(2700)
  assert.equal(await visibleOverlay(), undefined, 'The card must close after the turn ends.')
  assert.equal(await visibleOverlay(mouseBanner), undefined)
  assert.equal(await visibleOverlay(clickMarker), undefined)
  console.log('X11 overlays pass input through, mark the exact click, preserve focus, and dismiss automatically.')
} finally {
  listeners.get('dispose')()
  await call(X, 'DestroyWindow', fixture).catch(() => {})
  close()
  for (const path of [baseline, screenshot]) await unlink(path).catch(() => {})
  await rmdir(directory)
}
