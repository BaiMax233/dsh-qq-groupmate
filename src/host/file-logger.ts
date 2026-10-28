/**
 * 带按天滚动的文件日志。
 *
 * 插件原本只往 stdout 写，而 stdout 在桌面端是看不见的——
 * 出事只能靠猜。这里每天一个文件，保留最近 N 天。
 */
import { appendFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { Logger } from '../core/types.js'
import { errorMessage } from '../core/types.js'

export interface FileLoggerOptions {
  readonly dir: string
  /** 保留多少天，默认 7。 */
  readonly keepDays?: number
}

export function createFileLogger(scope: string, options: FileLoggerOptions): Logger {
  const keepDays = options.keepDays ?? 7
  const prefix = `[${scope}]`
  let ready: Promise<unknown> | undefined
  let currentDay = ''

  const ensureDir = (): Promise<unknown> => {
    ready ??= mkdir(options.dir, { recursive: true }).then(
      () => prune(options.dir, keepDays),
      () => undefined,
    )
    return ready
  }

  const write = (level: string, message: string, rest: readonly unknown[]): void => {
    const at = new Date()
    const day = dayOf(at)
    const line = `${at.toISOString()} ${level} ${prefix} ${message}${formatRest(rest)}\n`
    if (day !== currentDay) currentDay = day
    void ensureDir()
      .then(() => appendFile(join(options.dir, `${day}.log`), line, 'utf8'))
      .catch(() => undefined)
  }

  return {
    info: (message, ...rest) => {
      console.log(prefix, message, ...rest)
      write('INFO ', message, rest)
    },
    warn: (message, ...rest) => {
      console.warn(prefix, message, ...rest)
      write('WARN ', message, rest)
    },
    error: (message, ...rest) => {
      console.error(prefix, message, ...rest)
      write('ERROR', message, rest)
    },
  }
}

function dayOf(at: Date): string {
  const yyyy = at.getFullYear()
  const mm = String(at.getMonth() + 1).padStart(2, '0')
  const dd = String(at.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function formatRest(rest: readonly unknown[]): string {
  if (rest.length === 0) return ''
  return ` ${rest
    .map(item => (item instanceof Error ? `${item.name}: ${item.message}` : safeJson(item)))
    .join(' ')}`
}

function safeJson(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** 删掉超过保留期的日志文件。失败不影响写日志。 */
async function prune(dir: string, keepDays: number): Promise<void> {
  if (keepDays <= 0) return
  try {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000
    const names = await readdir(dir)
    for (const name of names) {
      const match = /^(\d{4})-(\d{2})-(\d{2})\.log$/.exec(name)
      if (!match) continue
      const stamp = Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00`)
      if (Number.isNaN(stamp) || stamp >= cutoff) continue
      await rm(join(dir, name), { force: true })
    }
  } catch (error) {
    // 清理失败无所谓，别让日志拖垮插件。
    void errorMessage(error)
  }
}
