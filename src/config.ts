import z from '@deepseek-ai/schemastery'

export interface ConnectionConfig {
  readonly wsUrl: string
  readonly tokenEnv: string
  readonly selfId: string
  readonly reconnectMinMs: number
  readonly reconnectMaxMs: number
  readonly actionTimeoutMs: number
  readonly heartbeatTimeoutMs: number
}

export interface GroupsConfig {
  /** YAML 里群号很容易写成数字，所以两种都接受，运行时统一转成字符串。 */
  readonly allow: readonly (string | number)[]
  readonly quietHours: string
  readonly maxPerGroup: number
  readonly maxGroups: number
}

export interface PersonaConfig {
  readonly name: string
  readonly bio: string
  readonly interests: readonly string[]
  readonly speech: string
  /** 偶尔发作的另一套腔调（中二等）。留空表示没有。 */
  readonly flare: string
  /** 每轮发作概率，0–1。 */
  readonly flareRate: number
}

export interface GateConfig {
  readonly provider: string
  readonly model: string
  readonly threshold: number
  readonly maxTokens: number
  readonly windowMs: number
  readonly maxWindowMs: number
  readonly contextSize: number
  readonly minMessages: number
}

export interface SpeakerConfig {
  /** 'agent' 走专属 Agent 会话（有记忆、能用工具）；'llm' 走一次性调用（快、便宜、无记忆）。 */
  readonly kind: string
  readonly provider: string
  readonly model: string
  readonly maxMessages: number
  readonly maxChars: number
  readonly maxTokens: number
  /** 每轮最多附几张图给模型看；0 表示完全不看图。 */
  readonly maxImages: number
}

export interface AgentConfig {
  /** 群会话的工作目录；也决定会话落盘在哪个目录桶里。 */
  readonly cwd: string
  /** 单次发言最长等待时间。 */
  readonly turnTimeoutMs: number
  /** 会话闲置多久后释放（只释放内存里的 agent，历史仍留在磁盘上）。 */
  readonly ttlMs: number
  /** 允许群友使用的全局工具白名单；留空表示什么工具都不给（除了发言本身）。 */
  readonly allowTools: readonly string[]
}

export interface RateConfig {
  readonly minGapMs: number
  readonly maxPerHour: number
  /** 勾选后不再限制每小时条数（冷却仍然生效）。 */
  readonly unlimited: boolean
}

export interface ProactiveConfig {
  readonly enabled: boolean
  /** 主动开口前的停顿（毫秒）。 */
  readonly delayMs: number
  /** 群里安静多久之后才允许主动开口。 */
  readonly idleMinutes: number
  /** 两次主动开口之间至少隔多久。 */
  readonly minGapMinutes: number
  /** 每个群每天最多主动开口几次。 */
  readonly maxPerDay: number
  /** 允许它先联网搜一下再开口。 */
  readonly search: boolean
}

export interface GroupmateConfig {
  readonly enabled: boolean
  readonly connection: ConnectionConfig
  readonly groups: GroupsConfig
  readonly persona: PersonaConfig
  readonly gate: GateConfig
  readonly speaker: SpeakerConfig
  readonly agent: AgentConfig
  readonly rate: RateConfig
  readonly proactive: ProactiveConfig
}

/** 配置里的群号允许写字符串或数字（YAML 里很容易写成数字）。 */
type GroupId = string | number

/**
 * 插件配置。全部可调项都在这里，用户的 cordis.patch.yml 覆盖层在升级后仍然有效。
 *
 * 所有字段都有默认值：缺省的一段配置会自动补全，不会因为少写一个字段就激活失败。
 */
export const Config = z.object({
  enabled: z.boolean().default(true).description('关闭后插件只注册不连接，便于临时停用。'),

  connection: z.object({
    wsUrl: z
      .string()
      .default('ws://127.0.0.1:3001')
      .description('NapCat 正向 WebSocket 地址（在 NapCat 里开启 WebSocket 服务器）。'),
    tokenEnv: z
      .string()
      .default('NAPCAT_TOKEN')
      .description('存放 access_token 的环境变量名。留空表示不使用 token。不要把 token 明文写进 patch。'),
    selfId: z.string().default('').description('机器人自己的 QQ 号。留空则用事件里的 self_id。'),
    reconnectMinMs: z.natural().default(800).description('重连退避下限（毫秒）。'),
    reconnectMaxMs: z.natural().default(30000).description('重连退避上限（毫秒）。'),
    actionTimeoutMs: z.natural().default(10000).description('单个 OneBot 动作的等待上限（毫秒）。'),
    heartbeatTimeoutMs: z
      .natural()
      .default(90000)
      .description('多久没收到任何事件就判定连接假死并重连（毫秒）。'),
  }),

  groups: z.object({
    allow: z
      .array(z.union([z.string(), z.natural()]))
      .default([])
      .description('允许参与的群号白名单。留空表示不参与任何群（防止误连后到处说话）。'),
    quietHours: z.string().default('23:30-07:30').description('静默时段，格式 HH:mm-HH:mm；留空表示全天可参与。'),
    maxPerGroup: z.natural().default(60).description('每个群保留的历史消息条数。'),
    maxGroups: z.natural().default(30).description('最多同时跟踪多少个群。'),
  }),

  persona: z.object({
    name: z.string().default('小满').description('群友昵称。'),
    bio: z.string().default('一个普通群友，话不多，偶尔冷不丁冒一句。').description('人设背景，会原样进入提示词。'),
    interests: z.array(z.string()).default([]).description('感兴趣的话题标签，用于判断参与意愿。'),
    speech: z.string().default('短句、口语、不用书面语，偶尔只发一个表情。').description('说话风格。'),
    flare: z
      .string()
      .default('')
      .description('偶尔发作的另一套腔调（比如中二病台词范例）。留空表示没有这个彩蛋。'),
    flareRate: z
      .number()
      .min(0)
      .max(1)
      .default(0.2)
      .description('每轮发作的概率，0–1。0.2 大约是每五次开口中二一次。'),
  }),

  gate: z.object({
    provider: z.string().default('').description('意愿判断用的模型路由。留空则复用 speaker 的配置。'),
    model: z.string().default('').description('意愿判断用的模型 id。留空则复用 speaker 的配置。'),
    threshold: z.number().min(0).max(1).default(0.55).description('置信度门槛，越高越沉默。'),
    maxTokens: z.natural().default(300).description('意愿判断的单次输出上限。'),
    windowMs: z.natural().default(2500).description('消息聚合窗口：收到一条消息后等这么久再判断。'),
    maxWindowMs: z.natural().default(8000).description('聚合窗口的硬上限，防止密集群永远不触发。'),
    contextSize: z.natural().default(30).description('送进模型的最近消息条数。'),
    minMessages: z
      .natural()
      .default(1)
      .description('一次判断至少要攒够几条新消息；调大能省 token，但反应会变慢。'),
  }),

  speaker: z.object({
    kind: z
      .string()
      .default('agent')
      .description("发言后端：'agent' 走专属 Agent 会话（有记忆、能调工具、慢）；'llm' 走一次性调用（快、便宜、无记忆）。"),
    provider: z.string().default('').description('生成发言的模型路由，例如 deepseek-official。'),
    model: z.string().default('').description('生成发言的模型 id。'),
    maxMessages: z.natural().default(2).description('一次最多连发几条。'),
    maxChars: z.natural().default(56).description('单条最大字数。中文一屏大约 56 字，再多就该分条。'),
    maxTokens: z.natural().default(400).description('生成发言的单次输出上限（仅 llm 后端）。'),
    maxImages: z
      .natural()
      .default(2)
      .description('每轮最多附几张群里的图给模型看。0 表示不看图，能省 token。'),
  }),

  agent: z.object({
    cwd: z.string().default('E:\\quit-code\\qq-groups').description('群会话的工作目录，也决定会话落在哪个目录桶。'),
    turnTimeoutMs: z.natural().default(60000).description('单次发言的最长等待时间，超时会取消这一轮。'),
    ttlMs: z.natural().default(1800000).description('会话闲置多久后释放内存里的 agent（历史仍保留在磁盘）。'),
    allowTools: z
      .array(z.string())
      .default(['web_search', 'web_fetch'])
      .description('允许群友使用的全局工具白名单。留空表示除了发言之外不给任何工具。'),
  }),

  rate: z.object({
    minGapMs: z.natural().default(15000).description('同一群两次发言的最小间隔（毫秒）。'),
    maxPerHour: z.natural().default(8).description('同一群每滚动一小时的发言上限。'),
    unlimited: z.boolean().default(false).description('勾选后不再限制每小时条数，只保留最小间隔。'),
  }),

  proactive: z.object({
    delayMs: z.natural().default(800).description('主动开口前的停顿（毫秒）。冷场时不必装作在打字，短一点即可。'),
    enabled: z
      .boolean()
      .default(false)
      .description('允许它在群里冷场时主动挑起话题。主动发言更像机器人，账号风控风险更高，默认关闭。'),
    idleMinutes: z.natural().default(180).description('群里安静多少分钟后才考虑主动开口。'),
    minGapMinutes: z.natural().default(240).description('两次主动开口之间至少间隔多少分钟。'),
    maxPerDay: z.natural().default(2).description('每个群每天最多主动开口几次。'),
    search: z.boolean().default(true).description('允许它先用 web_search 查点新鲜事再开口（仅 agent 后端有效）。'),
  }),
})

export function normalizeGroupId(value: GroupId): string {
  return String(value).trim()
}
