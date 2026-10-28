/**
 * 给浏览器界面用的三个 HTTP 路由。
 *
 * 只监听回环地址，且写操作会校验 Origin，挡掉跨站 POST。
 * 这里不碰任何密钥：只暴露人设、计数和决策记录。
 */
import type { IncomingMessage } from 'node:http'

import type { Context } from '@deepseek-ai/cordis'

import type { Persona } from '../core/persona.js'
import type { DecisionRecord } from '../core/recorder.js'
import type { Logger } from '../core/types.js'
import { errorMessage } from '../core/types.js'

export interface UiStats {
  readonly received: number
  readonly evaluated: number
  readonly spoken: number
  readonly skipped: number
}

export interface UiThrottle {
  readonly ok: boolean
  readonly reason?: string
  readonly sentLastHour: number
}

export interface UiSnapshot {
  readonly connected: boolean
  readonly selfId: string
  readonly groups: readonly string[]
  readonly stats: UiStats
  readonly throttle: Readonly<Record<string, UiThrottle>>
  readonly persona: Persona
  readonly behavior: Readonly<Record<string, string | number | boolean>>
  readonly decisions: readonly DecisionRecord[]
  readonly reasons: Readonly<Record<string, number>>
}

export interface SettingsPatch {
  readonly persona?: Persona
  readonly groups?: readonly string[]
  readonly rate?: { readonly maxPerHour?: number; readonly unlimited?: boolean }
  readonly proactive?: { readonly enabled?: boolean; readonly idleMinutes?: number; readonly maxPerDay?: number }
}

export interface UiOptions {
  readonly ctx: Context
  readonly snapshot: () => UiSnapshot
  readonly saveSettings: (patch: SettingsPatch) => Promise<void>
  readonly preview: (persona: Persona, forceFlare: boolean) => Promise<string[]>
  /** 环境自检：模型路由支持哪些输入模态。 */
  readonly diag: () => Promise<unknown>
  /** 把某个群的 agent 拉起来看状态（工具、初始化错误、上一轮输出）。 */
  readonly inspectAgent: (groupId: string) => Promise<unknown>
  readonly log: Logger
}


interface HttpResponseLike {
  writeHead(status: number, headers: Record<string, string>): unknown
  end(body?: string): unknown
}

const MAX_BODY_BYTES = 64 * 1024

export function registerUiRoutes(options: UiOptions): () => void {
  const server = (options.ctx as unknown as { webServer: WebServerLike }).webServer
  const origin = safeOrigin(server)
  const disposers = [
    server.register({
      kind: 'exact',
      path: '/qq/state',
      handler: (req: unknown, res: unknown) => handleState(req, res, options, origin),
    }),
    server.register({
      kind: 'exact',
      path: '/qq/settings',
      handler: (req: unknown, res: unknown) => handleSettings(req, res, options, origin),
    }),
    server.register({
      kind: 'exact',
      path: '/qq/preview',
      handler: (req: unknown, res: unknown) => handlePreview(req, res, options, origin),
    }),
    server.register({
      kind: 'exact',
      path: '/qq/diag',
      handler: (req: unknown, res: unknown) => handleDiag(req, res, options, origin),
    }),
    server.register({
      kind: 'exact',
      path: '/qq/diag/agent',
      handler: (req: unknown, res: unknown) => handleInspectAgent(req, res, options, origin),
    }),
  ]

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 插件卸载时路由可能已经随作用域消失，忽略。
      }
    }
  }
}

interface WebServerLike {
  getOrigin(): string
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => unknown }): () => void
}

function safeOrigin(server: WebServerLike): string {
  try {
    return server.getOrigin()
  } catch {
    return ''
  }
}

async function handleState(
  rawReq: unknown,
  rawRes: unknown,
  options: UiOptions,
  origin: string,
): Promise<void> {
  const req = rawReq as IncomingMessage
  const res = rawRes as HttpResponseLike
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method-not-allowed' })
  if (!sameOrigin(req, origin)) return sendJson(res, 403, { error: 'bad-origin' })

  try {
    sendJson(res, 200, options.snapshot())
  } catch (error) {
    options.log.warn(`[qq] 读取状态失败：${errorMessage(error)}`)
    sendJson(res, 500, { error: errorMessage(error) })
  }
}

async function handleSettings(
  rawReq: unknown,
  rawRes: unknown,
  options: UiOptions,
  origin: string,
): Promise<void> {
  const req = rawReq as IncomingMessage
  const res = rawRes as HttpResponseLike
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
  if (!sameOrigin(req, origin)) return sendJson(res, 403, { error: 'bad-origin' })

  const body = await readJson(req)
  if (body === undefined) return sendJson(res, 400, { error: 'empty-body' })

  const patch: {
    persona?: Persona
    groups?: readonly string[]
    rate?: { maxPerHour?: number; unlimited?: boolean }
    proactive?: { enabled?: boolean; idleMinutes?: number; maxPerDay?: number }
  } = {}

  if (body['persona'] !== undefined) {
    const persona = readPersona(body['persona'])
    if (!persona) return sendJson(res, 400, { error: 'invalid-persona' })
    patch.persona = persona
  }

  if (body['groups'] !== undefined) {
    const groups = readGroups(body['groups'])
    if (!groups) return sendJson(res, 400, { error: 'invalid-groups' })
    patch.groups = groups
  }

  if (body['rate'] !== undefined) {
    const rate = readRate(body['rate'])
    if (!rate) return sendJson(res, 400, { error: 'invalid-rate' })
    patch.rate = rate
  }

  if (body['proactive'] !== undefined) {
    const proactive = readProactive(body['proactive'])
    if (!proactive) return sendJson(res, 400, { error: 'invalid-proactive' })
    patch.proactive = proactive
  }

  if (
    patch.persona === undefined &&
    patch.groups === undefined &&
    patch.rate === undefined &&
    patch.proactive === undefined
  ) {
    return sendJson(res, 400, { error: 'nothing-to-save' })
  }

  try {
    await options.saveSettings(patch)
    sendJson(res, 200, { ok: true })
  } catch (error) {
    options.log.warn(`[qq] 保存设置失败：${errorMessage(error)}`)
    sendJson(res, 500, { error: errorMessage(error) })
  }
}

async function handlePreview(
  rawReq: unknown,
  rawRes: unknown,
  options: UiOptions,
  origin: string,
): Promise<void> {
  const req = rawReq as IncomingMessage
  const res = rawRes as HttpResponseLike
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
  if (!sameOrigin(req, origin)) return sendJson(res, 403, { error: 'bad-origin' })

  const body = await readJson(req)
  const persona = readPersona(body?.['persona'])
  if (!persona) return sendJson(res, 400, { error: 'invalid-persona' })

  try {
    const messages = await options.preview(persona, body?.['flare'] === true)
    sendJson(res, 200, { messages })
  } catch (error) {
    options.log.warn(`[qq] 试说失败：${errorMessage(error)}`)
    sendJson(res, 500, { error: errorMessage(error) })
  }
}

async function handleDiag(
  rawReq: unknown,
  rawRes: unknown,
  options: UiOptions,
  origin: string,
): Promise<void> {
  const req = rawReq as IncomingMessage
  const res = rawRes as HttpResponseLike
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method-not-allowed' })
  if (!sameOrigin(req, origin)) return sendJson(res, 403, { error: 'bad-origin' })
  try {
    sendJson(res, 200, await options.diag())
  } catch (error) {
    sendJson(res, 500, { error: errorMessage(error) })
  }
}

async function handleInspectAgent(
  rawReq: unknown,
  rawRes: unknown,
  options: UiOptions,
  origin: string,
): Promise<void> {
  const req = rawReq as IncomingMessage
  const res = rawRes as HttpResponseLike
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
  if (!sameOrigin(req, origin)) return sendJson(res, 403, { error: 'bad-origin' })

  const body = await readJson(req)
  const groupId = typeof body?.['groupId'] === 'string' ? body['groupId'].trim() : ''
  if (!/^\d{5,12}$/.test(groupId)) return sendJson(res, 400, { error: 'invalid-group' })

  try {
    sendJson(res, 200, await options.inspectAgent(groupId))
  } catch (error) {
    sendJson(res, 500, { error: errorMessage(error) })
  }
}

function sameOrigin(req: IncomingMessage, expected: string): boolean {
  if (expected === '') return true
  const raw = req.headers['origin']
  const value = Array.isArray(raw) ? raw[0] : raw
  // 同源 fetch 不一定会带 Origin；带了就必须等于本站。
  return value === undefined || value === expected
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function sendJson(res: HttpResponseLike, status: number, value: unknown): void {
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(value))
  } catch {
    // 响应可能已经结束（例如插件正在卸载），忽略。
  }
}

/** 界面提交的人设必须重新校验：这是唯一一条从浏览器进到配置的路径。 */
export function readPersona(input: unknown): Persona | undefined {
  if (input === null || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>

  const name = typeof record['name'] === 'string' ? record['name'].trim() : ''
  const bio = typeof record['bio'] === 'string' ? record['bio'].trim() : ''
  const speech = typeof record['speech'] === 'string' ? record['speech'].trim() : ''
  if (name === '' || [...name].length > 40) return undefined
  if ([...bio].length > 600 || [...speech].length > 200) return undefined

  const rawInterests = Array.isArray(record['interests']) ? record['interests'] : []
  const interests: string[] = []
  for (const item of rawInterests) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '' || interests.includes(trimmed)) continue
    interests.push(trimmed)
    if (interests.length >= 12) break
  }

  const flare = typeof record['flare'] === 'string' ? record['flare'].trim() : ''
  if ([...flare].length > 1200) return undefined

  const rawRate = record['flareRate']
  const parsedRate = typeof rawRate === 'number' ? rawRate : typeof rawRate === 'string' ? Number(rawRate) : Number.NaN
  const flareRate = Number.isFinite(parsedRate) ? Math.min(1, Math.max(0, parsedRate)) : 0.2

  return { name, bio, interests, speech, flare, flareRate }
}

/** 群号只接受 5–12 位纯数字，最多 20 个。 */
export function readGroups(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined
  const out: string[] = []
  for (const item of input) {
    const id = typeof item === 'number' ? String(item) : typeof item === 'string' ? item.trim() : ''
    if (id === '') continue
    if (!/^\d{5,12}$/.test(id)) return undefined
    if (!out.includes(id)) out.push(id)
    if (out.length > 20) return undefined
  }
  return out
}

export function readRate(input: unknown): { maxPerHour: number; unlimited: boolean } | undefined {
  if (input === null || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  const raw = record['maxPerHour']
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 240) return undefined
  return { maxPerHour: Math.floor(parsed), unlimited: record['unlimited'] === true }
}

/** 主动开口：冷场时长 30–1440 分钟，每日 0–20 次（0 = 只关掉次数限制但保留开关）。 */
export function readProactive(
  input: unknown,
): { enabled: boolean; idleMinutes: number; maxPerDay: number } | undefined {
  if (input === null || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>

  const idleRaw = record['idleMinutes']
  const idle = typeof idleRaw === 'number' ? idleRaw : typeof idleRaw === 'string' ? Number(idleRaw) : Number.NaN
  if (!Number.isFinite(idle) || idle < 30 || idle > 1440) return undefined

  const dayRaw = record['maxPerDay']
  const perDay = typeof dayRaw === 'number' ? dayRaw : typeof dayRaw === 'string' ? Number(dayRaw) : Number.NaN
  if (!Number.isFinite(perDay) || perDay < 0 || perDay > 20) return undefined

  return { enabled: record['enabled'] === true, idleMinutes: Math.floor(idle), maxPerDay: Math.floor(perDay) }
}

