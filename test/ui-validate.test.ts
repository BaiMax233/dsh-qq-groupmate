import assert from 'node:assert/strict'
import test from 'node:test'

import { readGroups, readPersona, readRate } from '../src/host/ui.js'

test('群号：接受字符串和数字，去重', () => {
  assert.deepEqual(readGroups(['807813276', 123456]), ['807813276', '123456'])
  assert.deepEqual(readGroups(['807813276', '807813276']), ['807813276'])
  assert.deepEqual(readGroups([]), [])
})

test('群号：非法格式整批拒绝', () => {
  assert.equal(readGroups(['abc']), undefined)
  assert.equal(readGroups(['123']), undefined)
  assert.equal(readGroups(['1234567890123']), undefined)
  assert.equal(readGroups('807813276'), undefined)
})

test('群号：超过 20 个拒绝', () => {
  const many = Array.from({ length: 21 }, (_, i) => String(100000 + i))
  assert.equal(readGroups(many), undefined)
})

test('配额：范围内接受，越界拒绝', () => {
  assert.deepEqual(readRate({ maxPerHour: 8, unlimited: false }), { maxPerHour: 8, unlimited: false })
  assert.deepEqual(readRate({ maxPerHour: '12', unlimited: true }), { maxPerHour: 12, unlimited: true })
  assert.equal(readRate({ maxPerHour: 0 }), undefined)
  assert.equal(readRate({ maxPerHour: 241 }), undefined)
  assert.equal(readRate({ maxPerHour: 'abc' }), undefined)
  assert.equal(readRate(null), undefined)
})

test('人设：名字必填且限长', () => {
  assert.equal(readPersona({ name: '' }), undefined)
  assert.equal(readPersona({ name: 'x'.repeat(41) }), undefined)
  assert.ok(readPersona({ name: '小白', bio: 'hi', interests: ['a'], speech: '短句' }))
})
