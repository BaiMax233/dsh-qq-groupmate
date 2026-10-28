import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createFileLogger } from '../src/host/file-logger.js'

function wait(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

test('日志写到按天命名的文件里', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-log-'))
  try {
    const log = createFileLogger('qq-groupmate', { dir })
    log.info('收到一条消息', { groupId: '807813276' })
    log.warn('这句是警告')
    await wait(300)

    const files = await readdir(dir)
    assert.equal(files.length, 1)
    assert.match(files[0] ?? '', /^\d{4}-\d{2}-\d{2}\.log$/)

    const text = await readFile(join(dir, files[0] ?? ''), 'utf8')
    assert.match(text, /INFO\s+\[qq-groupmate\] 收到一条消息/)
    assert.match(text, /807813276/)
    assert.match(text, /WARN\s+\[qq-groupmate\] 这句是警告/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('超过保留期的日志会被清掉', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-log-'))
  try {
    await writeFile(join(dir, '2020-01-01.log'), 'ancient\n', 'utf8')
    await writeFile(join(dir, 'notes.txt'), 'keep me\n', 'utf8')

    const log = createFileLogger('qq-groupmate', { dir, keepDays: 7 })
    log.info('触发一次写入，顺带清理')
    await wait(400)

    const files = await readdir(dir)
    assert.equal(files.includes('2020-01-01.log'), false)
    // 不是日志格式的文件不碰。
    assert.equal(files.includes('notes.txt'), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
