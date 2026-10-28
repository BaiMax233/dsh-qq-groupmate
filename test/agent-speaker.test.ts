import assert from 'node:assert/strict'
import test from 'node:test'

import type { Context } from '@deepseek-ai/cordis'

import { DEFAULT_PERSONA } from '../src/core/persona.js'
import type { GroupMessage } from '../src/core/types.js'
import { AgentSpeaker, sessionIdFor } from '../src/host/agent-speaker.js'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined }

function message(text = '有人打游戏吗'): GroupMessage {
  return {
    id: 'm1',
    groupId: '807813276',
    userId: '20001',
    nickname: '张三',
    role: 'member',
    text,
    atSelf: false,
    replyToSelf: false,
    atUserIds: [],
    at: Date.now(),
    self: false,
  }
}

const verdict = {
  participate: true as const,
  confidence: 0.9,
  intent: 'join' as const,
  targets: [],
  delayMs: 0,
  style: 'short' as const,
  reason: '有话说',
  forced: false,
}

interface Harness {
  readonly speaker: AgentSpeaker
  readonly delivered: Array<{ groupId: string; text: string; mention?: string; replyTo?: string }>
  readonly registered: string[]
  readonly restricted: unknown[]
  readonly sessions: string[]
}

function harness(behaviour: 'reply' | 'silent', args: Record<string, unknown> = { text: '在' }): Harness {
  const delivered: Array<{ groupId: string; text: string; mention?: string; replyTo?: string }> = []
  const registered: string[] = []
  const restricted: unknown[] = []
  const sessions: string[] = []

  let tool: ToolDefinition | undefined
  let pending: Promise<unknown> | undefined

  const agent = {
    id: 'session-x',
    followup() {
      if (behaviour === 'silent') return
      const signal = new AbortController().signal
      pending = tool?.execute(args, { signal } as unknown as Parameters<ToolDefinition['execute']>[1])
    },
    async whenIdle() {
      await pending
    },
    cancel() {},
    status: 'idle',
  }

  const fakeCtx = {
    agentLoop: {
      resume: async () => {
        throw new Error('no such session')
      },
      createAgent: async (_owner: unknown, options: { sessionId: string; setup?: (ctx: unknown) => void }) => {
        sessions.push(options.sessionId)
        const agentCtx = {
          tools: {
            register: (definition: ToolDefinition) => {
              registered.push(definition.name)
              tool = definition
              return () => undefined
            },
            restrict: (filter: unknown) => {
              restricted.push(filter)
              return () => undefined
            },
          },
          systemPrompt: { section: () => () => undefined },
        }
        options.setup?.(agentCtx)
        return { agent, dispose: async () => undefined }
      },
    },
  }

  const speaker = new AgentSpeaker({
    ctx: fakeCtx as unknown as Context,
    persona: DEFAULT_PERSONA,
    route: { provider: 'p', model: 'm' },
    cwd: 'E:\\quit-code\\qq-groups',
    turnTimeoutMs: 5000,
    ttlMs: 60000,
    allowTools: ['web_search'],
    maxChars: 40,
    log: silent,
    deliver: async (groupId, message) => {
      delivered.push({
        groupId,
        text: message.text,
        mention: message.mention,
        replyTo: message.replyTo,
      })
    },
  })

  return { speaker, delivered, registered, restricted, sessions }
}

test('Agent 后端：注册发言工具并投递消息', async () => {
  const h = harness('reply')
  const result = await h.speaker.compose(
    { messages: [message()], verdict },
    new AbortController().signal,
  )

  assert.deepEqual(h.registered, ['qq_send_message'])
  assert.deepEqual(h.restricted, [{ allow: ['web_search'] }])
  assert.equal(h.delivered.length, 1)
  assert.equal(h.delivered[0]?.groupId, '807813276')
  assert.equal(h.delivered[0]?.text, '在')
  assert.equal(h.delivered[0]?.mention, undefined)
  assert.equal(h.delivered[0]?.replyTo, undefined)
  assert.deepEqual(result.texts, ['在'])
  assert.equal(result.delivered, true)

  await h.speaker.dispose()
})

test('Agent 后端：mention 与 quote 会变成 @ 和引用', async () => {
  const h = harness('reply', { text: '在', mention: '20001', quote: '20001' })
  await h.speaker.compose({ messages: [message()], verdict }, new AbortController().signal)

  assert.equal(h.delivered.length, 1)
  assert.equal(h.delivered[0]?.mention, '20001')
  // 引用的是快照里这个人的最后一条消息（message() 的 id 是 m1）。
  assert.equal(h.delivered[0]?.replyTo, 'm1')

  await h.speaker.dispose()
})

test('Agent 后端：非法的 mention 会被丢掉', async () => {
  const h = harness('reply', { text: '在', mention: '张三' })
  await h.speaker.compose({ messages: [message()], verdict }, new AbortController().signal)

  assert.equal(h.delivered[0]?.mention, undefined)
  await h.speaker.dispose()
})

test('Agent 后端：什么都不发时 delivered 为 false', async () => {
  const h = harness('silent')
  const result = await h.speaker.compose(
    { messages: [message()], verdict },
    new AbortController().signal,
  )

  assert.deepEqual(result.texts, [])
  assert.equal(result.delivered, false)
  assert.equal(h.delivered.length, 0)

  await h.speaker.dispose()
})

test('同一个群复用同一个 session，不同群不同', async () => {
  const h = harness('silent')
  await h.speaker.compose({ messages: [message()], verdict }, new AbortController().signal)
  // 第二次不会再次创建（ensure 命中缓存），但会话本来就只建了一个。
  assert.equal(h.sessions.length, 1)
  assert.equal(h.sessions[0], sessionIdFor('807813276'))

  const other = sessionIdFor('123456')
  assert.notEqual(other, h.sessions[0])
  assert.match(h.sessions[0] ?? '', /^session-[0-9a-f-]{36}$/)

  await h.speaker.dispose()
})
