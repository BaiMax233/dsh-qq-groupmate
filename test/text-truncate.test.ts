import assert from 'node:assert/strict'
import test from 'node:test'

import { truncateForChat } from '../src/core/speaker.js'

test('没超长时原样返回', () => {
  assert.equal(truncateForChat('短句', 10), '短句')
})

test('超长时断在问号上，不留半句话', () => {
  const long = '哈！原来这荒天帝是自己造出来的替身，拿自身炼出来的东西，能有多大造行？本座弹指可灭，不值一提。'
  const cut = truncateForChat(long, 40)
  // 必须结束在标点上，而不是「本座弹指可」。
  assert.match(cut, /[。！？]$/)
  assert.equal([...cut].length <= 40, true)
  assert.equal(cut.includes('本座弹指可灭'), false)
})

test('没有句号时退而求其次断在逗号', () => {
  const text = '这个事儿吧，我觉得还得再看看，不过也不一定，先这样'
  const cut = truncateForChat(text, 20)
  assert.match(cut, /[，,。！？]$/)
  assert.equal([...cut].length <= 20, true)
})

test('一个标点都没有时用省略号收尾', () => {
  const text = '这是一段完全没有标点符号的很长的文字需要被截断处理'
  const cut = truncateForChat(text, 10)
  assert.equal(cut.endsWith('…'), true)
  assert.equal([...cut].length, 10)
})
