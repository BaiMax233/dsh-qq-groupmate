/**
 * 发送熔断器。
 *
 * 账号被风控前通常会先出现一串「发送确认超时」或真失败——
 * 这时候继续重试只会加速被封。熔断的做法很简单：
 * 短时间内连续出问题就整体闭嘴一段时间，冷却后自动恢复。
 */

export interface BreakerLog {
  warn(message: string, ...rest: unknown[]): void
  info(message: string, ...rest: unknown[]): void
}

export interface BreakerOptions {
  /** 连续几次真失败就熔断。 */
  readonly failureThreshold?: number
  /** 熔断持续多久。 */
  readonly cooldownMs?: number
  /** 风控信号的统计窗口。 */
  readonly riskWindowMs?: number
  /** 窗口内累计几次风控信号就熔断。 */
  readonly riskThreshold?: number
  readonly now?: () => number
  readonly log?: BreakerLog
}

export interface BreakerVerdict {
  readonly ok: boolean
  readonly reason?: string
}

export class CircuitBreaker {
  private failures = 0
  private risks: number[] = []
  private openUntil = 0
  private readonly now: () => number
  private readonly failureThreshold: number
  private readonly cooldownMs: number
  private readonly riskWindowMs: number
  private readonly riskThreshold: number

  constructor(private readonly options: BreakerOptions = {}) {
    this.now = options.now ?? Date.now
    this.failureThreshold = options.failureThreshold ?? 3
    this.cooldownMs = options.cooldownMs ?? 30 * 60_000
    this.riskWindowMs = options.riskWindowMs ?? 10 * 60_000
    this.riskThreshold = options.riskThreshold ?? 3
  }

  allow(): BreakerVerdict {
    const now = this.now()
    if (now >= this.openUntil) return { ok: true }
    const minutes = Math.max(1, Math.ceil((this.openUntil - now) / 60_000))
    return { ok: false, reason: `熔断中，还需 ${minutes} 分钟` }
  }

  /** 发送成功：连败计数清零，风控信号也清掉。 */
  recordSuccess(): void {
    this.failures = 0
    this.risks = []
  }

  /** 真失败（抛异常的那种）。 */
  recordFailure(reason: string): void {
    this.failures += 1
    if (this.failures < this.failureThreshold) return
    this.trip(`连续 ${this.failures} 次发送失败（${reason}）`)
  }

  /**
   * 风控信号：NapCat 报「发送确认超时」之类。
   * 单次不算数，窗口内连续出现才熔断——偶发一次不值得停半小时。
   */
  recordRisk(signal: string): void {
    const now = this.now()
    this.risks = this.risks.filter(at => now - at < this.riskWindowMs)
    this.risks.push(now)
    if (this.risks.length < this.riskThreshold) return
    this.trip(`窗口内 ${this.risks.length} 次风控信号（${signal}）`)
  }

  snapshot(): { open: boolean; until: number; failures: number; risks: number } {
    const now = this.now()
    return {
      open: now < this.openUntil,
      until: this.openUntil,
      failures: this.failures,
      risks: this.risks.filter(at => now - at < this.riskWindowMs).length,
    }
  }

  private trip(reason: string): void {
    this.openUntil = this.now() + this.cooldownMs
    this.failures = 0
    this.risks = []
    this.options.log?.warn(
      `[qq] 触发熔断：${reason}；${Math.round(this.cooldownMs / 60_000)} 分钟内不再发言`,
    )
  }
}
