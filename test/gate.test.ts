import assert from 'node:assert/strict'
import test from 'node:test'

import { WillingnessGate } from '../src/core/gate.js'
import { LlmSpeaker, sanitizeMessages, sanitizeLine, truncateChars } from '../src/core/speaker.js'
import type { GroupMessage } from '../src/core/types.js'
import { DEFAULT_PERSONA } from '../src/core/persona.js'
import { FakeModel } from './fake.js'

function message(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    id: 'm1',
    groupId: 'g1',
    userId: '20001',
    nickname: '张三',
    role: 'member',
    text: '有人打游戏吗',
    atSelf: false,
    replyToSelf: false,
    atUserIds: [],
    at: Date.now(),
    self: false,
    ...overrides,
  }
}

test('被 @ 时跳过模型直接参与', async () => {
  const model = new FakeModel(() => {
    throw new Error('不应该调用模型')
  })
  const gate = new WillingnessGate(model, DEFAULT_PERSONA, { threshold: 0.9, maxTokens: 100 })
  const verdict = await gate.evaluate([message({ atSelf: true })], new AbortController().signal)

  assert.equal(verdict.participate, true)
  assert.equal(verdict.forced, true)
  assert.equal(model.calls.length, 0)
})

test('模型输出未过门槛时不参与', async () => {
  const model = new FakeModel(() => '{"participate":true,"confidence":0.3,"intent":"join","reason":"随便聊聊"}')
  const gate = new WillingnessGate(model, DEFAULT_PERSONA, { threshold: 0.55, maxTokens: 100 })
  const verdict = await gate.evaluate([message()], new AbortController().signal)

  assert.equal(verdict.participate, false)
})

test('模型输出不是 JSON 时走规则兜底，并保留原文', async () => {
  const model = new FakeModel(() => '我觉得可以聊两句')
  const gate = new WillingnessGate(model, DEFAULT_PERSONA, { threshold: 0.55, maxTokens: 100 })
  const verdict = await gate.evaluate([message()], new AbortController().signal)

  assert.equal(verdict.participate, false)
  // 没有问句、没有叫我名字 → 规则判沉默。
  assert.equal(verdict.reason, 'rule:no-signal')
  assert.match(verdict.raw ?? '', /我觉得可以聊两句/)
  assert.equal(model.calls.length, 2)
})

test('模型抽风时，问句仍然会被规则接住', async () => {
  const model = new FakeModel(() => '嗯……让我想想')
  const gate = new WillingnessGate(model, DEFAULT_PERSONA, { threshold: 0.55, maxTokens: 100 })
  const verdict = await gate.evaluate([message({ text: '这个到底怎么弄？' })], new AbortController().signal)

  assert.equal(verdict.participate, true)
  assert.equal(verdict.reason, 'rule:question')
  assert.equal(verdict.forced, false)
})

test('模型抽风时，叫到名字也会被规则接住', async () => {
  const model = new FakeModel(() => 'not json at all')
  const gate = new WillingnessGate(model, DEFAULT_PERSONA, { threshold: 0.55, maxTokens: 100 })
  const verdict = await gate.evaluate([message({ text: '小满你说呢' })], new AbortController().signal)

  assert.equal(verdict.participate, true)
  assert.equal(verdict.reason, 'rule:name')
})

test('模型调用直接失败时也有规则兜底', async () => {
  const model = new FakeModel(() => {
    throw new Error('502 bad gateway')
  })
  const gate = new WillingnessGate(model, DEFAULT_PERSONA, { threshold: 0.55, maxTokens: 100 })
  const verdict = await gate.evaluate([message({ text: '今晚吃什么？' })], new AbortController().signal)

  assert.equal(verdict.participate, true)
  assert.equal(verdict.reason, 'rule:question')
  assert.match(verdict.raw ?? '', /502/)
})

test('第一次吐不出 JSON 时重试一次就能恢复', async () => {
  let calls = 0
  const model = new FakeModel(() => {
    calls += 1
    return calls === 1
      ? '我想想啊，这个话题'
      : '{"participate":true,"confidence":0.9,"intent":"join","delayMs":500,"style":"short","reason":"能接"}'
  })
  const gate = new WillingnessGate(model, DEFAULT_PERSONA, { threshold: 0.5, maxTokens: 100 })
  const verdict = await gate.evaluate([message()], new AbortController().signal)

  assert.equal(calls, 2)
  assert.equal(verdict.participate, true)
  assert.equal(verdict.reason, '能接')
})

test('模型输出被代码围栏包住也能解析', async () => {
  const model = new FakeModel(
    () => '```json\n{"participate":true,"confidence":0.8,"intent":"reply","delayMs":100,"style":"question"}\n```',
  )
  const gate = new WillingnessGate(model, DEFAULT_PERSONA, { threshold: 0.55, maxTokens: 100 })
  const verdict = await gate.evaluate([message()], new AbortController().signal)

  assert.equal(verdict.participate, true)
  assert.equal(verdict.style, 'question')
  assert.equal(verdict.forced, false)
})

test('发言清洗：去 markdown、截断、去重、限量', () => {
  assert.equal(sanitizeLine('**在**，`好`'), '在，好')
  assert.equal(truncateChars('一二三四五', 3), '一二三')
  assert.deepEqual(
    sanitizeMessages(['- 哈哈哈', '哈哈哈', '', '   ', 42], {
      maxMessages: 2,
      maxChars: 20,
      maxTokens: 10,
    }),
    ['哈哈哈'],
  )
})

test('speaker 只返回符合约束的短句', async () => {
  const long = '这是一句特别特别长的话'.repeat(10)
  const model = new FakeModel(() => JSON.stringify({ messages: [long, '**好**'] }))
  const speaker = new LlmSpeaker(model, DEFAULT_PERSONA, { maxMessages: 2, maxChars: 8, maxTokens: 100 })
  const texts = (
    await speaker.compose(
      {
        messages: [message()],
        verdict: { participate: true, confidence: 0.9, intent: 'join', targets: [], delayMs: 0, style: 'short', reason: 'test', forced: false },
      },
      new AbortController().signal,
    )
  ).texts

  assert.equal(texts.length, 2)
  assert.equal(texts[1], '好')
  assert.ok((texts[0] ?? '').length <= 8)
  assert.ok(texts.every(text => !text.includes('*')))
})
