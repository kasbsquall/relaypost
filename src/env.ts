import type { AccountDO } from './account'
import type { RegistryDO } from './registry'

export interface Env {
  ACCOUNTS: DurableObjectNamespace<AccountDO>
  REGISTRY: DurableObjectNamespace<RegistryDO>
  ASSETS: Fetcher
  BUFFER_CLIENT_ID: string
  BUFFER_CLIENT_SECRET: string
  BUFFER_SCOPES: string
  REDIRECT_URI: string
  SESSION_SECRET: string
  TOKEN_KEY: string
  TELEGRAM_BOT_TOKEN: string
  TELEGRAM_BOT_USERNAME: string
  TELEGRAM_WEBHOOK_SECRET: string
  // Judge mode, all optional: the public demo channels anyone can watch.
  DEMO_TELEGRAM_CHAT?: string
  DEMO_TELEGRAM_URL?: string
  DEMO_DISCORD_WEBHOOK?: string
  DEMO_DISCORD_INVITE?: string
}

const REQUIRED: (keyof Env)[] = [
  'BUFFER_CLIENT_ID',
  'BUFFER_CLIENT_SECRET',
  'REDIRECT_URI',
  'SESSION_SECRET',
  'TOKEN_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_USERNAME',
  'TELEGRAM_WEBHOOK_SECRET',
]

export function missingConfig(env: Env): string[] {
  const missing: string[] = REQUIRED.filter((key) => !env[key])
  if (env.SESSION_SECRET && env.SESSION_SECRET.length < 32) missing.push('SESSION_SECRET (32+ characters)')
  return missing
}
