import type { GroupMessage } from './types.js'

export interface Persona {
  readonly name: string
  readonly bio: string
  readonly interests: readonly string[]
  readonly speech: string
  /**
   * 偶尔发作的另一套腔调（比如中二病）。留空表示没有这个彩蛋。
   * 发作与否由插件每轮掷一次骰子决定，不交给模型自觉。
   */
  readonly flare?: string
  /** 每轮发作的概率，0–1。默认 0.2。 */
  readonly flareRate?: number
}

export const DEFAULT_PERSONA: Persona = {
  name: '小满',
  bio: '一个普通群友，话不多，偶尔冷不丁冒一句。',
  interests: [],
  speech: '短句、口语、不用书面语，偶尔只发一个表情。',
  flare: '',
  flareRate: 0.2,
}

export function renderPersona(persona: Persona): string {
  const lines = [`你的名字：${persona.name}`, `你的背景：${persona.bio}`]
  if (persona.interests.length > 0) {
    lines.push(`你感兴趣的话题：${persona.interests.join('、')}`)
  }
  lines.push(`你的说话风格：${persona.speech}`)

  const flare = persona.flare?.trim() ?? ''
  if (flare !== '') {
    lines.push(
      '',
      '你还有一种「发作」的说话方式：平时完全正常，偶尔会突然切换成下面这种腔调，',
      '说完就恢复，不解释、不预告。切换由系统决定，你只管照做：',
      flare,
    )
  }
  return lines.join('\n')
}

/** 这一轮是否发作。没有配置彩蛋时永远返回 false。 */
export function shouldFlare(persona: Persona, random: () => number = Math.random): boolean {
  if ((persona.flare?.trim() ?? '') === '') return false
  const rate = clamp01(persona.flareRate ?? 0.2)
  if (rate <= 0) return false
  return random() < rate
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** 时钟只取时:分，群聊语境里够用，且不会因为跨天而变长。 */
export function formatClock(at: number): string {
  const date = new Date(at)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/**
 * 把一批群消息渲染成模型能读的 transcript。
 * 自己发的消息标成「我」，这样模型不会把自己当成旁观者。
 */
export function renderTranscript(messages: readonly GroupMessage[]): string {
  return messages
    .map(message => {
      // 带上 QQ 号，模型才有办法 @ 某个人（它不认昵称，昵称会变）。
      const who = message.self ? '我' : `${message.nickname || message.userId}(${message.userId})`
      const prefix = message.atSelf ? '[@我] ' : ''
      return `[${formatClock(message.at)}] ${who}${prefix}: ${message.text}`
    })
    .join('\n')
}
