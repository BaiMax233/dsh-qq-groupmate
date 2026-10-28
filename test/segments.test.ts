import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectAtIds,
  collectImageUrls,
  renderSegmentText,
  replyIdOf,
  toGroupMessage,
  toGroupMessageFromHistory,
  toSegments,
} from '../src/onebot/segments.js'

test('只收集 http 图片地址，本机文件名忽略', () => {
  const segments = toSegments([
    { type: 'image', data: { url: 'http://127.0.0.1:3000/a.png' } },
    { type: 'image', data: { file: 'b.jpg' } },
    { type: 'image', data: { url: 'http://127.0.0.1:3000/a.png' } },
    { type: 'text', data: { text: '看这个' } },
  ])

  assert.deepEqual(collectImageUrls(segments), ['http://127.0.0.1:3000/a.png'])
  assert.equal(renderSegmentText(segments, '1'), '[图片][图片][图片]看这个')
})

test('归一化时把图片地址挂到消息上', () => {
  const message = toGroupMessage(
    {
      post_type: 'message',
      message_type: 'group',
      self_id: 10000,
      message_id: 3,
      group_id: 123456,
      user_id: 20001,
      time: 1700000000,
      message: [{ type: 'image', data: { url: 'https://example.com/x.jpg' } }],
    },
    { selfId: '10000', isOurs: () => false },
  )

  assert.ok(message)
  assert.deepEqual(message.images, ['https://example.com/x.jpg'])
})

test('数组消息渲染成可读文本', () => {
  const segments = toSegments([
    { type: 'at', data: { qq: '10000' } },
    { type: 'text', data: { text: ' 在吗' } },
    { type: 'image', data: { file: 'a.jpg' } },
  ])
  assert.equal(renderSegmentText(segments, '10000'), '@你 在吗[图片]')
  assert.deepEqual(collectAtIds(segments), ['10000'])
})

test('CQ 字符串能解析出 at 与 reply', () => {
  const segments = toSegments('[CQ:reply,id=88][CQ:at,qq=10000] 早')
  assert.deepEqual(collectAtIds(segments), ['10000'])
  assert.equal(replyIdOf(segments), '88')
  assert.equal(renderSegmentText(segments, '10000'), '@你 早')
})

test('非群消息返回 undefined', () => {
  assert.equal(toGroupMessage({ post_type: 'meta_event' }, { selfId: '1', isOurs: () => false }), undefined)
  assert.equal(toGroupMessage('nope', { selfId: '1', isOurs: () => false }), undefined)
})

test('归一化：自己发的消息标记 self', () => {
  const message = toGroupMessage(
    {
      post_type: 'message',
      message_type: 'group',
      self_id: 10000,
      message_id: 1,
      group_id: 123456,
      user_id: 10000,
      time: 1700000000,
      message: [{ type: 'text', data: { text: '在' } }],
      sender: { nickname: '小满' },
    },
    { selfId: '10000', isOurs: () => false },
  )

  assert.ok(message)
  assert.equal(message.self, true)
  assert.equal(message.groupId, '123456')
  assert.equal(message.at, 1700000000000)
})

test('归一化：回复自己时 replyToSelf 为真', () => {
  const message = toGroupMessage(
    {
      post_type: 'message',
      message_type: 'group',
      self_id: 10000,
      message_id: 2,
      group_id: 123456,
      user_id: 20001,
      time: 1700000000,
      message: [
        { type: 'reply', data: { id: 'fake-3' } },
        { type: 'text', data: { text: '你刚说啥' } },
      ],
    },
    { selfId: '10000', isOurs: id => id.startsWith('fake-') },
  )

  assert.ok(message)
  assert.equal(message.replyToSelf, true)
  assert.equal(message.atSelf, false)
})

test('群历史条目没有 post_type，也能归一化', () => {
  // get_group_msg_history 返回的正是这种形状：没有 post_type / message_type。
  const entry = {
    message_id: 778,
    group_id: 807813276,
    user_id: 136846459,
    time: 1700000100,
    message: [{ type: 'text', data: { text: '回去还得 vibe 一下' } }],
    sender: { nickname: '以后', role: 'member' },
  }

  const message = toGroupMessageFromHistory(entry, { selfId: '10000', isOurs: () => false })
  assert.ok(message)
  assert.equal(message.groupId, '807813276')
  assert.equal(message.userId, '136846459')
  assert.equal(message.nickname, '以后')
  assert.equal(message.at, 1700000100000)
  assert.equal(message.self, false)

  assert.equal(toGroupMessageFromHistory('nope', { selfId: '1', isOurs: () => false }), undefined)
})
