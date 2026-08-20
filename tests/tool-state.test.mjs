// M5: unit tests for the structured tool-state consumption functions in client.js
// (parseToolStateMarker / applyToolState). Uses the same eval-stub pattern as
// vendor/dsh-vision-router-main/tests to load the browser-only __ModuleLoader__ bundle.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function loadClientBundle() {
  let spec = null
  globalThis.window = { __ModuleLoader__: { load(s) { spec = s } } }
  const url = new URL('../client.js', import.meta.url)
  // eslint-disable-next-line no-eval
  ;(0, eval)(readFileSync(url, 'utf8'))
  // The factory only destructures these hooks from `react` at load time.
  const ReactHooks = {
    useState: (initial) => [initial, () => {}],
    useEffect: (fn) => undefined,
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
  }
  const bundle = spec.factory((name) => {
    if (name === 'react') return ReactHooks
    throw new Error('require(' + name + ')')
  })
  return bundle
}

test('parseToolStateMarker: non-string / empty / no marker → null', () => {
  const { parseToolStateMarker } = loadClientBundle()
  assert.equal(parseToolStateMarker(), null)
  assert.equal(parseToolStateMarker(''), null)
  assert.equal(parseToolStateMarker(42), null)
  assert.equal(parseToolStateMarker('完全没有任何标记的文本'), null)
  assert.equal(parseToolStateMarker('[TAVERN-STATE]'), null)
})

test('parseToolStateMarker: plain JSON right after the marker', () => {
  const { parseToolStateMarker } = loadClientBundle()
  const out = parseToolStateMarker('[TAVERN-STATE]{"scene":"吧台旁","intimacy":30}')
  assert.deepEqual(out, { scene: '吧台旁', intimacy: 30 })
})

test('parseToolStateMarker: JSON followed by trailing text', () => {
  const { parseToolStateMarker } = loadClientBundle()
  const out = parseToolStateMarker('[TAVERN-STATE]{"emotion":"愉悦"} 其余说明内容')
  assert.deepEqual(out, { emotion: '愉悦' })
})

test('parseToolStateMarker: marker, then text, then bracketed JSON', () => {
  const { parseToolStateMarker } = loadClientBundle()
  const out = parseToolStateMarker('更新状态[TAVERN-STATE]{"time":"深夜","trust":40}结束')
  assert.deepEqual(out, { time: '深夜', trust: 40 })
})

test('parseToolStateMarker: JSON with nested braces/arrays not confused', () => {
  const { parseToolStateMarker } = loadClientBundle()
  const out = parseToolStateMarker(
    '[TAVERN-STATE]{"custom":{"接客数":"+1"},"tags":["a","b"]} tail',
  )
  assert.deepEqual(out, { custom: { '接客数': '+1' }, tags: ['a', 'b'] })
})

test('parseToolStateMarker: malformed JSON → null', () => {
  const { parseToolStateMarker } = loadClientBundle()
  assert.equal(parseToolStateMarker('[TAVERN-STATE]{"a":'), null)
  assert.equal(parseToolStateMarker('[TAVERN-STATE]not-a-json'), null)
})

test('applyToolState: null/invalid payload keeps prev (and does not mutate it)', () => {
  const { applyToolState } = loadClientBundle()
  const prev = { scene: '吧台旁', intimacy: 20 }
  const out = applyToolState(prev, null)
  assert.deepEqual(out, { scene: '吧台旁', intimacy: 20 })
  assert.notEqual(out, prev, 'must return a new object / shallow copy')
  assert.deepEqual(applyToolState(undefined, { scene: '门口' }), { scene: '门口' })
})

test('applyToolState: text fields apply only when present', () => {
  const { applyToolState } = loadClientBundle()
  const out = applyToolState(
    { scene: '吧台旁', time: '深夜', emotion: '平静' },
    { scene: '二楼卡座', emotion: '愉悦' },
  )
  assert.deepEqual(out, { scene: '二楼卡座', time: '深夜', emotion: '愉悦' })
})

test('applyToolState: numeric built-ins clamped 0~100 and rounded', () => {
  const { applyToolState } = loadClientBundle()
  assert.equal(applyToolState({ intimacy: 20 }, { intimacy: '87.6' }).intimacy, 88)
  assert.equal(applyToolState({ intimacy: 20 }, { intimacy: 150 }).intimacy, 100)
  assert.equal(applyToolState({ intimacy: 80 }, { intimacy: -5 }).intimacy, 0)
  // non-numeric keeps previous value
  assert.equal(applyToolState({ intimacy: 20 }, { intimacy: 'zzz' }).intimacy, 20)
  // absent field keeps previous value
  assert.equal(applyToolState({ affection: 33 }, {}).affection, 33)
})

test('applyToolState: custom counter uses defs type → floor at 0, string out', () => {
  const { applyToolState } = loadClientBundle()
  const defs = { '接客数': 'counter' }
  assert.equal(applyToolState({ custom: { '接客数': '3' } }, { custom: { '接客数': '5' } }, defs).custom['接客数'], '5')
  assert.equal(applyToolState({ custom: { '接客数': '3' } }, { custom: { '接客数': -2 } }, defs).custom['接客数'], '0')
})

test('applyToolState: custom meter clamps 0~100, string out', () => {
  const { applyToolState } = loadClientBundle()
  const defs = { '兴奋度': 'meter' }
  assert.equal(applyToolState({ custom: { '兴奋度': '10' } }, { custom: { '兴奋度': 120 } }, defs).custom['兴奋度'], '100')
  assert.equal(applyToolState({ custom: { '兴奋度': '10' } }, { custom: { '兴奋度': '55.4' } }, defs).custom['兴奋度'], '55')
})

test('applyToolState: custom undeclared key passes raw through (defaults to text)', () => {
  const { applyToolState } = loadClientBundle()
  const out = applyToolState({ custom: {} }, { custom: { '天气': '微雨' } }, {})
  assert.equal(out.custom['天气'], '微雨')
  // counter/meter mis-typed numeric still normalized by the built-in guards
  const bad = applyToolState({ custom: {} }, { custom: { 'x': 'abc' } }, { 'x': 'counter' })
  assert.equal(bad.custom.x, '0')
})

test('applyToolState: custom fields merge (prev preserved + new overridden)', () => {
  const { applyToolState } = loadClientBundle()
  const defs = { '接客数': 'counter', '营业': 'text' }
  const out = applyToolState(
    { custom: { '接客数': '9', '旧键': '旧值' } },
    { custom: { '接客数': '10', '营业': '打烊' } },
    defs,
  )
  // 合并而非覆盖：旧键保留，新值覆盖
  assert.deepEqual(out.custom, { '接客数': '10', '旧键': '旧值', '营业': '打烊' })
})