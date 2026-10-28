import type { GroupMessage, TextModel } from './types.js'
import type { Persona } from './persona.js'
import { renderPersona, renderTranscript } from './persona.js'
import { asBoolean, asNumber, asString, asStringArray, clamp, extractJsonObject } from './json.js'

export type SpeakIntent = 'reply' | 'join' | 'ignore'
export type SpeakStyle = 'short' | 'emoji' | 'question'

export interface Verdict {
  readonly participate: boolean
  readonly confidence: number
  readonly intent: SpeakIntent
  readonly targets: readonly string[]
  /** 拟人化延迟，由模型给，代码只夹紧上下限。 */
  readonly delayMs: number
  readonly style: SpeakStyle
  readonly reason: string
  /** true 表示被 @ / 被回复，跳过了打分。 */
  readonly forced: boolean
  /** 判断失败时的模型原始输出（截断），只用于回溯。 */
  readonly raw?: string
}

export interface GateOptions {
  readonly threshold: number
  readonly maxTokens: number
}

const IGNORE_REASONS = new Set(['empty', 'aborted', 'gate-unparsable', 'gate-error'])

function ignore(reason: string, confidence = 0): Verdict {
  return {
    participate: false,
    confidence,
    intent: 'ignore',
    targets: [],
    delayMs: 0,
    style: 'short',
    reason,
    forced: false,
  }
}

/**
 * 第一级：规则（0 token）；第二级：小模型打分。
 *
 * 规则层只做「值得花 token 吗」的判断，真正的语义判断交给模型。
 * 被 @ 或被回复时直接放行——这种情况下再问一次模型只会增加延迟。
 */
export class WillingnessGate {
  constructor(
    private readonly model: TextModel,
    private readonly persona: Persona,
    private readonly options: GateOptions,
  ) {}

  async evaluate(messages: readonly GroupMessage[], signal: AbortSignal, forcedBy?: string): Promise<Verdict> {
    if (messages.length === 0) return ignore('empty')

    // 窗口里出现过 @我 / 回复我，就会被 runner 以 forcedBy 叫到这里，哪怕后面又有人插话。
    if (forcedBy !== undefined) {
      return {
        participate: true,
        confidence: 1,
        intent: 'reply',
        targets: [forcedBy],
        delayMs: 500 + Math.round(Math.random() * 900),
        style: 'short',
        reason: '被点名或被回复',
        forced: true,
      }
    }

    const last = messages[messages.length - 1]
    if (last && (last.atSelf || last.replyToSelf)) {
      return {
        participate: true,
        confidence: 1,
        intent: 'reply',
        targets: [last.userId],
        delayMs: 500 + Math.round(Math.random() * 900),
        style: 'short',
        reason: '被点名或被回复',
        forced: true,
      }
    }

    if (signal.aborted) return ignore('aborted')

    const system = [
      '【参与判断】你在判断自己要不要在一个 QQ 群里开口说话。',
      renderPersona(this.persona),
      '',
      '判断原则：',
      '1. 偏向沉默，但不是一味沉默：能接的话、感兴趣的话题、有人抛出开放问题时，可以主动搭一句。',
      '2. 群里有人正在一对一互相对话时，不要硬插。',
      '3. 纯表情、复读、刷屏、广告一律不参与；别人发了图，如果你有话说可以接。',
      '4. 不要当和事佬，不要总结别人的话，不要每句都接。',
      '5. 用 confidence 表达你有多确定该开口；只是礼貌性附和就给低分。',
      '',
      '只输出一个 JSON 对象，不要输出解释、不要用 markdown。字段：',
      '{"participate": true|false, "confidence": 0.0-1.0, "intent": "reply"|"join"|"ignore",',
      ' "targets": ["要回应的群友QQ号"], "delayMs": 400-5000, "style": "short"|"emoji"|"question",',
      ' "reason": "一句话说明"}',
    ].join('\n')

    const user = [
      `这是一个 QQ 群（群号 ${last?.groupId ?? 'unknown'}）。下面是最近的消息，按时间顺序：`,
      '---',
      renderTranscript(messages),
      '---',
      '现在你要不要开口？只输出 JSON。',
    ].join('\n')

    let parsed: Record<string, unknown> | undefined
    let lastRaw = ''
    // 小模型偶尔吐不出合法 JSON；给它一次机会，第二次用零温度和更硬的约束。
    for (let attempt = 0; attempt < 2 && parsed === undefined; attempt += 1) {
      const text = attempt === 0 ? user : `${user}\n只输出 JSON，不要任何解释、不要代码围栏。`
      try {
        lastRaw = await this.model.complete({
          system,
          messages: [{ role: 'user', text }],
          temperature: attempt === 0 ? 0.2 : 0,
          maxTokens: this.options.maxTokens,
          signal,
        })
      } catch (error) {
        if (signal.aborted) return ignore('aborted')
        // 模型挂了也别直接装死：用规则顶一轮，并把失败原因留在记录里。
        return { ...this.ruleFallback(messages), raw: `error: ${normalizeError(error)}` }
      }
      parsed = extractJsonObject(lastRaw)
    }

    if (!parsed) {
      // 绝不把模型的原始输出当发言发出去，但也不能白丢一次机会：
      // 用确定性规则兜底，并把原文截断存进记录，方便回溯它到底吐了什么。
      return { ...this.ruleFallback(messages), raw: lastRaw.slice(0, 600) }
    }

    const confidence = clamp(asNumber(parsed['confidence'], 0), 0, 1)
    const intentRaw = asString(parsed['intent'], 'ignore')
    const intent: SpeakIntent =
      intentRaw === 'reply' || intentRaw === 'join' || intentRaw === 'ignore' ? intentRaw : 'ignore'
    const styleRaw = asString(parsed['style'], 'short')
    const style: SpeakStyle =
      styleRaw === 'short' || styleRaw === 'emoji' || styleRaw === 'question' ? styleRaw : 'short'

    const participate =
      asBoolean(parsed['participate'], false) && intent !== 'ignore' && confidence >= this.options.threshold

    if (!participate) {
      return ignore(asString(parsed['reason'], 'below-threshold'), confidence)
    }

    return {
      participate: true,
      confidence,
      intent,
      targets: asStringArray(parsed['targets']),
      delayMs: clamp(Math.round(asNumber(parsed['delayMs'], 1200)), 400, 5000),
      style,
      reason: asString(parsed['reason'], 'wants-to-join'),
      forced: false,
    }
  }

  /**
   * 模型判断不可用时的确定性兜底。
   *
   * 只认两个强信号：叫了我的名字、或者最后一句是个问句。
   * 其余一律沉默——宁可少说，也不能在模型抽风时乱说话。
   */
  private ruleFallback(messages: readonly GroupMessage[]): Verdict {
    const last = messages[messages.length - 1]
    const text = last?.text.trim() ?? ''
    const name = this.persona.name.trim()
    const length = [...text].length

    if (length <= 2) return ignore('rule:too-short')

    const delayMs = 1500 + Math.round(Math.random() * 2500)

    if (name !== '' && text.includes(name)) {
      return {
        participate: true,
        confidence: 0.8,
        intent: 'reply',
        targets: last ? [last.userId] : [],
        delayMs,
        style: 'short',
        reason: 'rule:name',
        forced: false,
      }
    }

    if (/[?？]\s*$/.test(text)) {
      return {
        participate: true,
        confidence: 0.65,
        intent: 'join',
        targets: [],
        delayMs,
        style: 'question',
        reason: 'rule:question',
        forced: false,
      }
    }

    return ignore('rule:no-signal')
  }
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isQuietReason(reason: string): boolean {
  return IGNORE_REASONS.has(reason)
}
