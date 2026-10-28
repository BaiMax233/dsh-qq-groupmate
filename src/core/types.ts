/**
 * 领域原语。这一层不导入任何 Host 包，因此可以脱离 DSH 单独运行、单独测试。
 */

/** 已经归一化的一条群消息。 */
export interface GroupMessage {
  /** OneBot message_id，用于去重。 */
  readonly id: string
  readonly groupId: string
  readonly userId: string
  /** 群名片优先，其次昵称。 */
  readonly nickname: string
  /** owner / admin / member，未知时为 unknown。 */
  readonly role: string
  /** 渲染后的可读文本：@某人 变成 @昵称，图片变成 [图片]。 */
  readonly text: string
  readonly atSelf: boolean
  readonly replyToSelf: boolean
  readonly atUserIds: readonly string[]
  /** 这张消息里的图片地址（http/https），留给多模态输入用。 */
  readonly images?: readonly string[]
  /** 毫秒时间戳。 */
  readonly at: number
  readonly self: boolean
}

/** 送进模型的一轮对话。目前只用到 user 轮，system 单独给。 */
export interface ChatTurn {
  readonly role: 'user'
  readonly text: string
}

export interface CompletionRequest {
  readonly system: string
  readonly messages: readonly ChatTurn[]
  readonly temperature?: number
  readonly maxTokens?: number
  readonly signal?: AbortSignal
}

/** 对 `ctx.llm` 的最小窄接口，方便用假模型做离线测试，也方便 A→B 换后端。 */
export interface TextModel {
  complete(request: CompletionRequest): Promise<string>
}

export interface SendResult {
  readonly messageId?: string
}

/** 一条要发出去的消息：纯文本，或带 @ / 引用。 */
export interface OutgoingMessage {
  readonly text: string
  /** 要 @ 的 QQ 号。 */
  readonly mention?: string
  /** 要引用回复的 message_id。 */
  readonly replyTo?: string
}

export interface MessageSender {
  sendGroup(groupId: string, message: OutgoingMessage): Promise<SendResult>
}

export interface LinkState {
  readonly connected: boolean
  readonly detail?: string
}

export interface TransportHandlers {
  /** OneBot 原始事件，由 upper layer 负责归一化。 */
  onEvent(event: unknown): void
  onState(state: LinkState): void
}

/**
 * 传输层窄接口：只要求「能起来、能收事件、能发一条群消息」。
 * 真实现是 WebSocket，测试实现是一个内存假连接。
 */
export interface EventTransport extends MessageSender {
  start(handlers: TransportHandlers, signal: AbortSignal): Promise<void>
  close(): Promise<void>
  state(): LinkState
}

export interface Logger {
  info(message: string, ...rest: unknown[]): void
  warn(message: string, ...rest: unknown[]): void
  error(message: string, ...rest: unknown[]): void
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}
