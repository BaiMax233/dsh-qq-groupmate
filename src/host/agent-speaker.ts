import { createHash } from 'node:crypto'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { Persona } from '../core/persona.js'
import { renderPersona, renderTranscript, shouldFlare } from '../core/persona.js'
import type { SpeakInput, SpeakResult, Speaker } from '../core/speaker.js'
import type { GroupMessage, Logger, OutgoingMessage } from '../core/types.js'
import { errorMessage } from '../core/types.js'
import { createSendMessageTool } from './tool.js'

export interface AgentRoute {
  readonly provider: string
  readonly model: string
}

export interface AgentSpeakerOptions {
  readonly ctx: Context
  readonly persona: Persona
  readonly route: AgentRoute
  readonly cwd: string
  readonly turnTimeoutMs: number
  readonly ttlMs: number
  readonly allowTools: readonly string[]
  readonly maxChars: number
  readonly log: Logger
  /** 掷骰子的随机源，测试可替换。 */
  readonly random?: () => number
  /** 投递一条消息；外层注入 limiter，保证频控不变。 */
  readonly deliver: (
    groupId: string,
    message: OutgoingMessage,
    options: { delayMs: number; urgent: boolean },
    signal: AbortSignal,
  ) => Promise<void>
  /** 把这一轮里的图片取成模型能吃的 image block；不提供就纯文本。 */
  readonly loadImages?: (messages: readonly GroupMessage[], signal: AbortSignal) => Promise<unknown[]>
  /** 群友档案摘要，拼进这一轮的提示词。 */
  readonly memberSummary?: (groupId: string) => string
}

/** Agent 服务的窄接口：只声明用到的方法，不把插件绑死在内部类型上。 */
interface AgentLoopLike {
  createAgent(ownerCtx: Context, options: Record<string, unknown>): Promise<AgentHandle>
  resume(ownerCtx: Context, options: Record<string, unknown>): Promise<AgentHandle>
}

interface AgentScoped {
  readonly tools: {
    register(definition: ToolDefinition): () => void
    restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void
    schemas(scope?: unknown): Array<{ name: string }>
  }
  readonly systemPrompt: {
    section(section: { name: string; order: number; text: string }): () => void
  }
}

interface GroupRuntime {
  /** 我们自己创建的会话才有 handle；借用别人的活 agent 时为空。 */
  readonly handle?: AgentHandle
  readonly agent: Agent
  sent: string[]
  /** 这一轮看到的群聊快照，用来把「引用谁」解析成 message_id。 */
  snapshot: GroupMessage[]
  delayMs: number
  /** 这一轮是不是被直接点名：点名走频控的优先通道。 */
  urgent: boolean
  lastUsed: number
  closed: boolean
  /** agent 自己的作用域，诊断用（看它到底能看见哪些工具）。 */
  scoped?: AgentScoped
  /** 初始化过程中的失败原因，诊断用。 */
  setupError?: string
  failures?: readonly string[]
  /** 借用活 agent 时，我们自己加进去的注册要先撤掉。 */
  disposers?: Array<() => void>
  adopted?: boolean
}

type FollowupMessage = Parameters<Agent['followup']>[0]

/**
 * 每个群一个持久 Agent 会话。
 *
 * 与一次性调用的区别：它有会话日志（记忆跨重启）、有工具、能多步。
 * 但代价是慢——所以 gate 仍然在前面挡着，只有决定要说话时才叫醒它。
 */
export class AgentSpeaker implements Speaker {
  private readonly groups = new Map<string, GroupRuntime>()
  private readonly sweeper: ReturnType<typeof setInterval>

  constructor(private readonly options: AgentSpeakerOptions) {
    this.sweeper = setInterval(() => {
      void this.sweep()
    }, 60_000)
    this.sweeper.unref()
  }

  async compose(input: SpeakInput, signal: AbortSignal): Promise<SpeakResult> {
    const last = input.messages[input.messages.length - 1]
    if (!last) return { texts: [], delivered: false }
    const groupId = last.groupId

    let group: GroupRuntime
    try {
      group = await this.ensure(groupId)
    } catch (error) {
      this.options.log.error(`[qq] 群 ${groupId} 的 agent 启动失败：${errorMessage(error)}`)
      return { texts: [], delivered: false }
    }

    group.sent = []
    group.snapshot = [...input.messages]
    group.delayMs = input.verdict.delayMs
    group.urgent = input.verdict.forced
    group.lastUsed = Date.now()

    const images = await this.loadImages(input.messages, signal)
    // 每轮掷一次骰子决定「发作」与否，不交给模型自觉。
    const flare = shouldFlare(this.options.persona, this.options.random)

    const message = {
      id: `qq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      content: [
        {
          type: 'text',
          text: buildTurnPrompt(
            input,
            flare,
            this.options.maxChars,
            this.options.memberSummary?.(groupId) ?? '',
          ),
        },
        ...images,
      ],
      source: { kind: 'user' },
    } as unknown as FollowupMessage

    try {
      group.agent.followup(message)
      // 让驱动先把 turn 开起来，再等 quiescence——否则 whenIdle 可能在 turn 开始前就返回。
      await new Promise<void>(resolve => {
        setTimeout(resolve, 0)
      })
      await this.waitIdle(group, signal)
    } catch (error) {
      if (!signal.aborted) {
        this.options.log.warn(`[qq] 群 ${groupId} 这一轮没走完：${errorMessage(error)}`)
        try {
          group.agent.cancel({ kind: 'hook', reason: 'qq-turn-failed' })
        } catch {
          // 已经结束的会话取消会抛错，忽略。
        }
        // 自愈：丢掉缓存的会话，下一轮重新 ensure（借用的 agent 可能已经被关掉了）。
        this.dropGroup(groupId, group)
      }
    }

    return { texts: group.sent, delivered: group.sent.length > 0 }
  }

  async dispose(): Promise<void> {
    clearInterval(this.sweeper)
    const groups = [...this.groups.values()]
    this.groups.clear()
    for (const group of groups) {
      await this.release(group)
    }
  }

  /** 释放一个群会话：自己建的 agent 要 dispose，借用的只撤掉自己的注册。 */
  private async release(group: GroupRuntime): Promise<void> {    group.closed = true
    for (const dispose of group.disposers ?? []) {
      try {
        dispose()
      } catch {
        // 作用域可能已经随 agent 一起消失。
      }
    }
    group.disposers = []
    if (group.handle === undefined) return
    try {
      await group.handle.dispose()
    } catch (error) {
      this.options.log.warn(`[qq] 释放群会话失败：${errorMessage(error)}`)
    }
  }

  addSent(groupId: string, text: string): void {
    this.groups.get(groupId)?.sent.push(text)
  }

  /** 丢掉缓存并释放，用来从「会话已经不可用」里自愈。 */
  private dropGroup(groupId: string, group: GroupRuntime): void {
    if (this.groups.get(groupId) !== group) return
    this.groups.delete(groupId)
    void this.release(group)
  }

  /** 诊断：把某个群的 agent 拉起来（或复用），返回它的状态。 */
  async inspect(groupId: string): Promise<Record<string, unknown>> {
    try {
      await this.ensure(groupId)
    } catch (error) {
      return { groupId, ensureError: errorMessage(error) }
    }
    return this.debug().find(entry => entry['groupId'] === groupId) ?? { groupId, missing: true }
  }

  /** 诊断：每个活着的群会话能看到哪些工具、上一轮说了什么。 */
  debug(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = []
    for (const [groupId, group] of this.groups) {
      let tools: string[] = []
      try {
        tools = group.scoped === undefined ? [] : visibleTools(group.scoped, group.agent)
      } catch (error) {
        tools = [`<读取失败：${errorMessage(error)}>`]
      }
      out.push({
        groupId,
        sessionId: String(group.agent.id),
        tools,
        setupError: group.setupError ?? null,
        failures: group.failures ?? [],
        lastAssistant: lastAssistantText(group.agent).slice(0, 400),
        lastUsedAt: new Date(group.lastUsed).toISOString(),
      })
    }
    return out
  }

  private async loadImages(
    messages: readonly GroupMessage[],
    signal: AbortSignal,
  ): Promise<unknown[]> {
    if (this.options.loadImages === undefined) return []
    try {
      return await this.options.loadImages(messages, signal)
    } catch (error) {
      this.options.log.warn(`[qq] 图片加载失败：${errorMessage(error)}`)
      return []
    }
  }

  delayOf(groupId: string): number {
    return this.groups.get(groupId)?.delayMs ?? 0
  }

  urgentOf(groupId: string): boolean {
    return this.groups.get(groupId)?.urgent === true
  }

  private async ensure(groupId: string): Promise<GroupRuntime> {
    const existing = this.groups.get(groupId)
    if (existing && !existing.closed) return existing

    const sessionId = sessionIdFor(groupId)
    const loop = (this.options.ctx as unknown as { agentLoop: AgentLoopLike }).agentLoop
    const agentOptions = { provider: this.options.route.provider, model: this.options.route.model }

    let scopedRef: AgentScoped | undefined
    let setupError: string | undefined

    const setup = (agentCtx: Context): void => {
      setupError = undefined
      const scoped = agentCtx as unknown as AgentScoped
      scopedRef = scoped
      const result = this.registerScoped(scoped, groupId)
      if (result.error !== undefined) {
        setupError = result.error
        this.options.log.warn(`[qq] 群 ${groupId} 的 agent 初始化不完整：${setupError}`)
      }
    }

    // 优先复用「已经活着」的那个 agent：用户可能在界面上把群会话点开了，
    // 此时它持有写句柄，resume 必然失败。复用它比另起一个新会话合理。
    const live = this.liveAgent(sessionId)
    if (live !== undefined) {
      const scoped = live.ctx as unknown as AgentScoped
      const result = this.registerScoped(scoped, groupId)
      const group = this.makeGroup(groupId, live, scoped, [], {
        adopted: true,
        disposers: [result.dispose],
        setupError: result.error,
      })
      this.options.log.info(`[qq] 群 ${groupId} 复用了已在运行的会话（${sessionId}）`)
      return group
    }

    let handle: AgentHandle | undefined
    const failures: string[] = []

    // 首选原会话；被残留写句柄占住时退到固定的备用 id——
    // 备用 id 是确定的，所以第二次重启还能 resume 回来，记忆不会每次都清零。
    for (const candidate of [sessionId, `${sessionId}-v2`]) {
      try {
        handle = await loop.resume(this.options.ctx, { resumeSessionId: candidate, agentOptions, setup })
        break
      } catch (error) {
        failures.push(`resume ${candidate}: ${errorMessage(error)}`)
      }
      try {
        handle = await loop.createAgent(this.options.ctx, {
          sessionId: candidate,
          meta: { cwd: this.options.cwd },
          agentOptions,
          setup,
        })
        break
      } catch (error) {
        failures.push(`create ${candidate}: ${errorMessage(error)}`)
      }
    }

    // 极端情况下再退一步：宁可丢记忆，也不能让群友彻底变哑巴。
    if (handle === undefined) {
      const lastResort = `${sessionId}-r${Date.now().toString(36)}`
      this.options.log.warn(`[qq] 群 ${groupId} 恢复会话失败：${failures.join(' | ')}；改用 ${lastResort}`)
      handle = await loop.createAgent(this.options.ctx, {
        sessionId: lastResort,
        meta: { cwd: this.options.cwd },
        agentOptions,
        setup,
      })
    }

    return this.makeGroup(groupId, handle.agent, scopedRef, failures, { handle, setupError })
  }

  private makeGroup(
    groupId: string,
    agent: Agent,
    scoped: AgentScoped | undefined,
    failures: readonly string[],
    extra: { handle?: AgentHandle; setupError?: string; adopted?: boolean; disposers?: Array<() => void> },
  ): GroupRuntime {
    const group: GroupRuntime = {
      handle: extra.handle,
      agent,
      sent: [],
      snapshot: [],
      delayMs: 0,
      urgent: false,
      lastUsed: Date.now(),
      closed: false,
      scoped,
      setupError: extra.setupError,
      failures,
      adopted: extra.adopted,
      disposers: extra.disposers,
    }
    this.groups.set(groupId, group)
    return group
  }

  /** 在当前进程里找已经活着的 agent（用户可能把会话点开了）。 */
  private liveAgent(sessionId: string): Agent | undefined {
    const agents = (this.options.ctx as unknown as { agents?: { get(id: string): Agent | undefined } }).agents
    try {
      return agents?.get(sessionId)
    } catch {
      return undefined
    }
  }

  /** 把发言工具和人设注册进某个 agent 作用域，返回撤销用的 disposer。 */
  private registerScoped(scoped: AgentScoped, groupId: string): { dispose: () => void; error?: string } {
    const disposers: Array<() => void> = []
    const undo = (): void => {
      while (disposers.length > 0) {
        const dispose = disposers.pop()
        try {
          dispose?.()
        } catch {
          // 作用域可能已经消失。
        }
      }
    }

    try {
      disposers.push(
        scoped.tools.register(
          createSendMessageTool({
            groupId,
            maxChars: this.options.maxChars,
            send: async (draft, signal) => {
              // 「引用谁」在这里解析成 message_id：模型只认 QQ 号，不认消息 id。
              const snapshot = this.groups.get(groupId)?.snapshot ?? []
              const replyTo = draft.quote === undefined ? undefined : lastMessageIdOf(snapshot, draft.quote)
              await this.options.deliver(
                groupId,
                { text: draft.text, mention: draft.mention, replyTo },
                { delayMs: this.delayOf(groupId), urgent: this.urgentOf(groupId) },
                signal,
              )
              this.addSent(groupId, draft.text)
            },
          }),
        ),
      )

      // 只留几个查询类工具：群友不该在别人的服务器上读写文件。
      if (this.options.allowTools.length > 0) {
        try {
          disposers.push(scoped.tools.restrict({ allow: [...this.options.allowTools] }))
        } catch (error) {
          this.options.log.warn(`[qq] 工具白名单未生效：${errorMessage(error)}`)
        }
      }

      disposers.push(
        scoped.systemPrompt.section({
          name: 'qq-groupmate-persona',
          order: 1000,
          text: renderPersona(this.options.persona),
        }),
      )
      return { dispose: undo }
    } catch (error) {
      undo()
      return { dispose: () => undefined, error: errorMessage(error) }
    }
  }

  private async waitIdle(group: GroupRuntime, signal: AbortSignal): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        try {
          group.agent.cancel({ kind: 'hook', reason: 'qq-turn-timeout' })
        } catch {
          // 忽略
        }
        reject(new Error(`agent turn 超过 ${this.options.turnTimeoutMs}ms`))
      }, this.options.turnTimeoutMs)
    })

    const aborted = new Promise<never>((_resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })

    try {
      await Promise.race([group.agent.whenIdle(), timeout, aborted])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private async sweep(): Promise<void> {
    const now = Date.now()
    for (const [groupId, group] of this.groups) {
      if (group.closed || now - group.lastUsed < this.options.ttlMs) continue
      this.groups.delete(groupId)
      await this.release(group)
      this.options.log.info(`[qq] 群 ${groupId} 的会话闲置超时，已释放（历史保留）`)
    }
  }
}

/** 群号 → 稳定的 session id，重启后还能找回同一份记忆。 */
export function sessionIdFor(groupId: string): string {
  const hash = createHash('sha256').update(`qq-groupmate:${groupId}`).digest('hex')
  const uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
  return `session-${uuid}`
}

/** 找到某人在本轮快照里最近发的一条消息，用来做引用回复。 */
function lastMessageIdOf(messages: readonly GroupMessage[], userId: string): string | undefined {  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && message.userId === userId) return message.id
  }
  return undefined
}

/** 当前 agent 作用域里真正可见的工具名。 */
function visibleTools(scoped: AgentScoped, agent: Agent): string[] {
  return scoped.tools.schemas(agent).map(schema => schema.name)
}

/** 会话里最后一条助手消息的文本，用来解释「为什么它没说话」。 */
function lastAssistantText(agent: Agent): string {
  const session = agent as unknown as {
    session?: { events?: readonly { type: string; data?: Record<string, unknown> }[] }
  }
  const events = session.session?.events ?? []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const message = event.data?.['message'] as { content?: unknown } | undefined
    const content = Array.isArray(message?.content) ? message?.content : []
    return content
      .map(block =>
        block !== null && typeof block === 'object' && (block as Record<string, unknown>)['type'] === 'text'
          ? String((block as Record<string, unknown>)['text'] ?? '')
          : '',
      )
      .join('')
  }
  return ''
}

function buildTurnPrompt(
  input: SpeakInput,
  flare: boolean,
  maxChars: number,
  memberSummary: string,
): string {
  const verdict = input.verdict
  const proactive = input.proactive
  const lines = ['【群里刚刚发生了什么】', '---', renderTranscript(input.messages), '---']

  if (proactive !== undefined) {
    lines.push(
      `【群里已经安静了 ${proactive.idleMinutes} 分钟】`,
      '这次没有人叫你。你可以接着上面的话题问一句进展，或者抛一个大家会想聊的新鲜事。',
    )
    if (proactive.searching) {
      lines.push('需要的话可以先用 web_search 查一下最近的相关新闻再开口；搜不到就别硬编。')
    }
  } else {
    lines.push('【为什么叫醒你】', verdict.reason)
    if (verdict.targets.length > 0) lines.push(`你可能想回应：${verdict.targets.join(', ')}`)
  }

  if (memberSummary !== '') lines.push('', memberSummary)

  lines.push(
    '',
    flare
      ? [
          '【本轮状态：发作】',
          '这一轮用你那套夸张的腔调说话（自称、文言、感叹号都行）。规矩：',
          '- 一句话为主，别整段念台词。',
          '- 最多带一个括号动作或颜文字，多了就假。',
          '- 不要解释你为什么这么说话，也不要提「中二」这两个字。',
        ].join('\n')
      : [
          '【本轮状态：正常】',
          '正常说话，别切换腔调，也别提你那套夸张的说法。',
        ].join('\n'),
  )

  lines.push(
    '现在轮到你了。',
    '- 想说话就调用 qq_send_message，一次一句。',
    `- 单条不超过 ${maxChars} 个字，超了会被从中间截断，很难看；一句说不完就分两条发。`,
    '- 想叫某个人就加 mention，填他名字后面括号里的 QQ 号。',
    '- 想引用某条消息就加 quote，填那个人的 QQ 号，会引用他最近一条消息。',
    proactive === undefined
      ? '- 不想说就什么都不做，直接结束这一轮。'
      : '- 这是你主动起的头：别问「在吗」「有人吗」，也别像播报；觉得没必要开口就什么都不做。',
    '- 这是真实群聊，发出去收不回来，不确定就别发。',
  )
  return lines.join('\n')
}
