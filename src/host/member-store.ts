/**
 * 群友档案的落盘：每个群一个 JSON 文件，放在会话目录下的 groups/ 里。
 * 读写都容错——档案丢了顶多忘记谁是谁，不该影响发言。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Logger } from '../core/types.js'
import { errorMessage } from '../core/types.js'

export class MemberStore {
  constructor(
    private readonly dir: string,
    private readonly log: Logger,
  ) {}

  private file(groupId: string): string {
    return join(this.dir, `${groupId}.members.json`)
  }

  async load(groupId: string): Promise<unknown> {
    try {
      const text = await readFile(this.file(groupId), 'utf8')
      return JSON.parse(text) as unknown
    } catch {
      return undefined
    }
  }

  async save(groupId: string, value: unknown): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true })
      await writeFile(this.file(groupId), JSON.stringify(value), 'utf8')
    } catch (error) {
      this.log.warn(`[qq] 群友档案写入失败（群 ${groupId}）：${errorMessage(error)}`)
    }
  }
}
