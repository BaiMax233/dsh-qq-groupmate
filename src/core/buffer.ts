import type { GroupMessage } from './types.js'

export interface BufferOptions {
  /** 每个群保留的最大条数。 */
  readonly maxPerGroup: number
  /** 最多跟踪多少个群，防止被无关群撑爆内存。 */
  readonly maxGroups: number
}

interface Bucket {
  readonly messages: GroupMessage[]
  readonly seen: Set<string>
  lastAt: number
}

/**
 * 每群一个滚动窗口。
 *
 * 只保留最近的 N 条：模型需要的是「刚才在聊什么」，
 * 而不是完整历史；完整历史属于记忆层，不在这个骨架里。
 */
export class GroupBuffers {
  private readonly groups = new Map<string, Bucket>()

  constructor(private readonly options: BufferOptions) {}

  /** 返回 false 表示这条消息重复，调用方应当忽略。 */
  push(message: GroupMessage): boolean {
    let bucket = this.groups.get(message.groupId)
    let created = false
    if (!bucket) {
      bucket = { messages: [], seen: new Set(), lastAt: 0 }
      this.groups.set(message.groupId, bucket)
      created = true
    }

    if (bucket.seen.has(message.id)) return false
    bucket.seen.add(message.id)
    bucket.messages.push(message)
    bucket.lastAt = message.at

    while (bucket.messages.length > this.options.maxPerGroup) {
      const dropped = bucket.messages.shift()
      if (dropped) bucket.seen.delete(dropped.id)
    }

    // 必须等 lastAt 更新之后再淘汰，否则刚建的空桶会把自己踢掉。
    if (created) this.evictIfNeeded()
    return true
  }

  snapshot(groupId: string, limit?: number): GroupMessage[] {
    const bucket = this.groups.get(groupId)
    if (!bucket) return []
    const size = limit === undefined ? bucket.messages.length : Math.max(0, limit)
    return bucket.messages.slice(-size)
  }

  size(groupId: string): number {
    return this.groups.get(groupId)?.messages.length ?? 0
  }

  clear(groupId: string): void {
    this.groups.delete(groupId)
  }

  get trackedGroups(): readonly string[] {
    return [...this.groups.keys()]
  }

  private evictIfNeeded(): void {
    if (this.groups.size <= this.options.maxGroups) return
    let oldestId: string | undefined
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [id, bucket] of this.groups) {
      if (bucket.lastAt < oldestAt) {
        oldestAt = bucket.lastAt
        oldestId = id
      }
    }
    if (oldestId !== undefined) this.groups.delete(oldestId)
  }
}
