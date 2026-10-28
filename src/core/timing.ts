/**
 * 可被 abort 打断的 sleep，以及一个不做特殊处理的普通 sleep。
 * 所有等待都必须能被插件卸载打断，否则卸载会挂住。
 */

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const done = (): void => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const timer = setTimeout(done, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
