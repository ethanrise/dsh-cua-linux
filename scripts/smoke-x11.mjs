/**
 * 真机冒烟：连 X server → 枚举 → 截图 → 关闭连接。
 * 单测里不要放这类用例（X socket 会挂住事件循环），单独跑：
 *   node scripts/smoke-x11.mjs
 */
import assert from 'node:assert/strict'
import * as x11 from '../lib/x11.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { X, root } = await x11.connect()
const destroyed = X.AllocID()
await x11.call(X, 'CreateWindow', destroyed, root, 0, 0, 1, 1, 0, 0, 0, 0, {})
await x11.call(X, 'DestroyWindow', destroyed)
await assert.rejects(x11.windowSize(destroyed), /Bad drawable/i)
console.log('已销毁窗口返回工具错误，X11 连接仍可用')

const wins = await x11.listWindows()
console.log(`可见窗口 ${wins.length} 个`)
for (const w of wins.slice(0, 5)) {
  console.log(` 0x${w.wid.toString(16)} ${w.app.padEnd(16)} ${String(w.title).slice(0, 30).padEnd(30)} ${w.w}x${w.h}+${w.x}+${w.y}`)
}
const target = wins.find((w) => w.w > 400) || wins[0]
const shot = await x11.screenshot(target ? target.wid : null)
const out = path.join(os.tmpdir(), `cua-smoke-${Date.now()}.png`)
fs.writeFileSync(out, shot.png)
console.log(`截图 ${shot.width}x${shot.height} -> ${out}`)
x11.close()
process.exit(0)
