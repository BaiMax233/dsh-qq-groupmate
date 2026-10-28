# qq-groupmate

DeepSeek Harness 的 Host 插件：通过 OneBot v11（NapCat）以「仿真群友」的身份在指定 QQ 群里活动。

它不是客服机器人——它看群聊、判断要不要插话、然后像个群友一样说话，并且记得住人和事。

## 它怎么工作

```
群消息 ──▶ 聚合窗口（2.5s，最长 8s）
              │
              ├─ 频控：冷却中 / 配额用完？ → 跳过（不花 token）
              │
              ├─ 意愿判断（gate）
              │    ├─ 被 @ / 被回复 → 强制参与
              │    ├─ 规则预筛（太短、纯表情）
              │    └─ 小模型打分：participate / confidence / reason
              │         失败时用确定性规则兜底（问句、叫名字）
              │
              └─ 发言后端（agent / llm）
                     ├─ 掷骰子决定这轮是否「发作」（人设彩蛋）
                     ├─ 打字延迟 → 发第一条 → 停顿 → 发第二条
                     └─ 全程受发送闸门约束（冷却、配额、分钟定时）
```

两种发言后端，用 `speaker.kind` 切换：

| | `agent`（默认） | `llm` |
|---|---|---|
| 发言 | 每群一个持久 Agent 会话，通过 `qq_send_message` 工具发 | 一次性 completion，直接吐 JSON |
| 记忆 | 会话日志持久化，重启仍在，自动压缩 | 只有内存里最近 N 条，重启即忘 |
| 工具 | `qq_send_message` + 白名单里的查询类工具 | 无 |
| 看图 | 支持（把图存进附件库，作为 image block 喂给模型） | 不支持 |
| 延迟 | 5–20 秒（可能多步） | 1–3 秒 |
| 成本 | 高 | 低 |

## 前置条件

1. **NapCat 里开一个正向 WebSocket 服务器**（默认 `ws://127.0.0.1:3001`）。
2. 机器人账号**已经加入目标群**（不然收不到任何事件）。
3. DSH 里配好可用的模型路由。

插件只处理**群消息**。私聊、以及它不在的群，一律收不到。

## 在设置页里操作

`设置 → QQ 群友`：

| 区域 | 能干什么 |
|---|---|
| 状态条 | 连接状态、今日发言/评估数；被限流时顶部会有橙色横幅 |
| 群聊 | 添加/删除群号（5–12 位数字，最多 20 个），留空 = 哪个群都不参与 |
| 人设 | 名字、背景、兴趣标签、语气 |
| 偶尔发作 | 另一套腔调的台词示例 + 发作概率（0–1） |
| 试一句 | 用当前草稿生成示例，不发群；可勾「强制发作」看彩蛋版本 |
| 发言配额 | 每群每小时上限，「不限制」可关闭小时配额 |
| 其它参数 | 只读；阈值、冷却、目录等 |
| 最近的判断 | 最近 40 次决策，倒序，含原因与耗时 |

保存后写回 profile 的 `cordis.patch.yml` 并热重载（连接会闪断 1–2 秒，会话记忆不丢）。

## 配置

见 `cordis.patch.yml`。关键项：

| 字段 | 说明 |
|---|---|
| `enabled` | 总开关 |
| `connection.wsUrl` | NapCat 的正向 WebSocket 地址 |
| `connection.tokenEnv` | 放 access_token 的**环境变量名**，不要把 token 明文写进 patch |
| `groups.allow` | 群号白名单。留空 = 不参与任何群（防误连） |
| `groups.quietHours` | 静默时段，支持跨零点，例如 `01:00-08:00` |
| `persona.*` | 名字 / 背景 / 兴趣 / 语气 |
| `persona.flare` | 偶尔发作的台词示例；留空表示没有这个彩蛋 |
| `persona.flareRate` | 每轮发作概率，默认 0.2 |
| `speaker.kind` | `agent` 或 `llm` |
| `speaker.maxChars` | 单条字数上限，默认 56；超长会断在标点上 |
| `speaker.maxImages` | 每轮最多附几张图给模型，0 = 不看图 |
| `agent.cwd` | 群会话的工作目录，也决定会话落盘目录 |
| `agent.allowTools` | 群友能用的全局工具白名单，留空则只有发言 |
| `agent.turnTimeoutMs` | 单次发言最长等待，超时会取消这一轮 |
| `gate.threshold` | 置信度门槛，越高越沉默 |
| `gate.minMessages` | 至少攒够几条新消息才判断；调大省 token，反应变慢 |
| `rate.maxPerHour` | 每群每小时的发言上限 |
| `rate.unlimited` | 勾选后不限条数（冷却仍然生效） |
| `rate.minGapMs` | 同一群两次「开口」的最小间隔 |

**被 @ 时永远不受 `maxPerHour` 限制**，只保留 3 秒冷却——不然一忙起来就「叫不动」。

模型路由必须配 `speaker.provider` / `speaker.model`，否则插件不会启动；`gate.*` 留空则复用 speaker 的。

## 数据落在哪

```
E:\quit-code\qq-groups\
├─ decisions.jsonl          每次判断一行（含失败时的模型原文）
├─ logs\YYYY-MM-DD.log      滚动日志，保留 7 天
└─ groups\<群号>.members.json   群友档案（QQ 号、昵称、发言数）
```

会话日志在 `~/.dsh/sessions/--E-quit-code-qq-groups--/` 下，由 DSH 管理。

群友档案里存的是**群友的 QQ 号、昵称和发言数**，只在本机，不会上传。要清就直接删那个目录。

## 结构

```
src/
├─ index.ts              apply / Config / 后端选择 / 路由 / 日志
├─ config.ts             schemastery 配置
├─ core/                 纯逻辑，不 import 任何 Host 包
│  ├─ types.ts           领域类型 + Transport/Model 窄接口
│  ├─ buffer.ts          每群滚动窗口 + message_id 去重
│  ├─ gate.ts            参与意愿：规则短路 → 小模型打分 → 规则兜底
│  ├─ speaker.ts         Speaker 接口 + 一次性调用实现 + 清洗/截断
│  ├─ recorder.ts        结构化决策记录（环形缓冲 + JSONL sink）
│  ├─ members.ts         群友档案：统计 + 摘要渲染
│  ├─ limiter.ts         冷却/配额 + 串行发送队列 + 打字间隔
│  ├─ runner.ts          事件泵：窗口聚合 → 决策 → 发送
│  ├─ persona.ts         人设渲染 / 发作骰子 / transcript 渲染
│  ├─ json.ts            模型输出容错解析
│  ├─ recent-ids.ts      自己发过的 message_id
│  └─ timing.ts          可中断 sleep
├─ host/                 依赖 Host 服务的实现
│  ├─ agent-speaker.ts   每群一个 Agent 会话 + 懒创建 + 闲置回收 + 借用活会话
│  ├─ tool.ts            qq_send_message 工具定义
│  ├─ ui.ts              /qq/state /qq/settings /qq/preview /qq/diag
│  ├─ file-logger.ts     按天滚动的文件日志
│  └─ member-store.ts    群友档案落盘
├─ onebot/
│  ├─ protocol.ts        OneBot v11 事件类型
│  ├─ segments.ts        消息段 ⇄ 文本、CQ 码兜底、事件归一化
│  └─ transport.ts       正向 WebSocket 客户端（重连 + 心跳 + echo 关联）
└─ client.js             设置页（浏览器端，纯 JS）

locale/  icon.svg  cordis.patch.yml  package.json
```

`core/` 不依赖 DSH，所以整条决策链路可以离线测试；`host/` 里的 Agent 行为用假 `agentLoop` 覆盖。

## 开发

```bash
npm install
npm run typecheck
npm test          # tsc + 逐文件跑（不用 node --test，避免子进程）
```

需要 **Node ≥ 22**（构建脚本和调试脚本会用到全局 `WebSocket`）。如果你的 `node` 被 nvm 切到 20，`npm test` 仍能跑，但临时脚本会挂。

测试覆盖：buffer / segments / gate / config / agent-speaker / limiter / ui-validate / file-logger / persona / text-truncate / members / runner，全部离线。

## 排障

| 症状 | 先看这里 |
|---|---|
| @ 了不回 | 设置页顶部有没有橙色限流横幅；`decisions.jsonl` 最后一行的 `reason` |
| 完全不说话 | 群号在 `groups.allow` 里吗？NapCat 的 `get_group_list` 里还有这个群吗？ |
| 日志里一堆 `empty:` | gate 说要说、但 agent 拒绝了；看 `latencyMs`：很短是它决定不说，接近 60s 是超时 |
| `retcode 1200` | NapCat 的发送确认超时，消息通常已送达，已按成功处理 |
| 突然变哑 | 大概率是群会话在界面上被点开、被别的 agent 占用了；插件会借用那个活会话，实在不行会退到 `-v2` 会话 |

## 已知限制

- **没有主动开口**：纯响应式，没有新消息就永远沉默。
- **只能发文字**：不能发图、表情包、语音；引用和 @ 支持。
- **看不全图片**：图能看，但视频、语音、文件只是占位。
- **账号风控**：NapCat 是非官方客户端，加上 24 小时在线和连续回复，账号有被限制的风险。建议用小号、配静默时段、别把 `flareRate` 和配额拉满。
- **群友档案只统计不抽取**：不会自己总结「谁欠谁一顿饭」，`notes` 字段留着但没用上。
