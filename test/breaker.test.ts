import assert from 'node:assert/strict'
import test from 'node:test'

import { CircuitBreaker } from '../src/core/breaker.js'
import { SendLimiter } from '../src/core/limiter.js'

function clock() {
  let now = 1_000_000
  return {
    now: () => now,
    advance(ms: number) {
      now += ms
    },
  }
}

test('连续三次真失败就熔断，冷却后自动恢复', () => {
  const c = clock()
  const breaker = new CircuitBreaker({ now: c.now, cooldownMs: 30 * 60_000 })

  assert.equal(breaker.allow().ok, true)
  breaker.recordFailure('boom')
  breaker.recordFailure('boom')
  assert.equal(breaker.allow().ok, true, '两次还不算')

  breaker.recordFailure('boom')
  const open = breaker.allow()
  assert.equal(open.ok, false)
  assert.match(open.reason ?? '', /熔断中/)

  c.advance(29 * 60_000)
  assert.equal(breaker.allow().ok, false)

  c.advance(2 * 60_000)
  assert.equal(breaker.allow().ok, true, '冷却结束自动恢复')
})

test('一次成功会把连败计数清零', () => {
  const c = clock()
  const breaker = new CircuitBreaker({ now: c.now })

  breaker.recordFailure('a')
  breaker.recordFailure('b')
  breaker.recordSuccess()
  breaker.recordFailure('c')
  breaker.recordFailure('d')

  assert.equal(breaker.allow().ok, true, '中间成功过一次，不该熔断')
})

test('风控信号要在窗口内连着出现才熔断', () => {
  const c = clock()
  const breaker = new CircuitBreaker({
    now: c.now,
    riskWindowMs: 10 * 60_000,
    riskThreshold: 3,
    cooldownMs: 30 * 60_000,
  })

  breaker.recordRisk('event-checker-timeout')
  c.advance(11 * 60_000)
  breaker.recordRisk('event-checker-timeout')
  c.advance(11 * 60_000)
  breaker.recordRisk('event-checker-timeout')
  assert.equal(breaker.allow().ok, true, '每次间隔超过窗口，不该熔断')

  breaker.recordRisk('event-checker-timeout')
  c.advance(60_000)
  breaker.recordRisk('event-checker-timeout')
  c.advance(60_000)
  breaker.recordRisk('event-checker-timeout')

  const open = breaker.allow()
  assert.equal(open.ok, false)
  assert.match(open.reason ?? '', /熔断中/)
})

test('发送失败会喂给熔断器，熔断后连点名也发不出去', async () => {
  const c = clock()
  const breaker = new CircuitBreaker({ now: c.now })
  const limiter = new SendLimiter(
    {
      sendGroup: async () => {
        throw new Error('network down')
      },
    },
    {
      rate: { minGapMs: 0, maxPerHour: 100 },
      now: c.now,
      gap: () => 0,
      breaker,
    },
  )

  for (let i = 0; i < 3; i += 1) {
    await limiter.enqueue('g', [{ text: 'x' }], { delayMs: 0 }).catch(() => undefined)
  }

  const normal = limiter.canSpeak('g')
  assert.equal(normal.ok, false)
  assert.match(normal.reason ?? '', /熔断中/)

  const urgent = limiter.canSpeak('g', true)
  assert.equal(urgent.ok, false, '点名也不该绕过熔断')
})

test('发送成功后熔断器恢复', async () => {
  const c = clock()
  const breaker = new CircuitBreaker({ now: c.now })
  let fail = true
  const limiter = new SendLimiter(
    {
      sendGroup: async () => {
        if (fail) throw new Error('network down')
        return {}
      },
    },
    {
      rate: { minGapMs: 0, maxPerHour: 100 },
      now: c.now,
      gap: () => 0,
      breaker,
    },
  )

  for (let i = 0; i < 3; i += 1) {
    await limiter.enqueue('g', [{ text: 'x' }], { delayMs: 0 }).catch(() => undefined)
  }
  assert.equal(limiter.canSpeak('g').ok, false)

  c.advance(31 * 60_000)
  fail = false
  await limiter.enqueue('g', [{ text: 'y' }], { delayMs: 0 })
  assert.equal(limiter.canSpeak('g').ok, true)
})
