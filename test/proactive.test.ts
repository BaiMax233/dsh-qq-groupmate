import assert from 'node:assert/strict'
import test from 'node:test'

import { GroupBuffers } from '../src/core/buffer.js'
import { SendLimiter } from '../src/core/limiter.js'
import { GroupmateRunner } from '../src/core/runner.js'
import type { ProactiveSettings } from '../src/core/runner.js'
import type { GroupMessage, Logger } from '../src/core/types.js'
import type { SpeakInput, SpeakResult, Speaker } from '../src/core/speaker.js'
import { FakeTransport, groupEvent } from './fake.js'
import { toGroupMessage } from '../src/onebot/segments.js'

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined }

const PROACTIVE: ProactiveSettings = {
  enabled: true,
  delayMs: 0,
  idleMinutes: 180,
  minGapMinutes: 240,
  maxPerDay: 2,
  search: true,
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

interface Rig {
  readonly runner: GroupmateRunner
  readonly transport: FakeTransport
  readonly inputs: SpeakInput[]
  readonly sent: string[]
  start(): Promise<void>
  stop(): Promise<void>
  advance(minutes: number): void
  tick(): Promise<void>
}

function rig(proactive: ProactiveSettings = PROACTIVE, quietHours = ''): Rig {
  let clock = new Date('2026-10-28T12:00:00').getTime()
  const transport = new FakeTransport()
  const buffers = new GroupBuffers({ maxPerGroup: 20, maxGroups: 5 })
  const inputs: SpeakInput[] = []
  const sent: string[] = []

  const gate = {
    evaluate: async () => ({
      participate: false,
      confidence: 0,
      intent: 'ignore' as const,
      targets: [],
      delayMs: 0,
      style: 'short' as const,
      reason: 'test',
      forced: false,
    }),
  } as unknown as ConstructorParameters<typeof GroupmateRunner>[0]['gate']

  const speaker: Speaker = {
    compose: async (input): Promise<SpeakResult> => {
      inputs.push(input)
      return { texts: ['有人聊点别的吗'], delivered: false }
    },
  }

  const limiter = new SendLimiter(
    {
      sendGroup: async (_groupId, message) => {
        sent.push(message.text)
        return {}
      },
    },
    { rate: { minGapMs: 0, maxPerHour: 100 }, gap: () => 0 },
  )

  const runner = new GroupmateRunner({
    transport,
    buffers,
    gate,
    speaker,
    limiter,
    config: {
      allow: new Set(['807813276']),
      quietHours,
      windowMs: 10,
      maxWindowMs: 20,
      contextSize: 10,
      minMessages: 1,
      proactive,
    },
    speakerKind: 'llm',
    log: silent,
    now: () => clock,
    normalize: event => toGroupMessage(event, { selfId: '10000', isOurs: () => false }),
  })

  const controller = new AbortController()
  let started: Promise<void> | undefined

  return {
    runner,
    transport,
    inputs,
    sent,
    async start() {
      started = runner.start(controller.signal)
      await Promise.resolve()
    },
    async stop() {
      controller.abort()
      await runner.stop()
      await started
    },
    advance(minutes: number) {
      clock += minutes * 60_000
    },
    async tick() {
      runner.tickProactive()
      await wait(30)
    },
  }
}

function message(text = '今天好安静'): GroupMessage {
  return toGroupMessage(groupEvent({ text }), { selfId: '10000', isOurs: () => false }) as GroupMessage
}

test('冷场够久才会主动开口，并带上冷场时长', async () => {
  const r = rig()
  await r.start()
  r.transport.emit(groupEvent({ groupId: '807813276', text: '今天好安静' }))
  await wait(60)

  // 只过了一小时：还没到 180 分钟。
  r.advance(60)
  await r.tick()
  assert.equal(r.inputs.length, 0)

  r.advance(150)
  await r.tick()
  assert.equal(r.inputs.length, 1)
  assert.equal(r.inputs[0]?.proactive?.idleMinutes, 210)
  assert.equal(r.inputs[0]?.proactive?.searching, true)
  assert.deepEqual(r.sent, ['有人聊点别的吗'])

  await r.stop()
})

test('主动开口有冷却，不会连着说', async () => {
  const r = rig()
  await r.start()
  r.transport.emit(groupEvent({ groupId: '807813276', text: '今天好安静' }))
  await wait(60)
  r.advance(200)

  await r.tick()
  await r.tick()
  assert.equal(r.inputs.length, 1)

  // 冷却 240 分钟：还差一点。
  r.advance(200)
  await r.tick()
  assert.equal(r.inputs.length, 1)

  r.advance(60)
  await r.tick()
  assert.equal(r.inputs.length, 2)

  await r.stop()
})

test('每天有次数上限', async () => {
  const r = rig({ ...PROACTIVE, maxPerDay: 1, minGapMinutes: 0 })
  await r.start()
  r.transport.emit(groupEvent({ groupId: '807813276', text: '今天好安静' }))
  await wait(60)
  r.advance(200)

  await r.tick()
  assert.equal(r.inputs.length, 1)

  r.advance(30)
  await r.tick()
  assert.equal(r.inputs.length, 1, '同一天不该再开口')

  await r.stop()
})

test('关掉之后完全不动', async () => {
  const r = rig({ ...PROACTIVE, enabled: false })
  await r.start()
  r.transport.emit(groupEvent({ groupId: '807813276', text: '今天好安静' }))
  await wait(60)
  r.advance(600)

  await r.tick()
  assert.equal(r.inputs.length, 0)

  await r.stop()
})

test('还没见过这个群说过话就不打扰', async () => {
  const r = rig()
  await r.start()
  r.advance(600)
  await r.tick()
  assert.equal(r.inputs.length, 0)
  await r.stop()
})

test('静默时段内不主动开口', async () => {
  // 时钟停在 12:00，静默时段把中午圈进去。
  const r = rig(PROACTIVE, '00:00-23:59')
  await r.start()
  r.transport.emit(groupEvent({ groupId: '807813276', text: '今天好安静' }))
  await wait(60)
  r.advance(600)

  await r.tick()
  assert.equal(r.inputs.length, 0)

  await r.stop()
})
