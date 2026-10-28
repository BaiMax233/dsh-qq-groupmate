import type {
  EventTransport,
  LinkState,
  OutgoingMessage,
  SendResult,
  TransportHandlers,
} from '../core/types.js'
import type { OneBotActionResponse } from './protocol.js'
import { isRecord } from './protocol.js'
import { sleep } from '../core/timing.js'

export interface WebSocketTransportOptions {
  readonly wsUrl: string
  readonly accessToken?: string
  /** 重连退避下限。 */
  readonly reconnectMinMs: number
  /** 重连退避上限。 */
  readonly reconnectMaxMs: number
  /** 单个动作的等待上限。 */
  readonly actionTimeoutMs: number
  /** 多久没收到任何事件就认为连接假死。 */
  readonly heartbeatTimeoutMs: number
}

interface PendingCall {
  readonly resolve: (value: OneBotActionResponse) => void
  readonly reject: (error: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * OneBot v11 正向 WebSocket 客户端。
 *
 * 设计取舍：
 * - 用查询参数传 access_token（OneBot v11 标准做法），不依赖 undici 的 headers 扩展；
 * - 每个动作带 echo 关联响应，超时即失败，绝不让发送卡死；
 * - 心跳看「有没有收到任何事件」，而不是只看 onclose——半开连接太常见。
 */
export class WebSocketTransport implements EventTransport {
  private socket: WebSocket | undefined
  private handlers: TransportHandlers | undefined
  private readonly pending = new Map<string, PendingCall>()
  private readonly echoPrefix = `qqgm-${Math.random().toString(36).slice(2, 8)}`
  private sequence = 0
  private lastEventAt = 0
  private watchdog: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly options: WebSocketTransportOptions,
    private readonly log: { info(message: string): void; warn(message: string): void },
  ) {}

  async start(handlers: TransportHandlers, signal: AbortSignal): Promise<void> {
    this.handlers = handlers
    let attempt = 0

    while (!signal.aborted) {
      const opened = await this.connectOnce(signal)
      if (signal.aborted) break

      attempt = opened ? 0 : Math.min(attempt + 1, 6)
      const backoff = Math.min(this.options.reconnectMaxMs, this.options.reconnectMinMs * 2 ** attempt)
      const wait = backoff + Math.round(Math.random() * 250)
      this.log.warn(`[qq] ${Math.round(wait)}ms 后重连 OneBot`)
      try {
        await sleep(wait, signal)
      } catch {
        break
      }
    }

    this.shutdown()
  }

  state(): LinkState {
    return { connected: this.socket?.readyState === WebSocket.OPEN }
  }

  async close(): Promise<void> {
    this.shutdown()
  }

  async sendGroup(groupId: string, message: OutgoingMessage): Promise<SendResult> {
    const response = await this.call(
      'send_group_msg',
      { group_id: numericId(groupId), message: toSegmentPayload(message) },
      this.options.actionTimeoutMs,
    )

    if (response.retcode !== 0) {
      const detail = String(response.wording ?? response.status)

      // 1200 = NapCat 的 EventChecker 超时：消息通常已经送出去了，只是确认事件没回来。
      // 把它当失败会导致「明明发出去了却记成没发」，所以只告警、不抛错。
      if (response.retcode === 1200 || detail.includes('EventChecker')) {
        this.log.warn(`[qq] 发送确认超时（retcode=${response.retcode}），按已送达处理`)
        return {}
      }

      throw new Error(`send_group_msg 失败（retcode=${response.retcode} ${detail}）`)
    }

    const data = isRecord(response.data) ? response.data : undefined
    const rawId = data?.['message_id']
    return rawId === undefined || rawId === null ? {} : { messageId: String(rawId) }
  }

  /** 连接一次，返回它是否成功建立过；无论如何都在 socket 关闭时 resolve。 */
  private connectOnce(signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      let socket: WebSocket
      try {
        socket = new WebSocket(this.buildUrl())
      } catch (error) {
        this.log.warn(`[qq] 无法创建 WebSocket：${error instanceof Error ? error.message : String(error)}`)
        resolve(false)
        return
      }

      this.socket = socket
      this.lastEventAt = Date.now()
      let opened = false

      const onAbort = (): void => {
        try {
          socket.close()
        } catch {
          // 已经关了，忽略。
        }
      }

      socket.addEventListener('open', () => {
        opened = true
        this.lastEventAt = Date.now()
        this.startWatchdog()
        this.handlers?.onState({ connected: true })
      })

      socket.addEventListener('message', event => {
        this.onFrame(event.data)
      })

      socket.addEventListener('error', () => {
        // close 事件随后一定到达，这里不重复处理。
      })

      socket.addEventListener('close', () => {
        signal.removeEventListener('abort', onAbort)
        this.stopWatchdog()
        this.failPending(new Error('OneBot 连接已关闭'))
        if (this.socket === socket) this.socket = undefined
        this.handlers?.onState({ connected: false, detail: 'socket closed' })
        resolve(opened)
      })

      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private onFrame(raw: unknown): void {
    if (typeof raw !== 'string') return
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (!isRecord(parsed)) return

    this.lastEventAt = Date.now()

    const echo = parsed['echo']
    if (typeof echo === 'string') {
      const pending = this.pending.get(echo)
      if (pending) {
        this.pending.delete(echo)
        clearTimeout(pending.timer)
        pending.resolve(parsed as unknown as OneBotActionResponse)
        return
      }
    }

    this.handlers?.onEvent(parsed)
  }

  private call(method: string, params: unknown, timeoutMs: number): Promise<OneBotActionResponse> {
    return new Promise<OneBotActionResponse>((resolve, reject) => {
      const socket = this.socket
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error('OneBot 连接未就绪'))
        return
      }

      const echo = `${this.echoPrefix}-${++this.sequence}`
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`OneBot 动作超时：${method}`))
      }, timeoutMs)

      this.pending.set(echo, { resolve, reject, timer })

      try {
        socket.send(JSON.stringify({ action: method, params, echo }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(echo)
        reject(error)
      }
    })
  }

  private startWatchdog(): void {
    this.stopWatchdog()
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastEventAt <= this.options.heartbeatTimeoutMs) return
      this.log.warn('[qq] OneBot 心跳超时，主动断开重连')
      try {
        this.socket?.close()
      } catch {
        // 忽略
      }
    }, 5000)
  }

  private stopWatchdog(): void {
    if (this.watchdog !== undefined) clearInterval(this.watchdog)
    this.watchdog = undefined
  }

  private failPending(error: Error): void {
    for (const [echo, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(echo)
    }
  }

  private shutdown(): void {
    this.stopWatchdog()
    this.failPending(new Error('OneBot 传输层已关闭'))
    const socket = this.socket
    this.socket = undefined
    if (!socket) return
    try {
      socket.close()
    } catch {
      // 忽略
    }
  }

  private buildUrl(): string {
    const url = new URL(this.options.wsUrl)
    if (this.options.accessToken) url.searchParams.set('access_token', this.options.accessToken)
    return url.toString()
  }
}

function numericId(value: string): number | string {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : value
}

interface OutgoingSegment {
  readonly type: string
  readonly data: Record<string, unknown>
}

/**
 * 纯文本走字符串（兼容性最好），需要 @ 或引用时才升级成消息段数组。
 * @ 之后补一个空格，否则 QQ 里会显示成「@某人内容」黏在一起。
 */
export function toSegmentPayload(message: OutgoingMessage): string | OutgoingSegment[] {
  const segments: OutgoingSegment[] = []
  if (message.replyTo !== undefined && message.replyTo !== '') {
    segments.push({ type: 'reply', data: { id: message.replyTo } })
  }
  if (message.mention !== undefined && message.mention !== '') {
    segments.push({ type: 'at', data: { qq: message.mention } })
    segments.push({ type: 'text', data: { text: ` ${message.text}` } })
  } else {
    segments.push({ type: 'text', data: { text: message.text } })
  }

  if (segments.length === 1 && message.replyTo === undefined) return message.text
  return segments
}
