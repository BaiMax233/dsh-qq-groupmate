import assert from 'node:assert/strict'
import test from 'node:test'

import { SendLimiter, typingGap } from '../src/core/limiter.js'
import type { OutgoingMessage } from '../src/core/types.js'

function harness(options: { minGapMs?: number; maxPerHour?: number } = {}) {
  let clock = 1_000_000
  const sent: OutgoingMessage[] = []
  const limiter = new SendLimiter(
    {
      sendGroup: async (_groupId, message) => {
        sent.push(message)
        return {}
      },
    },
    {
      rate: { minGapMs: options.minGapMs ?? 10_000, maxPerHour: options.maxPerHour ?? 2 },
      now: () => clock,
    },
  )
  return {
    limiter,
    sent,
    advance(ms: number) {
      clock += ms
    },
  }
}

test('配额用完会拦住普通发言', async () => {
  const h = harness({ maxPerHour: 2, minGapMs: 1000 })

  await h.limiter.enqueue('g', [{ text: '一' }], { delayMs: 0 })
  h.advance(2000)
  await h.limiter.enqueue('g', [{ text: '二' }], { delayMs: 0 })
  h.advance(2000)

  const allowance = h.limiter.canSpeak('g')
  assert.equal(allowance.ok, false)
  assert.match(allowance.reason ?? '', /配额/)
})

test('被点名时不受每小时配额限制', async () => {
  const h = harness({ maxPerHour: 1, minGapMs: 1000 })

  await h.limiter.enqueue('g', [{ text: '一' }], { delayMs: 0 })
  h.advance(2000)

  assert.equal(h.limiter.canSpeak('g').ok, false)
  assert.equal(h.limiter.canSpeak('g', true).ok, true)
})

test('被点名仍然保留一个很短的冷却', async () => {
  const h = harness({ maxPerHour: 10, minGapMs: 60_000 })

  await h.limiter.enqueue('g', [{ text: '一' }], { delayMs: 0 })
  h.advance(1000)

  // 普通路上要等 60s，点名只等 3s。
  assert.equal(h.limiter.canSpeak('g').ok, false)
  assert.equal(h.limiter.canSpeak('g', true).ok, false)

  h.advance(3000)
  assert.equal(h.limiter.canSpeak('g', true).ok, true)
})

test('describe 报告当前小时已发条数', async () => {
  const h = harness({ maxPerHour: 5, minGapMs: 0 })
  await h.limiter.enqueue('g', [{ text: '一' }], { delayMs: 0 })

  const info = h.limiter.describe('g')
  assert.equal(info.sentLastHour, 1)
  assert.equal(info.ok, true)
})

test('一次发言里的多条消息不会被最小间隔挡掉', async () => {
  // 冷却 60 秒，但这是同一批，两条都该发出去。
  const h = harness({ maxPerHour: 10, minGapMs: 60_000 })
  await h.limiter.enqueue('g', [{ text: '第一条' }, { text: '第二条' }], { delayMs: 0 })

  assert.deepEqual(
    h.sent.map(message => message.text),
    ['第一条', '第二条'],
  )
  // 冷却从整批说完开始算。
  assert.equal(h.limiter.canSpeak('g').ok, false)
})

test('打字间隔随字数增长并封顶', () => {
  const short = typingGap('嗯', () => 0)
  const long = typingGap('这是一句相当长的话用来测试打字时间会不会变长', () => 0)
  assert.equal(short, 735)
  assert.equal(long > short, true)
  assert.equal(typingGap('长'.repeat(500), () => 0), 4000)
})
