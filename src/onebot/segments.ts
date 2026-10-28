import type { GroupMessage } from '../core/types.js'
import type { OneBotGroupMessageEvent, OneBotSegment } from './protocol.js'
import { isRecord } from './protocol.js'

/** NapCat 默认 `messagePostFormat=array`，但 string 模式也要能兜住。 */
export function toSegments(message: readonly OneBotSegment[] | string): OneBotSegment[] {
  if (typeof message === 'string') return parseCqString(message)
  return [...message]
}

const CQ_PATTERN = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]/g

function parseCqString(raw: string): OneBotSegment[] {
  const segments: OneBotSegment[] = []
  let cursor = 0
  for (const match of raw.matchAll(CQ_PATTERN)) {
    const index = match.index ?? 0
    if (index > cursor) {
      segments.push({ type: 'text', data: { text: raw.slice(cursor, index) } })
    }
    const type = match[1] ?? 'unknown'
    const data: Record<string, unknown> = {}
    for (const pair of (match[2] ?? '').split(',')) {
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      data[pair.slice(0, eq).trim()] = decodeCqValue(pair.slice(eq + 1))
    }
    segments.push({ type, data })
    cursor = index + match[0].length
  }
  if (cursor < raw.length) {
    segments.push({ type: 'text', data: { text: raw.slice(cursor) } })
  }
  return segments
}

function decodeCqValue(value: string): string {
  return value
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&')
}

/** 渲染成模型可读文本。@ 保留成 @QQ号，避免模型把昵称当成说话人。 */
export function renderSegmentText(segments: readonly OneBotSegment[], selfId: string): string {
  const parts: string[] = []
  for (const segment of segments) {
    switch (segment.type) {
      case 'text': {
        const text = typeof segment.data['text'] === 'string' ? segment.data['text'] : ''
        parts.push(text)
        break
      }
      case 'at': {
        const qq = String(segment.data['qq'] ?? '')
        parts.push(qq === selfId ? '@你' : `@${qq}`)
        break
      }
      case 'reply':
        break
      case 'image':
        parts.push('[图片]')
        break
      case 'face':
        parts.push('[表情]')
        break
      case 'record':
        parts.push('[语音]')
        break
      case 'file':
        parts.push('[文件]')
        break
      default:
        break
    }
  }
  return parts.join('').trim()
}

/** 收集消息里的图片地址：优先 url，其次 NapCat 给的 path/file 里的 http 地址。 */
export function collectImageUrls(segments: readonly OneBotSegment[]): string[] {
  const urls: string[] = []
  for (const segment of segments) {
    if (segment.type !== 'image') continue
    for (const key of ['url', 'path', 'file']) {
      const value = segment.data[key]
      if (typeof value === 'string' && /^https?:\/\//i.test(value) && !urls.includes(value)) {
        urls.push(value)
        break
      }
    }
  }
  return urls
}

export function collectAtIds(segments: readonly OneBotSegment[]): string[] {
  const ids: string[] = []
  for (const segment of segments) {
    if (segment.type === 'at') {
      const qq = String(segment.data['qq'] ?? '')
      if (qq !== '' && qq !== 'all') ids.push(qq)
    }
  }
  return ids
}

export function replyIdOf(segments: readonly OneBotSegment[]): string | undefined {
  for (const segment of segments) {
    if (segment.type === 'reply') {
      const id = segment.data['id']
      if (id !== undefined && id !== null && String(id) !== '') return String(id)
    }
  }
  return undefined
}

export interface NormalizeOptions {
  readonly selfId: string
  /** 判断某个 message_id 是不是自己发出去的。 */
  readonly isOurs: (messageId: string) => boolean
}

function isRecordEvent(value: unknown): value is OneBotGroupMessageEvent {
  return isRecord(value) && value['post_type'] === 'message' && value['message_type'] === 'group'
}

/**
 * 把 OneBot 事件归一化成 GroupMessage。
 * 不是群消息、字段缺失、结构不对，一律返回 undefined——宁可不处理，也不要抛。
 */
export function toGroupMessage(event: unknown, options: NormalizeOptions): GroupMessage | undefined {
  if (!isRecordEvent(event)) return undefined

  const eventSelfId = String(event.self_id ?? '')
  const selfId = options.selfId !== '' ? options.selfId : eventSelfId
  const userId = String(event.user_id ?? '')
  if (userId === '') return undefined

  const segments = toSegments(event.message ?? '')
  const text = renderSegmentText(segments, selfId)
  const atUserIds = collectAtIds(segments)
  const images = collectImageUrls(segments)
  const replyId = replyIdOf(segments)
  const sender = event.sender

  return {
    id: String(event.message_id ?? ''),
    groupId: String(event.group_id ?? ''),
    userId,
    nickname: sender?.card || sender?.nickname || userId,
    role: sender?.role ?? 'unknown',
    text,
    atSelf: selfId !== '' && atUserIds.includes(selfId),
    replyToSelf: replyId !== undefined && options.isOurs(replyId),
    atUserIds,
    images,
    at: typeof event.time === 'number' ? event.time * 1000 : Date.now(),
    self: selfId !== '' && userId === selfId,
  }
}
