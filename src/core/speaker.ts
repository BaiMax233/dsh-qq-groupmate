import type { GroupMessage, TextModel } from './types.js'
import type { Persona } from './persona.js'
import { renderPersona, renderTranscript, shouldFlare } from './persona.js'
import type { Verdict } from './gate.js'
import { extractJsonObject } from './json.js'

export interface SpeakInput {
  readonly messages: readonly GroupMessage[]
  readonly verdict: Verdict
  /** 主动开口时的额外信息；不填表示这是被动回应。 */
  readonly proactive?: {
    readonly idleMinutes: number
    readonly searching: boolean
  }
}

export interface SpeakResult {
  readonly texts: readonly string[]
  /**
   * true 表示消息已经在 compose 内部送达（Agent 通过 qq_send_message 工具直接发），
   * runner 不要再发第二次。
   */
  readonly delivered: boolean
}

export interface Speaker {
  compose(input: SpeakInput, signal: AbortSignal): Promise<SpeakResult>
  dispose?(): Promise<void>
}

export interface SpeakerOptions {
  readonly maxMessages: number
  readonly maxChars: number
  readonly maxTokens: number
  /** 掷骰子的随机源，测试可替换。 */
  readonly random?: () => number
}

/**
 * 只保留文本、去掉 markdown、压成一行。
 * 群聊里出现 `**` 或 `- ` 会立刻暴露「这是 AI 生成的」。
 */
export function sanitizeLine(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`>#]+/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** 按码点截断，避免把 emoji 或中文切成半个。 */
export function truncateChars(input: string, maxChars: number): string {
  const points = [...input]
  if (points.length <= maxChars) return input
  return points.slice(0, maxChars).join('')
}

/**
 * 群聊用的截断：超长时优先断在句读上，而不是从字中间砍。
 *
 * "…能有多大造行？本座弹指可" 这种半句话比短句难看得多，
 * 所以先找句号问号，再找逗号，实在没有才截断加省略号。
 */
export function truncateForChat(input: string, maxChars: number): string {
  const points = [...input]
  if (maxChars <= 0 || points.length <= maxChars) return input

  const head = points.slice(0, maxChars)
  const floor = Math.max(0, Math.floor(maxChars * 0.55))

  for (const marks of ['。！？!?…', '；;，,、']) {
    for (let index = head.length - 1; index >= floor; index -= 1) {
      const char = head[index]
      if (char !== undefined && marks.includes(char)) return head.slice(0, index + 1).join('')
    }
  }

  // 一个标点都没有：留一个字给省略号，至少看起来是「话说完了」。
  return `${head.slice(0, Math.max(1, maxChars - 1)).join('')}…`
}

export function sanitizeMessages(raw: unknown, options: SpeakerOptions): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const line = truncateChars(sanitizeLine(item), options.maxChars)
    if (line === '' || seen.has(line)) continue
    seen.add(line)
    out.push(line)
    if (out.length >= options.maxMessages) break
  }
  return out
}

export class LlmSpeaker implements Speaker {
  constructor(
    private readonly model: TextModel,
    private readonly persona: Persona,
    private readonly options: SpeakerOptions,
  ) {}

  async compose(input: SpeakInput, signal: AbortSignal): Promise<SpeakResult> {
    const styleHint: Record<string, string> = {
      short: '一句话，短。',
      emoji: '很短，可以只用表情或语气词。',
      question: '用一句反问或追问，别像采访。',
    }

    const flare = shouldFlare(this.persona, this.options.random)
    const proactive = input.proactive

    const system = [
      '【发言生成】你在以一个普通群友的身份在 QQ 群里说话，不是助手。',
      renderPersona(this.persona),
      '',
      flare
        ? '【本轮状态：发作】这一轮用你那套夸张的腔调说话，可以带最多一个括号动作或颜文字，但别整段念台词，也别解释。'
        : '【本轮状态：正常】正常说话，别切换腔调。',
      '',
      '硬性要求：',
      `1. 只输出一个 JSON 对象：{"messages": ["第一条", "..."]}，不要输出别的。`,
      `2. 最多 ${this.options.maxMessages} 条，每条不超过 ${this.options.maxChars} 个字。`,
      '3. 像真人打字：短句、口语、可以有语气词和口头禅。',
      flare
        ? '4. 禁止 markdown、列表；括号动作和颜文字最多一个。'
        : '4. 禁止 markdown、列表、括号里的动作描写、颜文字堆砌。',
      '5. 禁止说「作为 AI」「我理解」「希望对你有帮助」这类话。',
      '6. 不要复述对方原话，不要总结，不要每句都接。',
      '7. 不确定就别硬接，可以只回一个很短的反应。',
      proactive === undefined ? '' : '8. 这是你主动起的头，不是回应某个人；别用「在吗」这类开场。',
    ]
      .filter(line => line !== '')
      .join('\n')

    const user = [
      proactive === undefined ? (styleHint[input.verdict.style] ?? '') : '',
      proactive === undefined
        ? '最近的群聊：'
        : `群里已经安静了 ${proactive.idleMinutes} 分钟。最后几条是：`,
      '---',
      renderTranscript(input.messages),
      '---',
      proactive === undefined
        ? `你决定开口的原因：${input.verdict.reason}`
        : '这次没人叫你，是你自己想说话：接着上面的话题问一句进展，或者抛一个大家会想聊的新鲜事。不要问「在吗」「有人吗」。',
      input.verdict.targets.length > 0 ? `你主要想回应：${input.verdict.targets.join(', ')}` : '',
      '现在写你要发的话，只输出 JSON。',
    ]
      .filter(line => line !== '')
      .join('\n')

    const raw = await this.model.complete({
      system,
      messages: [{ role: 'user', text: user }],
      temperature: 0.9,
      maxTokens: this.options.maxTokens,
      signal,
    })

    const parsed = extractJsonObject(raw)
    if (!parsed) return { texts: [], delivered: false }
    return { texts: sanitizeMessages(parsed['messages'], this.options), delivered: false }
  }
}
