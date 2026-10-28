/**
 * QQ 仿真群友 —— OneBot v11（NapCat）插件入口。
 *
 * apply 只做装配：不发请求、不 await、不读文件。
 * 所有副作用都挂在 ctx.effect 上，卸载时负责断开连接、取消定时器、释放 agent 会话。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { LlmRuntime, RequestMessage } from '@deepseek-ai/dsh-llm'

import { Config, normalizeGroupId } from './config.js'
import type { GroupmateConfig } from './config.js'
import { GroupBuffers } from './core/buffer.js'
import { WillingnessGate } from './core/gate.js'
import { SendLimiter } from './core/limiter.js'
import { MemberDirectory } from './core/members.js'
import type { Persona } from './core/persona.js'
import { RecentIds } from './core/recent-ids.js'
import type { DecisionRecord } from './core/recorder.js'
import { Recorder } from './core/recorder.js'
import { GroupmateRunner } from './core/runner.js'
import { LlmSpeaker } from './core/speaker.js'
import type { Speaker } from './core/speaker.js'
import type { CompletionRequest, GroupMessage, Logger, TextModel } from './core/types.js'
import { errorMessage } from './core/types.js'
import { AgentSpeaker } from './host/agent-speaker.js'
import { createFileLogger } from './host/file-logger.js'
import { MemberStore } from './host/member-store.js'
import { registerUiRoutes } from './host/ui.js'
import type { SettingsPatch } from './host/ui.js'
import { toGroupMessage, toGroupMessageFromHistory } from './onebot/segments.js'
import { WebSocketTransport } from './onebot/transport.js'

const BACKFILL_MESSAGES = 100
/** 档案里累计不到这么多条，就认为还不够像样，值得回灌一次。 */
const BACKFILL_MIN_MESSAGES = 30

export const name = 'qq-groupmate'
/** 没有 llm 服务时插件不激活，而不是抛错。 */
export const inject = ['llm']

export { Config }
export type { GroupmateConfig }

interface ModelRoute {
  readonly provider: string
  readonly model: string
}

export function apply(ctx: Context, config: GroupmateConfig): void {
  // 日志同时写 stdout 和 <会话目录>/logs 下的按天文件：
  // 桌面端的 stdout 用户看不到，出事只能靠猜。
  const log = createFileLogger('qq-groupmate', { dir: join(config.agent.cwd, 'logs'), keepDays: 7 })

  if (!config.enabled) {
    log.info('已在配置中停用')
    return
  }

  const speakerRoute = modelRoute(config.speaker.provider, config.speaker.model)
  if (!speakerRoute) {
    log.error('未配置 speaker.provider / speaker.model，插件不会启动')
    return
  }
  // 意愿判断默认复用发言模型；想更省钱可以单独指定一个更小的模型。
  const gateRoute = modelRoute(config.gate.provider, config.gate.model) ?? speakerRoute

  const allow = new Set(config.groups.allow.map(normalizeGroupId).filter(groupId => groupId !== ''))
  if (allow.size === 0) {
    log.warn('groups.allow 为空：插件会连上 NapCat，但不会在任何群里发言')
  }

  const persona: Persona = {
    name: config.persona.name,
    bio: config.persona.bio,
    interests: config.persona.interests,
    speech: config.persona.speech,
    flare: config.persona.flare,
    flareRate: config.persona.flareRate,
  }

  const recorder = new Recorder({ limit: 500, sink: createDecisionSink(config.agent.cwd, log) })

  // 群友档案：内存里滚，定期落盘。丢了顶多忘记谁是谁，不影响发言。
  const members = new MemberDirectory()
  const memberStore = new MemberStore(join(config.agent.cwd, 'groups'), log)
  const memberLoaded = new Set<string>()
  const memberDirty = new Set<string>()

  const observeMessage = (message: GroupMessage): void => {
    const groupId = message.groupId
    if (!memberLoaded.has(groupId)) {
      memberLoaded.add(groupId)
      void bootstrapMembers(groupId)
    }
    members.observe(message)
    memberDirty.add(groupId)
  }

  /**
   * 第一次见到某个群时把档案补起来：
   * 有存档就合并；没有就用群历史回灌，省得从零攒。
   */
  const bootstrapMembers = async (groupId: string): Promise<void> => {
    const normalize = (entry: unknown): GroupMessage | undefined =>
      toGroupMessageFromHistory(entry, {
        selfId: config.connection.selfId,
        isOurs: messageId => sent.has(messageId),
      })

    try {
      const saved = await memberStore.load(groupId)
      if (saved !== undefined) {
        members.load(groupId, saved)
        // 不是「有没有存档」，而是「档案够不够充实」——
        // 刚装插件时只见过一两条消息，那种档案回灌一次才像样。
        const total = members
          .profiles(groupId)
          .reduce((sum, profile) => sum + profile.messages, 0)
        if (total >= BACKFILL_MIN_MESSAGES) return
      }

      const history = await transport.fetchHistory(groupId, BACKFILL_MESSAGES)
      if (history.length === 0) return

      let used = 0
      for (const entry of history) {
        const message = normalize(entry)
        if (message === undefined) continue
        members.observe(message)
        used += 1
      }
      if (used === 0) return

      memberDirty.add(groupId)
      log.info(`[qq] 群 ${groupId} 的群友档案已用 ${used} 条历史回灌`)
    } catch (error) {
      log.warn(`[qq] 群 ${groupId} 档案回灌失败：${errorMessage(error)}`)
    }
  }

  const flushMembers = async (): Promise<void> => {
    const pending = [...memberDirty]
    memberDirty.clear()
    for (const groupId of pending) await memberStore.save(groupId, members.dump(groupId))
  }

  ctx.effect(() => {
    const timer = setInterval(() => {
      void flushMembers()
    }, 30_000)
    return async () => {
      clearInterval(timer)
      await flushMembers()
    }
  })

  // 界面上的历史列表要能跨重载存活，所以启动时把 JSONL 回灌进内存。
  ctx.effect(() => {
    void seedRecorder(recorder, config.agent.cwd, log)
    return () => undefined
  })

  const transport = new WebSocketTransport(
    {
      wsUrl: config.connection.wsUrl,
      accessToken: config.connection.tokenEnv === '' ? undefined : process.env[config.connection.tokenEnv],
      reconnectMinMs: config.connection.reconnectMinMs,
      reconnectMaxMs: config.connection.reconnectMaxMs,
      actionTimeoutMs: config.connection.actionTimeoutMs,
      heartbeatTimeoutMs: config.connection.heartbeatTimeoutMs,
    },
    log,
  )

  const buffers = new GroupBuffers({
    maxPerGroup: config.groups.maxPerGroup,
    maxGroups: config.groups.maxGroups,
  })

  const gate = new WillingnessGate(createTextModel(ctx.llm, gateRoute), persona, {
    threshold: config.gate.threshold,
    maxTokens: config.gate.maxTokens,
  })

  // 发送结果里的 message_id 要记下来，否则「回复我」永远识别不到。
  const sent = new RecentIds()
  const limiter = new SendLimiter(
    {
      sendGroup: async (groupId, message) => {
        const result = await transport.sendGroup(groupId, message)
        if (result.messageId !== undefined) sent.add(result.messageId)
        return result
      },
    },
    { rate: config.rate, log },
  )

  const kind: 'llm' | 'agent' = config.speaker.kind === 'llm' ? 'llm' : 'agent'

  let runnerRef: GroupmateRunner | undefined
  let agentSpeakerRef: AgentSpeaker | undefined

  const startRunner = (speaker: Speaker, ownerCtx: Context): void => {
    const runner = new GroupmateRunner({
      transport,
      buffers,
      gate,
      speaker,
      limiter,
      config: {
        allow,
        quietHours: config.groups.quietHours,
        windowMs: config.gate.windowMs,
        maxWindowMs: config.gate.maxWindowMs,
        contextSize: config.gate.contextSize,
        minMessages: config.gate.minMessages,
        proactive: {
          enabled: config.proactive.enabled,
          delayMs: config.proactive.delayMs,
          idleMinutes: config.proactive.idleMinutes,
          minGapMinutes: config.proactive.minGapMinutes,
          maxPerDay: config.proactive.maxPerDay,
          search: config.proactive.search,
        },
      },
      speakerKind: kind,
      recorder,
      log,
      normalize: event =>
        toGroupMessage(event, {
          selfId: config.connection.selfId,
          isOurs: messageId => sent.has(messageId),
        }),
      observe: observeMessage,
      onConnected: () => {
        // 连上就把每个群的档案准备好，不用等第一条消息。
        for (const groupId of allow) {
          if (memberLoaded.has(groupId)) continue
          memberLoaded.add(groupId)
          void bootstrapMembers(groupId)
        }
      },
    })

    // 唯一副作用入口：连接、定时器、在途评估都由这个 effect 持有。
    ownerCtx.effect(() => {
      const controller = new AbortController()
      runnerRef = runner
      const done = runner.start(controller.signal).catch(error => {
        if (!controller.signal.aborted) log.error(`事件泵异常退出：${errorMessage(error)}`)
      })

      log.info(`已启动（${kind} 后端），连接 ${config.connection.wsUrl}`)

      return async () => {
        controller.abort()
        await runner.stop()
        await done
        log.info('已停止')
      }
    })
  }

  // 浏览器界面：状态、人设、试说。缺 Web 服务器或配置编辑器时就不提供界面。
  ctx.inject(['webServer', 'configEditor'], injected => {
    injected.effect(() =>
      registerUiRoutes({
        ctx: injected,
        log,
        snapshot: () => {
          const status = runnerRef?.status()
          return {
            connected: status?.connected ?? false,
            selfId: config.connection.selfId,
            groups: [...allow],
            stats: {
              received: status?.received ?? 0,
              evaluated: status?.evaluated ?? 0,
              spoken: status?.spoken ?? 0,
              skipped: status?.skipped ?? 0,
            },
            throttle: Object.fromEntries(
              [...allow].map(groupId => [groupId, limiter.describe(groupId)]),
            ),
            persona,
            behavior: {
              kind,
              threshold: config.gate.threshold,
              minMessages: config.gate.minMessages,
              minGapMs: config.rate.minGapMs,
              maxPerHour: config.rate.maxPerHour,
              unlimited: config.rate.unlimited,
              quietHours: config.groups.quietHours,
              cwd: config.agent.cwd,
              proactiveEnabled: config.proactive.enabled,
              proactiveIdleMinutes: config.proactive.idleMinutes,
              proactiveMaxPerDay: config.proactive.maxPerDay,
              proactiveSearch: config.proactive.search,
            },
            decisions: recorder.recent(40),
            reasons: recorder.reasonHistogram(),
          }
        },
        saveSettings: next => saveSettings(injected, next),
        preview: (next, forceFlare) =>
          previewPersona(ctx.llm, speakerRoute, next, config.speaker.maxChars, forceFlare),
        diag: async () => ({
          ...(await describeModels(ctx.llm, { gate: gateRoute, speaker: speakerRoute })),
          agents: agentSpeakerRef?.debug() ?? [],
        }),
        inspectAgent: async groupId =>
          agentSpeakerRef === undefined
            ? { error: 'agent 后端未启用' }
            : agentSpeakerRef.inspect(groupId),
      }),
    )
  })

  if (kind === 'agent') {
    // agent 后端依赖这些 Host 服务；缺任何一个就退化成不启动，而不是让整行配置失效。
    ctx.inject(['agentLoop', 'tools', 'systemPrompt', 'attachments', 'agents'], injected => {
      const attachments = (injected as unknown as { attachments: AttachmentsLike }).attachments

      const speaker = new AgentSpeaker({
        ctx: injected,        persona,
        route: speakerRoute,
        cwd: config.agent.cwd,
        turnTimeoutMs: config.agent.turnTimeoutMs,
        ttlMs: config.agent.ttlMs,
        allowTools: config.agent.allowTools,
        maxChars: config.speaker.maxChars,
        log,
        deliver: (groupId, message, options, signal) =>
          limiter.enqueue(groupId, [message], { ...options, signal }),
        loadImages: (messages, signal) =>
          loadGroupImages(messages, config.speaker.maxImages, attachments, log, signal),
        memberSummary: groupId => members.summary(groupId),
      })

      agentSpeakerRef = speaker
      injected.effect(() => () => speaker.dispose())
      startRunner(speaker, injected)
    })
    return
  }

  startRunner(
    new LlmSpeaker(createTextModel(ctx.llm, speakerRoute), persona, {
      maxMessages: config.speaker.maxMessages,
      maxChars: config.speaker.maxChars,
      maxTokens: config.speaker.maxTokens,
    }),
    ctx,
  )
}

function modelRoute(provider: string, model: string): ModelRoute | undefined {
  if (provider.trim() === '' || model.trim() === '') return undefined
  return { provider: provider.trim(), model: model.trim() }
}

/** 环境自检：当前路由的模型声明了哪些输入模态（text / image）。 */
async function describeModels(
  llm: LlmRuntime,
  routes: Record<string, ModelRoute>,
): Promise<Record<string, unknown>> {
  const service = llm as unknown as {
    listProviders(): unknown
    resolveModelInfo(provider: string, model: string): Promise<Record<string, unknown>>
  }

  const out: Record<string, unknown> = {}
  try {
    out['providers'] = service.listProviders()
  } catch (error) {
    out['providers'] = { error: errorMessage(error) }
  }

  for (const [name, route] of Object.entries(routes)) {
    try {
      const info = await service.resolveModelInfo(route.provider, route.model)
      out[name] = {
        provider: route.provider,
        model: route.model,
        inputModalities: info['inputModalities'] ?? null,
        contextWindow: (info['context'] as Record<string, unknown> | undefined)?.['contextWindow'] ?? null,
      }
    } catch (error) {
      out[name] = { provider: route.provider, model: route.model, error: errorMessage(error) }
    }
  }
  return out
}

interface ConfigEditorLike {
  configuration(): Array<{
    entry: unknown
    inherited: Record<string, unknown>
    override: Record<string, unknown>
  }>
  edit(
    entry: unknown,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
}

/**
 * 把界面上的改动写回 profile 覆盖层。
 *
 * 必须先合并再改：覆盖层的 config 是整段替换的，只提交某一段会把
 * 其它字段（connection、gate、speaker…）一起抹掉。
 */
async function saveSettings(ctx: Context, patch: SettingsPatch): Promise<void> {
  const editor = (ctx as unknown as { configEditor: ConfigEditorLike }).configEditor

  let target: ReturnType<ConfigEditorLike['configuration']>[number] | undefined
  for (const row of editor.configuration()) {
    const id = (row.entry as { id?: unknown }).id
    if (id === 'include:qq-groupmate') {
      target = row
      break
    }
  }
  if (!target) throw new Error('找不到 qq-groupmate 的配置入口')

  await editor.edit(target.entry, (current, inherited) => {
    const next: Record<string, unknown> = { ...inherited, ...current }

    if (patch.persona !== undefined) {
      next['persona'] = {
        name: patch.persona.name,
        bio: patch.persona.bio,
        interests: [...patch.persona.interests],
        speech: patch.persona.speech,
        flare: patch.persona.flare ?? '',
        flareRate: patch.persona.flareRate ?? 0.2,
      }
    }

    if (patch.groups !== undefined) {
      const groups = asRecord(next['groups'])
      next['groups'] = { ...groups, allow: [...patch.groups] }
    }

    if (patch.rate !== undefined) {
      const rate = asRecord(next['rate'])
      next['rate'] = {
        ...rate,
        maxPerHour: patch.rate.maxPerHour ?? (typeof rate['maxPerHour'] === 'number' ? rate['maxPerHour'] : 8),
        unlimited: patch.rate.unlimited ?? rate['unlimited'] === true,
      }
    }

    if (patch.proactive !== undefined) {
      const proactive = asRecord(next['proactive'])
      next['proactive'] = {
        ...proactive,
        enabled: patch.proactive.enabled ?? proactive['enabled'] === true,
        idleMinutes:
          patch.proactive.idleMinutes ??
          (typeof proactive['idleMinutes'] === 'number' ? proactive['idleMinutes'] : 240),
        maxPerDay:
          patch.proactive.maxPerDay ??
          (typeof proactive['maxPerDay'] === 'number' ? proactive['maxPerDay'] : 1),
      }
    }

    return next
  })
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

interface AttachmentsLike {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<unknown>
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/**
 * 把这一轮群聊里的图片取下来，交给附件库换成模型能吃的 image block。
 *
 * 只取最近 maxImages 张、只认 http(s)、单张限 8MB——群里刷表情包时不能把上下文撑爆。
 */
async function loadGroupImages(
  messages: readonly GroupMessage[],
  maxImages: number,
  attachments: AttachmentsLike,
  log: Logger,
  signal: AbortSignal,
): Promise<unknown[]> {
  if (maxImages <= 0 || signal.aborted) return []

  const urls: string[] = []
  for (let index = messages.length - 1; index >= 0 && urls.length < maxImages; index -= 1) {
    const message = messages[index]
    for (const url of message?.images ?? []) {
      if (urls.length >= maxImages) break
      if (!urls.includes(url)) urls.push(url)
    }
  }

  const blocks: unknown[] = []
  for (const url of urls) {
    try {
      const image = await fetchImage(url, signal)
      if (image === undefined) continue
      const attachment = await attachments.saveImage({
        data: image.data,
        mediaType: image.mediaType,
        name: 'qq-image',
      })
      blocks.push({ type: 'image', attachment })
    } catch (error) {
      log.warn(`[qq] 图片处理失败：${errorMessage(error)}`)
    }
  }
  return blocks
}

async function fetchImage(
  url: string,
  signal: AbortSignal,
): Promise<{ data: Uint8Array; mediaType: string } | undefined> {
  const response = await fetch(url, { signal })
  if (!response.ok) return undefined
  const buffer = new Uint8Array(await response.arrayBuffer())
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) return undefined
  const mediaType = sniffMediaType(response.headers.get('content-type'), buffer)
  return mediaType === undefined ? undefined : { data: buffer, mediaType }
}

/** content-type 经常不可靠，兜底看文件头。 */
function sniffMediaType(declared: string | null, bytes: Uint8Array): string | undefined {
  const normal = (declared ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (normal === 'image/png' || normal === 'image/jpeg' || normal === 'image/webp' || normal === 'image/gif') {
    return normal
  }
  const [a, b, c, d] = [bytes[0], bytes[1], bytes[2], bytes[3]]
  if (a === 0x89 && b === 0x50 && c === 0x4e && d === 0x47) return 'image/png'
  if (a === 0xff && b === 0xd8) return 'image/jpeg'
  if (a === 0x47 && b === 0x49 && c === 0x46) return 'image/gif'
  if (a === 0x52 && b === 0x49 && c === 0x46 && d === 0x46) return 'image/webp'
  return undefined
}

/** 用草稿人设试说一句：不落库、不发群，纯粹给人看口气。 */
async function previewPersona(
  llm: LlmRuntime,
  route: ModelRoute,
  persona: Persona,
  maxChars: number,
  forceFlare = false,
): Promise<string[]> {
  const speaker = new LlmSpeaker(createTextModel(llm, route), persona, {
    maxMessages: 2,
    maxChars,
    maxTokens: 400,
    // 试说时把骰子钉死：勾了「强制发作」就一定发作，否则一定不发作。
    random: () => (forceFlare ? 0 : 1),
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const result = await speaker.compose(
      {
        messages: sampleConversation(),
        verdict: {
          participate: true,
          confidence: 0.8,
          intent: 'join',
          targets: [],
          delayMs: 0,
          style: 'short',
          reason: '群里在聊你感兴趣的话题',
          forced: false,
        },
      },
      controller.signal,
    )
    return [...result.texts]
  } finally {
    clearTimeout(timer)
  }
}

function sampleConversation(): GroupMessage[] {
  const now = Date.now()
  const base = { groupId: 'preview', role: 'member', atSelf: false, replyToSelf: false, atUserIds: [], self: false }
  return [
    { ...base, id: 'p1', userId: '1001', nickname: '张三', text: '这卡现在多少钱？', at: now - 60_000 },
    { ...base, id: 'p2', userId: '1002', nickname: '李四', text: '二手两千出头吧', at: now - 40_000 },
    { ...base, id: 'p3', userId: '1001', nickname: '张三', text: '那还行，我再看看', at: now - 20_000 },
  ]
}

/** 决策记录落到 workspace 目录下的 JSONL，可视化面板和调参都靠它。 */
function createDecisionSink(dir: string, log: Logger): (record: DecisionRecord) => void {
  let ready: Promise<unknown> | undefined
  return (record: DecisionRecord) => {
    const file = join(dir, 'decisions.jsonl')
    ready ??= mkdir(dir, { recursive: true })
    void ready
      .then(() => appendFile(file, `${JSON.stringify(record)}\n`, 'utf8'))
      .catch(error => log.warn(`[qq] 写决策日志失败：${errorMessage(error)}`))
  }
}

/** 启动时把历史决策回灌进内存，界面才不会每次重载都空白。 */
async function seedRecorder(recorder: Recorder, dir: string, log: Logger): Promise<void> {
  try {
    const text = await readFile(join(dir, 'decisions.jsonl'), 'utf8')
    const lines = text.split('\n').filter(line => line.trim() !== '').slice(-200)
    const records: DecisionRecord[] = []
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as DecisionRecord)
      } catch {
        // 跳过写了一半的坏行。
      }
    }
    recorder.seed(records)
  } catch {
    // 还没有历史文件，正常。
  }
  log.info('[qq] 决策记录已就绪')
}

/**
 * 把 ctx.llm 的流式接口收窄成一个「给系统提示 + 一轮用户输入 → 纯文本」的适配器。
 * 只累积 text-delta，任何 error/aborted finish 都变成异常，由上层决定是否丢弃这一轮。
 */
function createTextModel(llm: LlmRuntime, route: ModelRoute): TextModel {
  return {
    async complete(request: CompletionRequest): Promise<string> {
      const messages: RequestMessage[] = request.messages.map(turn => ({
        role: 'user',
        content: [{ type: 'text', text: turn.text }],
      }))

      let text = ''
      let failure: string | undefined

      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        system: request.system,
        messages,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        signal: request.signal,
      })) {
        if (chunk.type === 'text-delta') {
          text += chunk.text
        } else if (chunk.type === 'finish') {
          if (chunk.reason.kind === 'error') failure = chunk.reason.failure.message
          else if (chunk.reason.kind === 'aborted') failure = '模型调用被中断'
        }
      }

      if (failure !== undefined) throw new Error(failure)
      return text
    },
  }
}
