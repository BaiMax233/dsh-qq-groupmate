import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { truncateForChat } from '../core/speaker.js'

export interface OutgoingDraft {
  readonly text: string
  /** 要 @ 的 QQ 号。 */
  readonly mention?: string
  /** 要引用回复的 QQ 号：引用对方最近一条消息。 */
  readonly quote?: string
}

export interface SendToolOptions {
  readonly groupId: string
  readonly maxChars: number
  /** 真正投递；由外层注入，保证频控和去重不被绕过。 */
  readonly send: (draft: OutgoingDraft, signal: AbortSignal) => Promise<void>
}

/**
 * 群友唯一的「动作」。
 *
 * 刻意做成工具而不是解析模型的最终文本：发给群里的东西必须是模型显式的动作，
 * 这样它在会话里可回放、可审计，也不会把思考过程当成发言发出去。
 */
export function createSendMessageTool(options: SendToolOptions): ToolDefinition {
  return {
    name: 'qq_send_message',
    description:
      '在当前 QQ 群里发一条消息。想说话就调用它；不想说话就不要调用，直接结束这一轮。发出去就收不回来。',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '要发到群里的内容。一句话，口语，不要 markdown、不要列表。',
        },
        mention: {
          type: 'string',
          description: '要 @ 的人的 QQ 号（transcript 里名字后面括号中的数字）。只有在确实要叫他时才用。',
        },
        quote: {
          type: 'string',
          description: '要引用回复的人的 QQ 号；会引用他在这个群里最近一条消息。',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sent: { type: 'boolean' },
          chars: { type: 'integer' },
        },
        required: ['sent'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const sent =
          typeof value === 'object' && value !== null && (value as Record<string, unknown>)['sent'] === true
        return [{ type: 'text', text: sent ? '已发送到群' : '未发送' }]
      },
    },
    async execute(args, exec) {
      const record = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
      const rawText = record['text']
      const text = typeof rawText === 'string' ? rawText.trim() : ''
      if (text === '') return { sent: false }

      // 超长时断在句读上，不要从字中间切出半句话。
      const capped = truncateForChat(text, options.maxChars)
      await options.send(
        { text: capped, mention: qqOf(record['mention']), quote: qqOf(record['quote']) },
        exec.signal,
      )
      return { sent: true, chars: [...capped].length }
    },
  }
}

/** 只接受纯数字 QQ 号；模型编出来的东西一律丢掉。 */
function qqOf(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/^@/, '')
  return /^\d{5,12}$/.test(trimmed) ? trimmed : undefined
}
