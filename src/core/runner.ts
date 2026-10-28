import type { EventTransport, GroupMessage, Logger } from './types.js'
import { errorMessage } from './types.js'
import type { GroupBuffers } from './buffer.js'
import type { Verdict, WillingnessGate } from './gate.js'
import type { Speaker } from './speaker.js'
import type { SendLimiter } from './limiter.js'
import type { Recorder } from './recorder.js'

export interface ProactiveSettings {
  readonly enabled: boolean
  /** 主动开口前的停顿：冷场时没必要装作在打字，短一点即可。 */
  readonly delayMs: number
  readonly idleMinutes: number
  readonly minGapMinutes: number
  readonly maxPerDay: number
  readonly search: boolean
}

export interface RunnerConfig {
  /** 空集合表示「不加白名单限制」，但默认应当配好。 */
  readonly allow: ReadonlySet<string>
  /** "23:30-07:30"，空串表示不静默。 */
  readonly quietHours: string
  readonly windowMs: number
  readonly maxWindowMs: number
  readonly contextSize: number
  /** 一次判断至少要有多少条「上次判断之后的新消息」，用来压掉无意义的小模型调用。 */
  readonly minMessages: number
  readonly proactive: ProactiveSettings
}

export interface RunnerDeps {
  readonly transport: EventTransport
  readonly buffers: GroupBuffers
  readonly gate: WillingnessGate
  readonly speaker: Speaker
  readonly limiter: SendLimiter
  readonly normalize: (event: unknown) => GroupMessage | undefined
  /** 每条被接受的消息都会喂给档案，用来记「谁在这个群、说过多少」。 */
  readonly observe?: (message: GroupMessage) => void
  readonly config: RunnerConfig
  readonly speakerKind: 'llm' | 'agent'
  readonly recorder?: Recorder
  readonly log: Logger
  readonly now?: () => number
}

export interface RunnerStatus {
  readonly connected: boolean
  readonly received: number
  readonly evaluated: number
  readonly spoken: number
  readonly skipped: number
  readonly groups: readonly string[]
}

interface QuietWindow {
  readonly start: number
  readonly end: number
}

/** 把 "23:30-07:30" 解析成分钟数区间，支持跨零点。 */
export function parseQuietHours(spec: string): QuietWindow | undefined {
  const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(spec.trim())
  if (!match) return undefined
  const start = Number(match[1]) * 60 + Number(match[2])
  const end = Number(match[3]) * 60 + Number(match[4])
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return undefined
  return { start, end }
}

export function isQuietAt(window: QuietWindow | undefined, at: number): boolean {  if (!window) return false
  const date = new Date(at)
  const minute = date.getHours() * 60 + date.getMinutes()
  // 跨零点：23:30-07:30 是 [start, 1440) ∪ [0, end)
  return window.start < window.end
    ? minute >= window.start && minute < window.end
    : minute >= window.start || minute < window.end
}

/**
 * 事件泵。
 *
 * 职责只有编排：归一化 → 入缓冲 → 窗口聚合 → 问意愿 → 请发言 → 交发送器。
 * 它不碰 LLM、不碰 WebSocket，因此可以用假传输完整测试。
 */
export class GroupmateRunner {
  private readonly windows = new Map<string, { firstAt: number; timer: ReturnType<typeof setTimeout> }>()
  private readonly inflight = new Map<string, AbortController>()
  /** 群号 → 叫过我的人的 QQ 号；只在被消费时才清除。 */
  private readonly mentions = new Map<string, string>()
  /** 群号 → 上次判断时看到的最后一条消息 id，用来数「新消息」。 */
  private readonly lastEvaluated = new Map<string, string>()
  /** 群号 → 最后一次有人说话的时间，用来判断「冷场」。 */
  private readonly lastActivity = new Map<string, number>()
  /** 群号 → 主动开口的冷却与当日计数。 */
  private readonly proactiveState = new Map<string, { lastAt: number; day: string; count: number }>()
  private ticker: ReturnType<typeof setInterval> | undefined
  private readonly quiet: QuietWindow | undefined
  private readonly now: () => number
  private state: 'idle' | 'running' | 'stopped' = 'idle'
  private linkConnected = false
  private readonly stats = { received: 0, evaluated: 0, spoken: 0, skipped: 0 }

  constructor(private readonly deps: RunnerDeps) {
    this.now = deps.now ?? Date.now
    this.quiet = parseQuietHours(deps.config.quietHours)
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.state !== 'idle') return
    this.state = 'running'
    if (this.deps.config.proactive.enabled) {
      // 一分钟看一眼就够：主动开口的粒度本来就是分钟级。
      this.ticker = setInterval(() => {
        this.tickProactive()
      }, 60_000)
      // 不让这个定时器单独把进程吊住（测试和退出时都能干净结束）。
      this.ticker.unref?.()
    }
    try {
      await this.deps.transport.start(
        {
          onEvent: event => this.onEvent(event),
          onState: state => this.onState(state),
        },
        signal,
      )
    } finally {
      this.state = 'stopped'
      this.clearTimers()
    }
  }

  async stop(): Promise<void> {
    this.state = 'stopped'
    this.clearTimers()
    for (const controller of this.inflight.values()) controller.abort()
    this.inflight.clear()
    await this.deps.transport.close()
  }

  status(): RunnerStatus {
    return {
      connected: this.linkConnected,
      received: this.stats.received,
      evaluated: this.stats.evaluated,
      spoken: this.stats.spoken,
      skipped: this.stats.skipped,
      groups: this.deps.buffers.trackedGroups,
    }
  }

  /**
   * 冷场检测：群里安静够久、且今天还没说够，就主动挑个话头。
   * 公开是为了让测试直接驱动，生产里由 start() 的定时器调用。
   */
  tickProactive(): void {
    if (this.state !== 'running') return
    const settings = this.deps.config.proactive
    if (!settings.enabled) return

    const now = this.now()
    if (isQuietAt(this.quiet, now)) return

    for (const groupId of this.deps.config.allow) {
      const lastAt = this.lastActivity.get(groupId)
      // 从来没见这个群说过话：不去打扰。
      if (lastAt === undefined) continue
      if (now - lastAt < settings.idleMinutes * 60_000) continue
      if (this.inflight.has(groupId)) continue
      if (this.windows.has(groupId)) continue
      if (this.deps.limiter.canSpeak(groupId).ok === false) continue

      const state = this.proactiveState.get(groupId)
      if (state !== undefined) {
        if (now - state.lastAt < settings.minGapMinutes * 60_000) continue
        if (state.day === dayKey(now) && state.count >= settings.maxPerDay) continue
      }

      this.markProactive(groupId, now)
      void this.runProactive(groupId, now)
    }
  }

  private markProactive(groupId: string, now: number): void {
    const day = dayKey(now)
    const state = this.proactiveState.get(groupId)
    if (state === undefined || state.day !== day) {
      this.proactiveState.set(groupId, { lastAt: now, day, count: 1 })
      return
    }
    state.lastAt = now
    state.count += 1
  }

  private async runProactive(groupId: string, startedAt: number): Promise<void> {
    const messages = this.deps.buffers.snapshot(groupId, this.deps.config.contextSize)
    if (messages.length === 0) return

    const last = messages[messages.length - 1]
    const preview = last ? `（主动开口，上次：${last.nickname}: ${last.text}）`.slice(0, 80) : '（主动开口）'
    const idleMinutes = Math.max(
      0,
      Math.round((startedAt - (this.lastActivity.get(groupId) ?? startedAt)) / 60_000),
    )

    const controller = new AbortController()
    this.inflight.set(groupId, controller)
    try {
      this.stats.evaluated += 1
      const verdict: Verdict = {
        participate: true,
        confidence: 1,
        intent: 'join',
        targets: [],
        delayMs: this.deps.config.proactive.delayMs,
        style: 'short',
        reason: '主动起个话头',
        forced: false,
      }
      const result = await this.deps.speaker.compose(
        {
          messages,
          verdict,
          proactive: { idleMinutes, searching: this.deps.config.proactive.search },
        },
        controller.signal,
      )
      if (result.texts.length === 0) {
        this.stats.skipped += 1
        this.deps.log.info(`[qq] 群 ${groupId} 冷场了，但它决定不开口`)
        this.record(groupId, preview, startedAt, {
          participate: false,
          confidence: 1,
          reason: 'proactive: 决定不开口',
          forced: false,
          texts: [],
        })
        return
      }
      if (!result.delivered) {
        await this.deps.limiter.enqueue(groupId, result.texts.map(text => ({ text })), {
          delayMs: verdict.delayMs,
          urgent: false,
          signal: controller.signal,
        })
      }
      this.stats.spoken += result.texts.length
      this.deps.log.info(`[qq] 群 ${groupId} 主动开口：${result.texts.join(' / ')}`)
      this.record(groupId, preview, startedAt, {
        participate: true,
        confidence: 1,
        reason: 'proactive: 主动起话头',
        forced: false,
        texts: result.texts,
      })
    } catch (error) {
      if (!controller.signal.aborted) {
        this.deps.log.error(`[qq] 群 ${groupId} 主动开口失败：${errorMessage(error)}`)
        this.record(groupId, preview, startedAt, {
          participate: false,
          confidence: 0,
          reason: 'proactive: error',
          forced: false,
          texts: [],
          error: errorMessage(error),
        })
      }
    } finally {
      if (this.inflight.get(groupId) === controller) this.inflight.delete(groupId)
    }
  }

  private onState(state: { connected: boolean; detail?: string }): void {
    this.linkConnected = state.connected
    if (state.connected) this.deps.log.info('[qq] OneBot 连接已建立')
    else this.deps.log.warn(`[qq] OneBot 连接断开${state.detail ? `：${state.detail}` : ''}`)
  }

  private onEvent(event: unknown): void {
    if (this.state !== 'running') return
    const message = this.deps.normalize(event)
    if (!message) return

    // 白名单：配了就只认这些群；没配就是「全部忽略」，防止误连后到处说话。
    if (!this.deps.config.allow.has(message.groupId)) return
    if (message.self) {
      // 自己的消息也要进缓冲，否则模型看不到自己刚才说过什么。
      this.deps.buffers.push(message)
      return
    }
    if (!this.deps.buffers.push(message)) return

    this.stats.received += 1
    this.deps.observe?.(message)
    this.lastActivity.set(message.groupId, this.now())

    if (isQuietAt(this.quiet, message.at) || this.quietAtNow()) {
      this.deps.log.info(`[qq] 静默时段，只记录不参与（群 ${message.groupId}）`)
      return
    }

    // 记住「有人在叫我」：哪怕窗口关闭前又有人插话，这个 @ 也不能丢。
    if (message.atSelf || message.replyToSelf) {
      this.mentions.set(message.groupId, message.userId)
    }

    this.schedule(message.groupId)
  }

  private quietAtNow(): boolean {
    // 用「现在」再判一次：消息可能刚好卡在静默开始的边界上。
    return isQuietAt(this.quiet, this.now())
  }

  private schedule(groupId: string): void {
    const now = this.now()
    const existing = this.windows.get(groupId)
    const firstAt = existing?.firstAt ?? now
    const deadline = Math.max(now, Math.min(firstAt + this.deps.config.maxWindowMs, now + this.deps.config.windowMs))

    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(
      () => {
        this.windows.delete(groupId)
        void this.evaluateGroup(groupId)
      },
      Math.max(0, deadline - now),
    )
    this.windows.set(groupId, { firstAt, timer })
  }

  private async evaluateGroup(groupId: string): Promise<void> {
    if (this.state !== 'running') return

    const messages = this.deps.buffers.snapshot(groupId, this.deps.config.contextSize)
    if (messages.length === 0) return

    const startedAt = this.now()
    const last = messages[messages.length - 1]
    if (!last) return
    const preview = `${last.nickname}: ${last.text}`.slice(0, 80)

    const forcedBy = this.mentions.get(groupId)
    const freshCount = countFresh(messages, this.lastEvaluated.get(groupId))
    if (forcedBy === undefined && freshCount < this.deps.config.minMessages) {
      this.deps.log.info(`[qq] 群 ${groupId} 只有 ${freshCount} 条新消息，先不判断`)
      return
    }
    this.lastEvaluated.set(groupId, last.id)

    // 被点名走优先通道：不受每小时配额限制，只保留一个很短的冷却。
    const urgent = forcedBy !== undefined
    const allowance = this.deps.limiter.canSpeak(groupId, urgent)
    if (!allowance.ok) {
      this.stats.skipped += 1
      this.deps.log.info(`[qq] 跳过群 ${groupId}：${allowance.reason ?? 'rate-limited'}`)
      this.record(groupId, preview, startedAt, {
        participate: false,
        confidence: 0,
        reason: `rate: ${allowance.reason ?? 'limited'}`,
        forced: urgent,
        texts: [],
      })
      return
    }

    // 新一轮消息到来时，上一轮评估必须作废，否则会对着过时的话题发言。
    this.inflight.get(groupId)?.abort()
    const controller = new AbortController()
    this.inflight.set(groupId, controller)

    try {
      this.stats.evaluated += 1
      const verdict = await this.deps.gate.evaluate(messages, controller.signal, forcedBy)
      if (forcedBy !== undefined) this.mentions.delete(groupId)
      if (!verdict.participate) {
        this.stats.skipped += 1
        this.deps.log.info(`[qq] 群 ${groupId} 不参与：${verdict.reason}`)
        this.record(groupId, preview, startedAt, {
          participate: false,
          confidence: verdict.confidence,
          reason: verdict.reason,
          forced: verdict.forced,
          texts: [],
          raw: verdict.raw,
        })
        return
      }

      const result = await this.deps.speaker.compose({ messages, verdict }, controller.signal)
      if (result.texts.length === 0) {
        this.stats.skipped += 1
        this.deps.log.info(`[qq] 群 ${groupId} 决定开口但没发出内容`)
        this.record(groupId, preview, startedAt, {
          participate: false,
          confidence: verdict.confidence,
          reason: `empty: ${verdict.reason}`,
          forced: verdict.forced,
          texts: [],
          raw: verdict.raw,
        })
        return
      }

      // Agent 后端已经在 turn 内通过工具发出去了，这里只补 limiter 之外的路径。
      if (!result.delivered) {
        await this.deps.limiter.enqueue(groupId, result.texts.map(text => ({ text })), {
          delayMs: verdict.delayMs,
          urgent: verdict.forced,
          signal: controller.signal,
        })
      }

      this.stats.spoken += result.texts.length
      this.deps.log.info(`[qq] 群 ${groupId} 发言（${verdict.reason}）：${result.texts.join(' / ')}`)
      this.record(groupId, preview, startedAt, {
        participate: true,
        confidence: verdict.confidence,
        reason: verdict.reason,
        forced: verdict.forced,
        texts: result.texts,
        raw: verdict.raw,
      })
    } catch (error) {
      if (!controller.signal.aborted) {
        this.deps.log.error(`[qq] 群 ${groupId} 处理失败：${errorMessage(error)}`)
        this.record(groupId, preview, startedAt, {
          participate: false,
          confidence: 0,
          reason: 'error',
          forced: false,
          texts: [],
          error: errorMessage(error),
        })
      }
    } finally {
      if (this.inflight.get(groupId) === controller) this.inflight.delete(groupId)
    }
  }

  private record(
    groupId: string,
    preview: string,
    startedAt: number,
    input: {
      participate: boolean
      confidence: number
      reason: string
      forced: boolean
      texts: readonly string[]
      error?: string
      raw?: string
    },
  ): void {
    this.deps.recorder?.record({
      groupId,
      preview,
      latencyMs: this.now() - startedAt,
      speaker: this.deps.speakerKind,
      ...input,
    })
  }

  private clearTimers(): void {
    for (const window of this.windows.values()) clearTimeout(window.timer)
    this.windows.clear()
    if (this.ticker !== undefined) clearInterval(this.ticker)
    this.ticker = undefined
  }
}

function dayKey(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

/** 数一下上次判断之后又来了几条新消息；找不到锚点就当全是新的。 */
function countFresh(messages: readonly GroupMessage[], previousId: string | undefined): number {
  if (previousId === undefined) return messages.length
  const index = messages.findIndex(message => message.id === previousId)
  return index < 0 ? messages.length : messages.length - index - 1
}
