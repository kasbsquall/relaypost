// A single global Durable Object that maps short-lived Telegram link codes to the
// Buffer account that asked for them. The code proves channel ownership: only
// someone who can post in the channel can make our bot see it there.

import { DurableObject } from 'cloudflare:workers'
import type { Env } from './env'

const CODE_TTL_MS = 30 * 60_000

interface Pending {
  accountId: string
  expiresAt: number
}

export class RegistryDO extends DurableObject<Env> {
  async register(code: string, accountId: string): Promise<void> {
    await this.ctx.storage.put<Pending>(`code:${code}`, { accountId, expiresAt: Date.now() + CODE_TTL_MS })
  }

  // One use only: the code is deleted whether or not it is still valid.
  async consume(code: string): Promise<string | null> {
    const key = `code:${code}`
    const pending = await this.ctx.storage.get<Pending>(key)
    if (!pending) return null
    await this.ctx.storage.delete(key)
    return pending.expiresAt > Date.now() ? pending.accountId : null
  }
}
