import { AsyncLocalStorage } from 'node:async_hooks'
import type { Client } from '@libsql/client'
import { getClient } from './db'

const context = new AsyncLocalStorage<{ client: Client; failure?: unknown }>()
let writeQueue: Promise<void> = Promise.resolve()

export function transactionClient(): Client | undefined {
  return context.getStore()?.client
}

/** Source records, journals and their links commit together. Nested writers join. */
export async function withDbTransaction<T>(work: () => Promise<T>): Promise<T> {
  const existing = context.getStore()
  if (existing) {
    try { return await work() } catch (error) {
      existing.failure = error
      throw error
    }
  }
  // Local SQLite clients must not overlap write transactions. Each HTTP request
  // still gets its own async context; no request can inherit another's transaction.
  const previous = writeQueue
  let release!: () => void
  writeQueue = new Promise<void>((resolve) => { release = resolve })
  await previous
  try {
    const base = getClient()
    const tx = await base.transaction('write')
    const scoped = new Proxy(base, {
      get(target, key) {
        if (key === 'execute' || key === 'batch' || key === 'executeMultiple') {
          return tx[key].bind(tx)
        }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    const state: { client: Client; failure?: unknown } = { client: scoped }
    try {
      const result = await context.run(state, work)
      if (state.failure) throw state.failure
      await tx.commit()
      return result
    } catch (error) {
      if (!tx.closed) await tx.rollback()
      throw error
    } finally {
      tx.close()
    }
  } finally {
    release()
  }
}
