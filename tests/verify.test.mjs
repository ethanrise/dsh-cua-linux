import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffRGBA, judgeVisual, judgeDom, judgeStability, judgeTwoTier } from '../lib/verify.js'

test('diffRGBA：完全不相似与完全相同', () => {
  const a = Buffer.from([0, 0, 0, 255, 255, 255, 255, 255])
  const b = Buffer.from([0, 0, 0, 255, 255, 255, 255, 255])
  assert.equal(diffRGBA(a, b).changed, 0)
  const c = Buffer.from([255, 255, 255, 255, 255, 255, 255, 255])
  assert.equal(diffRGBA(a, c).changed, 1)   // 第二个像素本来就相同
})

test('diffRGBA：阈值吃掉抗锯齿噪声', () => {
  const a = Buffer.from([10, 10, 10, 255])
  const b = Buffer.from([14, 14, 14, 255])   // 差 4 < 阈值 8
  assert.equal(diffRGBA(a, b, 8).changed, 0)
})

test('judgeVisual：有变化判 verified，无变化给出可读原因', () => {
  assert.equal(judgeVisual({ changed: 50, total: 100, ratio: 0.5 }).verified, true)
  const j = judgeVisual({ changed: 0, total: 100, ratio: 0 })
  assert.equal(j.verified, false)
  assert.match(j.text, /did not change/)
})

test('judgeDom：导航优先，其次突变数', () => {
  assert.equal(judgeDom({ urlChanged: true, mutations: 0, url: 'x' }).verified, true)
  assert.equal(judgeDom({ urlChanged: false, mutations: 3, url: 'x' }).verified, true)
  assert.equal(judgeDom({ urlChanged: false, mutations: 0, url: 'x' }).verified, false)
})

test('diffRGBA：box 模式只比指定区域', () => {
  // 4x1 帧：前两个像素变了、后两个没变
  const a = Buffer.alloc(4 * 4, 0)
  const b = Buffer.alloc(4 * 4, 0)
  b[0] = 255; b[4] = 255              // x=0,1 变
  const full = diffRGBA(a, b, 8)
  assert.equal(full.changed, 2)
  const left = diffRGBA(a, b, 8, { width: 4, box: { x: 0, y: 0, w: 2, h: 1 } })
  assert.equal(left.changed, 2)
  const right = diffRGBA(a, b, 8, { width: 4, box: { x: 2, y: 0, w: 2, h: 1 } })
  assert.equal(right.changed, 0)
})

test('judgeStability：区域本身在动时判为不稳定', () => {
  assert.equal(judgeStability({ changed: 100, total: 100, ratio: 0.5 }).stable, false)
  assert.equal(judgeStability({ changed: 0, total: 100, ratio: 0 }).stable, true)
})

test('judgeTwoTier：区域没变但整窗变 → 仍算生效并说明原因', () => {
  const j = judgeTwoTier({
    noise: 0,
    signal: { changed: 0, total: 100, ratio: 0 },
    window: { changed: 30, total: 100, ratio: 0.3 },
  })
  assert.equal(j.verified, true)
  assert.match(j.text, /elsewhere/)
})

test('judgeTwoTier：区域不稳定时给"Undecidable"而不是随便判', () => {
  const j = judgeTwoTier({
    noise: 0.01,
    signal: { changed: 1, total: 100, ratio: 0.01 },
    window: { changed: 0, total: 100, ratio: 0 },
  })
  assert.equal(j.verified, null)
  assert.match(j.text, /Undecidable/)
})
