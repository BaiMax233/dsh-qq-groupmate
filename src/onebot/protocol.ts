/**
 * OneBot v11 的消息与事件类型（只覆盖本插件用到的部分）。
 * 参考：https://github.com/botuniverse/onebot-11
 */

export interface TextSegment {
  readonly type: 'text'
  readonly data: { readonly text: string }
}

export interface AtSegment {
  readonly type: 'at'
  readonly data: { readonly qq: string | number; readonly name?: string }
}

export interface ReplySegment {
  readonly type: 'reply'
  readonly data: { readonly id: string | number }
}

export interface ImageSegment {
  readonly type: 'image'
  readonly data: Record<string, unknown>
}

export type OneBotSegment =
  | TextSegment
  | AtSegment
  | ReplySegment
  | ImageSegment
  | { readonly type: string; readonly data: Record<string, unknown> }

export interface OneBotSender {
  readonly user_id?: number | string
  readonly nickname?: string
  readonly card?: string
  readonly role?: string
}

export interface OneBotGroupMessageEvent {
  readonly post_type: 'message'
  readonly message_type: 'group'
  readonly sub_type?: string
  readonly self_id: number | string
  readonly message_id: number | string
  readonly group_id: number | string
  readonly user_id: number | string
  readonly time: number
  readonly message: readonly OneBotSegment[] | string
  readonly raw_message?: string
  readonly sender?: OneBotSender
}

export interface OneBotMetaEvent {
  readonly post_type: 'meta_event'
  readonly meta_event_type: 'lifecycle' | 'heartbeat'
  readonly self_id: number | string
  readonly time: number
  readonly status?: Record<string, unknown>
  readonly interval?: number
}

export interface OneBotActionResponse<T = unknown> {
  readonly status: 'ok' | 'failed' | 'async'
  readonly retcode: number
  readonly data?: T
  readonly echo?: string | number
  readonly wording?: string
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
