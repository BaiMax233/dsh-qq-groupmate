import assert from 'node:assert/strict'
import test from 'node:test'

import { Config, normalizeGroupId } from '../src/config.js'

test('空配置得到完整默认值', () => {
  const config = Config({})
  assert.equal(config.enabled, true)
  assert.equal(config.connection.wsUrl, 'ws://127.0.0.1:3001')
  assert.equal(config.connection.tokenEnv, 'NAPCAT_TOKEN')
  assert.deepEqual(config.groups.allow, [])
  assert.equal(config.groups.quietHours, '23:30-07:30')
  assert.equal(config.gate.threshold, 0.55)
  assert.equal(config.speaker.maxChars, 56)
})

test('省略整段配置时也能补齐（YAML 里只写一部分是常态）', () => {
  const config = Config({
    groups: { allow: [123456, '789'] },
    speaker: { provider: 'deepseek', model: 'deepseek-chat' },
  })
  assert.deepEqual(config.groups.allow, [123456, '789'])
  assert.equal(config.groups.maxPerGroup, 60)
  assert.equal(config.speaker.provider, 'deepseek')
  assert.equal(config.speaker.maxMessages, 2)
})

test('群号统一转成字符串', () => {
  assert.deepEqual(
    [123456, ' 789 '].map(normalizeGroupId),
    ['123456', '789'],
  )
})

test('越界阈值被拒绝', () => {
  assert.throws(() => Config({ gate: { threshold: 2 } }))
})
