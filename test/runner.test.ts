import assert from 'node:assert/strict'
import test from 'node:test'

import { GroupBuffers } from '../src/core/buffer.js'
import { WillingnessGate } from '../src/core/gate.js'
import { SendLimiter } from '../src/core/limiter.js'
import { DEFAULT_PERSONA } from '../src/core/persona.js'
import { GroupmateRunner, isQuietAt, parseQuietHours } from '../src/core/runner.js'
import type { RunnerConfig } from '../src/core/runner.js'
import { LlmSpeaker } from '../src/core/speaker.js'
import type { Logger } from '../src/core/types.js'
import { toGroupMessage } from '../src/onebot/segments.js'
import { FakeModel, FakeTransport, groupEvent } from './fake.js'

const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined }

function wait(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

interface Harness {
  readonly runner: GroupmateRunner
  readonly transport: FakeTransport
  readonly controller: AbortController
  start(): Promise<void>
  stop(): Promise<void>
}

function harness(
  reply: (system: string) => string,
  quietHours = '',
  overrides: { minMessages?: number; proactive?: RunnerConfig['proactive'] } = {},
): Harness {
  const transport = new FakeTransport()
  const model = new FakeModel(request => reply(request.system))
  const persona = DEFAULT_PERSONA
  const buffers = new GroupBuffers({ maxPerGroup: 20, maxGroups: 5 })
  const gate = new WillingnessGate(model, persona, { threshold: 0.55, maxTokens: 100 })
  const speaker = new LlmSpeaker(model, persona, { maxMessages: 2, maxChars: 40, maxTokens: 100 })
  const limiter = new SendLimiter(
    { sendGroup: (groupId, message) => transport.sendGroup(groupId, message) },
    { rate: { minGapMs: 0, maxPerHour: 10 }, gap: () => 0 },
  )

  const runner = new GroupmateRunner({
    transport,
    buffers,
    gate,
    speaker,
    limiter,
    config: {
      allow: new Set(['123456']),
      quietHours,
      windowMs: 20,
      maxWindowMs: 60,
      contextSize: 10,
      minMessages: overrides.minMessages ?? 1,
      proactive: overrides.proactive ?? {
        enabled: false,
        delayMs: 0,
        idleMinutes: 180,
        minGapMinutes: 240,
        maxPerDay: 2,
        search: false,
      },
    },
    speakerKind: 'llm',
    log: silentLogger,
    normalize: event =>
      toGroupMessage(event, { selfId: '10000', isOurs: messageId => messageId.startsWith('fake-') }),
  })

  const controller = new AbortController()
  let started: Promise<void> | undefined

  return {
    runner,
    transport,
    controller,
    async start() {
      started = runner.start(controller.signal)
      await Promise.resolve()
    },
    async stop() {
      controller.abort()
      await runner.stop()
      await started
    },
  }
}

const JOIN = '{"participate":true,"confidence":0.8,"intent":"join","delayMs":5,"style":"short","reason":"有话说"}'
const SILENT = '{"participate":false,"confidence":0.1,"intent":"ignore","reason":"跟我无关"}'
const SPEAK = '{"messages":["带我一个","几点"]}'

test('意愿达标时按顺序发出消息', async () => {
  const h = harness(system => (system.includes('参与判断') ? JOIN : SPEAK))
  await h.start()
  h.transport.emit(groupEvent())
  // 拟人化延迟被夹紧到 400ms 起，所以要等过这个下限。
  await wait(700)

  assert.equal(h.transport.sent.length, 2)
  assert.equal(h.transport.sent[0]?.message.text, '带我一个')
  assert.equal(h.transport.sent[0]?.groupId, '123456')
  assert.equal(h.runner.status().spoken, 2)
  await h.stop()
})

test('意愿不达标时不发消息', async () => {
  const h = harness(system => (system.includes('参与判断') ? SILENT : SPEAK))
  await h.start()
  h.transport.emit(groupEvent())
  await wait(700)

  assert.equal(h.transport.sent.length, 0)
  assert.equal(h.runner.status().skipped, 1)
  await h.stop()
})

test('同一个 message_id 只处理一次', async () => {
  const h = harness(system => (system.includes('参与判断') ? SILENT : SPEAK))
  await h.start()
  const event = groupEvent({ messageId: 'dup-1' })
  h.transport.emit(event)
  h.transport.emit(event)
  await wait(600)

  assert.equal(h.runner.status().received, 1)
  await h.stop()
})

test('白名单之外的群直接忽略', async () => {
  const h = harness(system => (system.includes('参与判断') ? JOIN : SPEAK))
  await h.start()
  h.transport.emit(groupEvent({ groupId: '999999' }))
  await wait(600)

  assert.equal(h.transport.sent.length, 0)
  assert.equal(h.runner.status().received, 0)
  await h.stop()
})

test('静默时段只记录不发言', async () => {
  const h = harness(system => JOIN, '00:00-23:59')
  await h.start()
  h.transport.emit(groupEvent())
  await wait(120)

  assert.equal(h.transport.sent.length, 0)
  assert.equal(h.runner.status().evaluated, 0)
  await h.stop()
})

test('自己发的消息只入缓冲，不触发评估', async () => {
  const h = harness(system => (system.includes('参与判断') ? JOIN : SPEAK))
  await h.start()
  h.transport.emit(groupEvent({ userId: '10000' }))
  await wait(120)

  assert.equal(h.transport.sent.length, 0)
  assert.equal(h.runner.status().received, 0)
  await h.stop()
})

test('停止后不再处理事件', async () => {
  const h = harness(system => JOIN)
  await h.start()
  await h.stop()
  h.transport.emit(groupEvent())
  await wait(80)

  assert.equal(h.transport.sent.length, 0)
})

test('窗口内被 @ 过后又有人插话，仍然强制回应', async () => {
  // 正常路径一律沉默：只有「记得那个 @」时才会真的发出来。
  const h = harness(system => (system.includes('参与判断') ? SILENT : SPEAK))
  await h.start()
  h.transport.emit(groupEvent({ messageId: 'm-at', atSelf: true }))
  h.transport.emit(groupEvent({ messageId: 'm-plain', text: '随便聊聊' }))
  // 被点名时的拟人化延迟是 500–1400ms 的随机值，必须等过上限。
  await wait(1700)

  assert.equal(h.transport.sent.length, 2)
  await h.stop()
})

test('新消息不够 minMessages 时不做判断', async () => {
  let gateCalls = 0
  const h = harness(
    system => {
      if (system.includes('参与判断')) {
        gateCalls += 1
        return JOIN
      }
      return SPEAK
    },
    '',
    { minMessages: 2 },
  )
  await h.start()
  h.transport.emit(groupEvent({ messageId: 'only-one' }))
  await wait(400)

  assert.equal(gateCalls, 0)
  assert.equal(h.transport.sent.length, 0)
  await h.stop()
})

test('静默时段解析支持跨零点', () => {
  const window = parseQuietHours('23:30-07:30')
  assert.ok(window)
  const at = (hour: number, minute: number): number => new Date(2026, 0, 1, hour, minute).getTime()
  assert.equal(isQuietAt(window, at(23, 45)), true)
  assert.equal(isQuietAt(window, at(3, 0)), true)
  assert.equal(isQuietAt(window, at(12, 0)), false)
  assert.equal(isQuietAt(parseQuietHours(''), at(12, 0)), false)
})
