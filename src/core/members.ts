/**
 * 群友档案：记住这个群里有哪些人、谁话多、最近什么时候来过。
 *
 * 只是骨架——不调模型、不做抽取，纯统计。
 * 目的有二：让 transcript 之外有一份「谁是谁」的底账；
 * 以及给以后让模型写备注（notes）留好位置。
 */
import type { GroupMessage } from './types.js'

export interface MemberProfile {
  readonly userId: string
  nickname: string
  messages: number
  firstSeenAt: number
  lastSeenAt: number
  /** 预留：以后可以让模型给某个人写一句备注。 */
  notes?: string
}

export interface MemberFile {
  readonly version: 1
  readonly groupId: string
  readonly members: readonly MemberProfile[]
}

export class MemberDirectory {
  private readonly groups = new Map<string, Map<string, MemberProfile>>()

  observe(message: GroupMessage): void {
    if (message.self || message.userId === '') return
    const group = this.bucket(message.groupId)
    const existing = group.get(message.userId)
    if (existing === undefined) {
      group.set(message.userId, {
        userId: message.userId,
        nickname: message.nickname || message.userId,
        messages: 1,
        firstSeenAt: message.at,
        lastSeenAt: message.at,
      })
      return
    }
    if (message.nickname !== '') existing.nickname = message.nickname
    existing.messages += 1
    existing.lastSeenAt = Math.max(existing.lastSeenAt, message.at)
  }

  /** 按发言数从多到少。 */
  profiles(groupId: string): MemberProfile[] {
    const group = this.groups.get(groupId)
    if (group === undefined) return []
    return [...group.values()].sort((a, b) => b.messages - a.messages)
  }

  /** 合并一份历史档案：新数据优先，旧数据只补空缺。 */
  load(groupId: string, raw: unknown): void {
    if (raw === null || typeof raw !== 'object') return
    const members = (raw as MemberFile).members
    if (!Array.isArray(members)) return

    const group = this.bucket(groupId)
    for (const item of members) {
      if (item === null || typeof item !== 'object') continue
      const userId = typeof item.userId === 'string' ? item.userId : ''
      if (userId === '') continue

      const existing = group.get(userId)
      if (existing === undefined) {
        group.set(userId, {
          userId,
          nickname: typeof item.nickname === 'string' && item.nickname !== '' ? item.nickname : userId,
          messages: Number.isFinite(item.messages) ? Math.max(0, item.messages) : 0,
          firstSeenAt: Number.isFinite(item.firstSeenAt) ? item.firstSeenAt : 0,
          lastSeenAt: Number.isFinite(item.lastSeenAt) ? item.lastSeenAt : 0,
          notes: typeof item.notes === 'string' ? item.notes : undefined,
        })
        continue
      }
      existing.messages = Math.max(existing.messages, Number.isFinite(item.messages) ? item.messages : 0)
      existing.lastSeenAt = Math.max(existing.lastSeenAt, Number.isFinite(item.lastSeenAt) ? item.lastSeenAt : 0)
      if (existing.nickname === '' && typeof item.nickname === 'string') existing.nickname = item.nickname
      if (existing.notes === undefined && typeof item.notes === 'string') existing.notes = item.notes
    }
  }

  dump(groupId: string): MemberFile {
    return { version: 1, groupId, members: this.profiles(groupId) }
  }

  /**
   * 渲染成提示词里的一小段。只列真正说过话的人，避免把潜水员也塞进去。
   */
  summary(groupId: string, limit = 8, minMessages = 2): string {
    const members = this.profiles(groupId).filter(profile => profile.messages >= minMessages)
    if (members.length === 0) return ''

    const lines = ['【这个群里的人】（数字是他说过多少条，仅供参考）']
    for (const profile of members.slice(0, limit)) {
      const note = profile.notes !== undefined && profile.notes !== '' ? `，${profile.notes}` : ''
      lines.push(`${profile.nickname}(${profile.userId})：${profile.messages} 条${note}`)
    }
    if (members.length > limit) lines.push(`（还有 ${members.length - limit} 人说过话）`)
    return lines.join('\n')
  }

  private bucket(groupId: string): Map<string, MemberProfile> {
    let group = this.groups.get(groupId)
    if (group === undefined) {
      group = new Map()
      this.groups.set(groupId, group)
    }
    return group
  }
}
