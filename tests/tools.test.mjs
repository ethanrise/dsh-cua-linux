import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, name } from '../index.js'
import { encodePNG, xImageToRGBA } from '../lib/png.js'

function fakeCtx() {
  const reg = []
  return { reg, ctx: { tools: { register: (t) => reg.push(t) } } }
}

test('插件名与包名一致', () => assert.equal(name, 'dsh-cua-linux'))

test('注册 15 个工具且都有描述与 execute', () => {
  const { reg, ctx } = fakeCtx()
  apply(ctx)
  assert.equal(reg.length, 15)
  for (const t of reg) {
    assert.ok(t.name.startsWith('cua_'), t.name)
    assert.ok(t.description.length > 20, t.name)
    assert.equal(typeof t.execute, 'function', t.name)
  }
})

test('type 工具对非 ASCII 明确失败而不是静默', async () => {
  const { reg, ctx } = fakeCtx()
  apply(ctx)
  const tool = reg.find((t) => t.name === 'cua_linux_type')
  const out = await tool.execute({ text: '知识星球' })
  assert.equal(out.ok, false)
  assert.match(out.result, /非 ASCII/)
})

test('PNG 编码器产出合法签名与 IHDR 尺寸', () => {
  const w = 4, h = 3
  const rgba = Buffer.alloc(w * h * 4, 128)
  const png = encodePNG(w, h, rgba)
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(png.readUInt32BE(16), w)
  assert.equal(png.readUInt32BE(20), h)
  assert.ok(png.includes(Buffer.from('IEND')))
})

test('xImageToRGBA 正确把 BGRX 转成 RGBA', () => {
  const bgrx = Buffer.from([10, 20, 30, 0])
  const rgba = xImageToRGBA(bgrx, 1, 1)
  assert.deepEqual([...rgba], [30, 20, 10, 255])
})

// 注意：凡是会真的连 X server 的用例不要放在单测里——X socket 会一直持有
// 事件循环，node --test 会挂着不退出。这类用例放 scripts/smoke-x11.mjs。
