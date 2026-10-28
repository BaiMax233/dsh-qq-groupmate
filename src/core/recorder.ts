/**
 * 结构化决策记录。
 *
 * 每条被评估的消息批次产出一条记录，包含「为什么判断要/不要说话」。
 * 这是后续做可视化面板的数据源，也是调阈值的唯一依据——
 * 没有它，只能靠猜。
 */

export interface DecisionRecord {
  /** 毫秒时间戳。 */
  readonly at: number
  readonly groupId: string
  /** 触发这次评估的最后一条消息摘要。 */
  readonly preview: string
  readonly participate: boolean
  readonly confidence: number
  readonly reason: string
  readonly forced: boolean
  /** 从窗口关闭到本轮结束的耗时。 */
  readonly latencyMs: number
  readonly speaker: 'llm' | 'agent'
  readonly texts: readonly string[]
  readonly error?: string
  /** 判断失败时的模型原始输出（截断），用于回溯。 */
  readonly raw?: string
}

export interface RecorderStats {
  readonly evaluated: number
  readonly participated: number
  readonly skipped: number
  readonly spoken: number
}

export interface RecorderOptions {
  readonly limit?: number
  readonly now?: () => number
  readonly sink?: (record: DecisionRecord) => void
}

export class Recorder {
  private readonly records: DecisionRecord[] = []
  private readonly limit: number
  private readonly now: () => number
  private readonly sink: ((record: DecisionRecord) => void) | undefined
  private totals = { evaluated: 0, participated: 0, skipped: 0, spoken: 0 }

  constructor(options: RecorderOptions = {}) {
    this.limit = options.limit ?? 200
    this.now = options.now ?? Date.now
    this.sink = options.sink
  }

  /** 从 JSONL 里回灌历史记录：只填列表，不改本次进程的统计。 */
  seed(records: readonly DecisionRecord[]): void {
    for (const record of records) {
      if (typeof record?.at !== 'number' || typeof record?.groupId !== 'string') continue
      this.records.push(record)
    }
    while (this.records.length > this.limit) this.records.shift()
  }

  record(input: Omit<DecisionRecord, 'at'> & { readonly at?: number }): DecisionRecord {
    const record: DecisionRecord = { ...input, at: input.at ?? this.now() }
    this.records.push(record)
    if (this.records.length > this.limit) this.records.shift()

    this.totals.evaluated += 1
    if (record.participate) {
      this.totals.participated += 1
      this.totals.spoken += record.texts.length
    } else {
      this.totals.skipped += 1
    }

    try {
      this.sink?.(record)
    } catch {
      // 记录失败不能影响发言。
    }
    return record
  }

  recent(limit = 20, groupId?: string): readonly DecisionRecord[] {
    const source = groupId === undefined ? this.records : this.records.filter(r => r.groupId === groupId)
    return source.slice(-limit)
  }

  stats(): RecorderStats {
    return { ...this.totals }
  }

  /** 跳过原因的直方图，用来判断阈值是不是定歪了。 */
  reasonHistogram(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const record of this.records) {
      if (record.participate) continue
      const key = record.reason.split(':')[0] ?? record.reason
      out[key] = (out[key] ?? 0) + 1
    }
    return out
  }
}
