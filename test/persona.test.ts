import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_PERSONA, renderPersona, shouldFlare } from '../src/core/persona.js'

test('没配发作台词时永远不发作', () => {
  const persona = { ...DEFAULT_PERSONA, flare: '', flareRate: 1 }
  assert.equal(shouldFlare(persona, () => 0), false)
})

test('概率生效：掷点低于概率才发作', () => {
  const persona = { ...DEFAULT_PERSONA, flare: '放肆！', flareRate: 0.2 }
  assert.equal(shouldFlare(persona, () => 0.1), true)
  assert.equal(shouldFlare(persona, () => 0.9), false)
})

test('概率被夹紧在 0–1', () => {
  const hot = { ...DEFAULT_PERSONA, flare: '放肆！', flareRate: 5 }
  assert.equal(shouldFlare(hot, () => 0.99), true)

  const cold = { ...DEFAULT_PERSONA, flare: '放肆！', flareRate: -3 }
  assert.equal(shouldFlare(cold, () => 0), false)
})

test('人设渲染会带上发作台词，留空时不会出现', () => {
  const withFlare = renderPersona({ ...DEFAULT_PERSONA, flare: '本座今日心情不错' })
  assert.match(withFlare, /本座今日心情不错/)

  const without = renderPersona({ ...DEFAULT_PERSONA, flare: '' })
  assert.equal(without.includes('发作'), false)
})
