import type {
  CompletionRequest,
  EventTransport,
  LinkState,
  OutgoingMessage,
  SendResult,
  TextModel,
  TransportHandlers,
} from '../src/core/types.js'

/** 内存传输层：不发网络，只记录发出去的消息，并允许手动灌事件。 */
export class FakeTransport implements EventTransport {
  readonly sent: Array<{ groupId: string; message: OutgoingMessage }> = []
  private handlers: TransportHandlers | undefined
  private stop: (() => void) | undefined
  private sequence = 0

  async start(handlers: TransportHandlers, signal: AbortSignal): Promise<void> {
    this.handlers = handlers
    handlers.onState({ connected: true })
    await new Promise<void>(resolve => {
      this.stop = resolve
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
  }

  emit(event: unknown): void {
    this.handlers?.onEvent(event)
  }

  async sendGroup(groupId: string, message: OutgoingMessage): Promise<SendResult> {
    this.sent.push({ groupId, message })
    this.sequence += 1
    return { messageId: `fake-${this.sequence}` }
  }

  async close(): Promise<void> {
    this.stop?.()
  }

  state(): LinkState {
    return { connected: true }
  }
}

/** 假模型：按提示词里的标记分流，返回固定 JSON。 */
export class FakeModel implements TextModel {
  readonly calls: CompletionRequest[] = []

  constructor(private readonly reply: (request: CompletionRequest) => string | Promise<string>) {}

  async complete(request: CompletionRequest): Promise<string> {
    this.calls.push(request)
    return this.reply(request)
  }
}

export interface FakeMessageInput {
  readonly messageId?: string
  readonly groupId?: string
  readonly userId?: string
  readonly nickname?: string
  readonly text?: string
  readonly atSelf?: boolean
  readonly selfId?: string
}

/** 造一个 OneBot v11 群消息事件。 */
export function groupEvent(input: FakeMessageInput = {}): unknown {
  const selfId = input.selfId ?? '10000'
  const messageId = input.messageId ?? `m-${Math.random().toString(36).slice(2, 8)}`
  const segments: unknown[] = []
  if (input.atSelf) segments.push({ type: 'at', data: { qq: selfId } })
  segments.push({ type: 'text', data: { text: input.text ?? '今天吃什么' } })

  return {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    self_id: selfId,
    message_id: messageId,
    group_id: input.groupId ?? '123456',
    user_id: input.userId ?? '20001',
    time: Math.floor(Date.now() / 1000),
    message: segments,
    sender: { user_id: input.userId ?? '20001', nickname: input.nickname ?? '张三', role: 'member' },
  }
}
