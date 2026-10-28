import assert from 'node:assert/strict'
import test from 'node:test'

import { MemberDirectory } from '../src/core/members.js'
import type { GroupMessage } from '../src/core/types.js'

function message(userId: string, nickname: string, text = 'hi', at = 1_000): GroupMessage {
  return {
    id: `m-${userId}-${at}`,
    groupId: '807813276',
    userId,
    nickname,
    role: 'member',
    text,
    atSelf: false,
    replyToSelf: false,
    atUserIds: [],
    at: at,
    self: false,
  }
}

test('统计发言条数与昵称', () => {
  const dir = new MemberDirectory()
  dir.observe(message('1', '以后'))
  dir.observe(message('1', '以后改的名'))
  dir.observe(message('2', '水'))

  const profiles = dir.profiles('807813276')
  assert.equal(profiles.length, 2)
  assert.equal(profiles[0]?.userId, '1')
  assert.equal(profiles[0]?.messages, 2)
  assert.equal(profiles[0]?.nickname, '以后改的名')
})

test('自己的消息不记进档案', () => {
  const dir = new MemberDirectory()
  dir.observe({ ...message('10000', '我'), self: true })
  assert.equal(dir.profiles('807813276').length, 0)
})

test('摘要只列说过两次以上的人，并按活跃度排序', () => {
  const dir = new MemberDirectory()
  for (let i = 0; i < 3; i += 1) dir.observe(message('1', '以后', 'hi', 1_000 + i))
  dir.observe(message('2', '水'))
  dir.observe(message('2', '水'))
  dir.observe(message('3', '路人'))

  const summary = dir.summary('807813276')
  assert.match(summary, /以后\(1\)：3 条/)
  assert.match(summary, /水\(2\)：2 条/)
  assert.equal(summary.includes('路人'), false)
})

test('载入历史档案时取最大值，不重复累加', () => {
  const dir = new MemberDirectory()
  dir.observe(message('1', '以后', 'hi', 5_000))

  dir.load('807813276', {
    version: 1,
    groupId: '807813276',
    members: [{ userId: '1', nickname: '以后', messages: 40, firstSeenAt: 1, lastSeenAt: 9_000 }],
  })

  const profile = dir.profiles('807813276')[0]
  assert.equal(profile?.messages, 40)
  assert.equal(profile?.lastSeenAt, 9_000)
})

test('dump 出来的结构可以再 load 回去', () => {
  const dir = new MemberDirectory()
  dir.observe(message('1', '以后'))
  const dumped = dir.dump('807813276')

  const restored = new MemberDirectory()
  restored.load('807813276', dumped)
  assert.equal(restored.profiles('807813276')[0]?.messages, 1)
})
