import { test } from 'node:test'
import assert from 'node:assert/strict'
import { probe } from '../lib/probe.js'
import { apply, name } from '../index.js'

test('probe 返回结构化报告且结论非空', async () => {
  const r = await probe({ cdpPorts: [9222] })
  assert.ok(typeof r.text === 'string' && r.text.length > 100)
  assert.ok(Array.isArray(r.data.verdict) && r.data.verdict.length > 0)
  assert.ok(r.text.includes('XTEST'))
})

test('插件能把工具注册进 ctx.tools（离屏、不依赖宿主）', async () => {
  const registered = []
  const fakeCtx = { tools: { register: (t) => registered.push(t) } }
  apply(fakeCtx)
  const tool = registered.find((t) => t.name === 'cua_linux_probe')
  assert.ok(tool, '应当注册 cua_linux_probe')
  assert.ok(tool.description.length > 20)
  const out = await tool.execute({ cdpPorts: '9222' })
  assert.equal(out.ok, true)
  assert.ok(out.result.includes('Linux computer-use 能力探测'))
})

test('插件名与包名一致（loader 按 name 解析）', () => {
  assert.equal(name, 'dsh-cua-linux')
})
