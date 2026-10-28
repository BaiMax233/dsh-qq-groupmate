import assert from 'node:assert/strict'
import test from 'node:test'

import { GroupBuffers } from '../src/core/buffer.js'
import type { GroupMessage } from '../src/core/types.js'

function message(id: string, groupId = 'g1'): GroupMessage {
  return {
    id,
    groupId,
    userId: 'u1',
    nickname: '张三',
    role: 'member',
    text: id,
    atSelf: false,
    replyToSelf: false,
    atUserIds: [],
    at: Date.now(),
    self: false,
  }
}

test('重复 message_id 只入缓冲一次', () => {
  const buffers = new GroupBuffers({ maxPerGroup: 10, maxGroups: 5 })
  assert.equal(buffers.push(message('a')), true)
  assert.equal(buffers.push(message('a')), false)
  assert.equal(buffers.size('g1'), 1)
})

test('超出上限时丢弃最旧的，并同步清理去重集合', () => {
  const buffers = new GroupBuffers({ maxPerGroup: 3, maxGroups: 5 })
  for (const id of ['a', 'b', 'c', 'd']) buffers.push(message(id))
  assert.deepEqual(
    buffers.snapshot('g1').map(m => m.id),
    ['b', 'c', 'd'],
  )
  // a 已经被挤出窗口，再出现应当被当作新消息。
  assert.equal(buffers.push(message('a')), true)
})

test('snapshot 只取最近 N 条', () => {
  const buffers = new GroupBuffers({ maxPerGroup: 10, maxGroups: 5 })
  for (const id of ['a', 'b', 'c']) buffers.push(message(id))
  assert.deepEqual(
    buffers.snapshot('g1', 2).map(m => m.id),
    ['b', 'c'],
  )
})

test('群数量超限时淘汰最久未活动的群', () => {
  const buffers = new GroupBuffers({ maxPerGroup: 10, maxGroups: 2 })
  buffers.push({ ...message('a', 'g1'), at: 1 })
  buffers.push({ ...message('b', 'g2'), at: 2 })
  buffers.push({ ...message('c', 'g3'), at: 3 })
  assert.deepEqual(buffers.trackedGroups, ['g2', 'g3'])
})
