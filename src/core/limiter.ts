import { sleep } from './timing.js'
import type { OutgoingMessage } from './types.js'

export interface RateOptions {
  /** 同一群两次发言的最小间隔。 */
  readonly minGapMs: number
  /** 滚动一小时内最多发几条。 */
  readonly maxPerHour: number
  /** 勾选后不再按小时计数（最小间隔仍然生效）。 */
  readonly unlimited?: boolean
}

export interface Allowance {
  readonly ok: boolean
  readonly reason?: string
}

export interface SendLimiterOptions {
  readonly rate: RateOptions
  readonly now?: () => number
  readonly log?: { info(message: string): void }
  /** 同一批里两条消息之间的间隔，默认按字数估算。测试可注入 0。 */
  readonly gap?: (previousText: string) => number
}

/**
 * 发送闸门 + 串行队列。
 *
 * 两件事必须由它独家负责：
 * 1. 频控/配额判断（决定要不要为一条消息花 token 去评估）；
 * 2. 真正的发送顺序——OneBot 侧是串行的，并发发多条会被 QQ 判成刷屏。
 */
export class SendLimiter {
  private readonly state = new Map<string, { lastAt: number; times: number[]; chain: Promise<void> }>()
  private readonly now: () => number

  constructor(
    private readonly sender: { sendGroup(groupId: string, message: OutgoingMessage): Promise<unknown> },
    private readonly options: SendLimiterOptions,
  ) {
    this.now = options.now ?? Date.now
  }

  /**
   * @param urgent 被直接点名。点名不走每小时配额（否则一忙起来就「叫不动」），
   *               但保留一个更短的冷却，避免连珠炮式回应。
   */
  canSpeak(groupId: string, urgent = false): Allowance {
    const state = this.stateFor(groupId)
    const now = this.now()
    const windowStart = now - 60 * 60 * 1000

    const gap = urgent ? Math.min(this.options.rate.minGapMs, 3_000) : this.options.rate.minGapMs
    if (state.lastAt > 0 && now - state.lastAt < gap) {
      const wait = gap - (now - state.lastAt)
      return { ok: false, reason: `冷却中，还需 ${Math.ceil(wait / 1000)}s` }
    }

    if (urgent) return { ok: true }
    if (this.options.rate.unlimited === true) return { ok: true }

    const recent = state.times.filter(time => time > windowStart)
    if (recent.length >= this.options.rate.maxPerHour) {
      return { ok: false, reason: `本小时配额已用完（${recent.length}/${this.options.rate.maxPerHour}）` }
    }
    return { ok: true }
  }

  /** 当前这个群被限流到什么程度，给界面显示用。 */
  describe(groupId: string): Allowance & { sentLastHour: number } {
    const state = this.stateFor(groupId)
    const windowStart = this.now() - 60 * 60 * 1000
    const sentLastHour = state.times.filter(time => time > windowStart).length
    return { ...this.canSpeak(groupId), sentLastHour }
  }

  /**
   * 入队并串行发送。
   *
   * 一次「发言」可以包含多条消息，它们属于同一口气：
   * - 闸门只在开头判一次，否则第二条会被最小间隔挡掉（旧实现就是这么丢消息的）；
   * - 条与条之间按上一条的长度算打字时间，像真人补了一句。
   */
  enqueue(
    groupId: string,
    messages: readonly OutgoingMessage[],
    options: { delayMs: number; urgent?: boolean; signal?: AbortSignal } = { delayMs: 0 },
  ): Promise<void> {
    const { delayMs, urgent = false, signal } = options
    const state = this.stateFor(groupId)
    const run = async (): Promise<void> => {
      if (delayMs > 0) await sleep(delayMs, signal)

      const allowance = this.canSpeak(groupId, urgent)
      if (!allowance.ok) {
        this.options.log?.info(`[qq] 放弃发送：${allowance.reason ?? 'unknown'}`)
        return
      }

      let previous = ''
      for (let index = 0; index < messages.length; index += 1) {
        if (signal?.aborted) return
        const message = messages[index]
        if (message === undefined) continue
        if (index > 0) await sleep(this.options.gap?.(previous) ?? typingGap(previous), signal)

        await this.sender.sendGroup(groupId, message)
        previous = message.text

        const at = this.now()
        state.times.push(at)
        const windowStart = at - 60 * 60 * 1000
        state.times = state.times.filter(time => time > windowStart)
      }

      // 整批说完才算「这一次开口结束」，冷却从这里开始计。
      state.lastAt = this.now()
    }

    const next = state.chain.then(run, run)
    // 队列本身不能因为一次失败就断掉，失败交给调用方那一条链去观察。
    state.chain = next.catch(() => undefined)
    return next
  }

  private stateFor(groupId: string): { lastAt: number; times: number[]; chain: Promise<void> } {
    let state = this.state.get(groupId)
    if (!state) {
      state = { lastAt: 0, times: [], chain: Promise.resolve() }
      this.state.set(groupId, state)
    }
    return state
  }
}

/**
 * 两条消息之间的「打字时间」：按上一条的字数估算，再加一点抖动。
 * 短句 0.7–1 秒，长句中文化 30–40ms/字，上限 4 秒。
 */
export function typingGap(previousText: string, random: () => number = Math.random): number {
  const chars = [...previousText].length
  const base = 700 + chars * 35
  const jitter = Math.round(random() * 400)
  return Math.min(4000, base + jitter)
}
