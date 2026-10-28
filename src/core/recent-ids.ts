/** 记录自己发出过的 message_id，用来识别「有人回复了我」。 */
export class RecentIds {
  private readonly ids: string[] = []
  private readonly set = new Set<string>()

  constructor(private readonly limit = 200) {}

  add(id: string): void {
    if (id === '' || this.set.has(id)) return
    this.set.add(id)
    this.ids.push(id)
    while (this.ids.length > this.limit) {
      const dropped = this.ids.shift()
      if (dropped !== undefined) this.set.delete(dropped)
    }
  }

  has(id: string): boolean {
    return this.set.has(id)
  }
}
