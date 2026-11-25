/**
 * 真机冒烟：连 X server → 枚举 → 截图 → 关闭连接。
 * 单测里不要放这类用例（X socket 会挂住事件循环），单独跑：
 *   node scripts/smoke-x11.mjs
 */
import * as x11 from '../lib/x11.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
