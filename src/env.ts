import type { AccountDO } from './account'

export interface Env {
  ACCOUNTS: DurableObjectNamespace<AccountDO>
  ASSETS: Fetcher
  BUFFER_CLIENT_ID: string
  BUFFER_CLIENT_SECRET: string
  BUFFER_SCOPES: string
  REDIRECT_URI: string
  SESSION_SECRET: string
  TOKEN_KEY: string
  TELEGRAM_BOT_TOKEN: string
}

const REQUIRED: (keyof Env)[] = [
  'BUFFER_CLIENT_ID',
  'BUFFER_CLIENT_SECRET',
  'REDIRECT_URI',
  'SESSION_SECRET',
  'TOKEN_KEY',
  'TELEGRAM_BOT_TOKEN',
]

export function missingConfig(env: Env): string[] {
  return REQUIRED.filter((key) => !env[key])
}
