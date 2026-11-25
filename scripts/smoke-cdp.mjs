/**
 * CDP 通道真机冒烟：起一个独立 profile 的 Chromium → 打开 Bing → 中文搜索 → 取结果 → 截图 → 关掉。
 *   node scripts/smoke-cdp.mjs
 */
import * as cdp from '../lib/cdp.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORT = 9450 + (process.pid % 50)
const PROFILE = path.join(os.tmpdir(), `cua-smoke-${Date.now()}`)
const t0 = Date.now()
const proc = await cdp.launch({ port: PORT, url: 'https://cn.bing.com/', profileDir: PROFILE })
try {
  await cdp.waitReady(PORT, 25000)
  const c = new cdp.Cdp(PORT)
  await c.attach('bing')
  await c.waitForSelector('#sb_form_q', 20000)
  await c.fill('#sb_form_q', '知识星球')
  const value = await c.evaluate("document.querySelector('#sb_form_q').value")
  console.log('中文输入框值:', value)
  await c.press('Enter')
  await c.settle({ timeoutMs: 15000 })               // 等导航完成 + 内容不再变化
  await c.waitForSelector('#b_results .b_algo', 20000)
  await c.waitVisible('#b_results .b_algo', 10000)
  const n = await c.evaluate("document.querySelectorAll('#b_results .b_algo').length")
  console.log('结果数:', n)
  const first = await c.evaluate(
    "(() => { const a = document.querySelector('#b_results .b_algo h2 a'); return a ? {t: a.innerText.trim(), u: a.href} : null })()")
  console.log('首条:', JSON.stringify(first))
  const png = await c.screenshot()
  const out = path.join(os.tmpdir(), `cua-cdp-smoke-${Date.now()}.png`)
  fs.writeFileSync(out, png)
  console.log(`截图 ${(png.length / 1024).toFixed(0)}KB -> ${out}`)
  console.log('总耗时', Date.now() - t0, 'ms')
  c.close()
} finally {
  try { process.kill(-proc.pid, 'SIGTERM') } catch { try { proc.kill('SIGTERM') } catch { /* ignore */ } }
}
process.exit(0)
