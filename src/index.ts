import { AccountDO, NotConnectedError } from './account'
import { BufferApiError, graphql } from './buffer/graphql'
import { OAuthError, buildAuthorizeUrl, exchangeCode, type OAuthConfig } from './buffer/oauth'
import { ACCOUNT_QUERY, type BufferAccount } from './buffer/queries'
import { missingConfig, type Env } from './env'
import { pkceChallenge, randomToken, seal, sign, unseal, verify } from './lib/crypto'

export { AccountDO }

const SESSION_COOKIE = 'rp_session'
const OAUTH_COOKIE = 'rp_oauth'
const OAUTH_TTL_MS = 10 * 60_000
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30

function cookies(request: Request): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim())
  }
  return out
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } })
}

function oauthConfig(env: Env): OAuthConfig {
  return { clientId: env.BUFFER_CLIENT_ID, clientSecret: env.BUFFER_CLIENT_SECRET, redirectUri: env.REDIRECT_URI.trim(), scopes: env.BUFFER_SCOPES }
}

async function sessionAccountId(request: Request, env: Env): Promise<string | null> {
  const raw = cookies(request).get(SESSION_COOKIE)
  if (!raw) return null
  const [accountId, signature] = raw.split('.')
  if (!accountId || !signature) return null
  return (await verify(accountId, signature, env.SESSION_SECRET)) ? accountId : null
}

function accountStub(env: Env, accountId: string) {
  return env.ACCOUNTS.get(env.ACCOUNTS.idFromName(accountId))
}

// ------------------------------------------------------------------ OAuth

async function startAuth(env: Env): Promise<Response> {
  const state = randomToken(16)
  const verifier = randomToken(32)
  const sealed = await seal(JSON.stringify({ state, verifier, exp: Date.now() + OAUTH_TTL_MS }), env.TOKEN_KEY)
  return new Response(null, {
    status: 302,
    headers: { Location: buildAuthorizeUrl(oauthConfig(env), state, await pkceChallenge(verifier)), 'Set-Cookie': cookie(OAUTH_COOKIE, sealed, OAUTH_TTL_MS / 1000) },
  })
}

function backHome(reason: string, extraCookie?: string): Response {
  const headers = new Headers({ Location: `/?connect=${encodeURIComponent(reason)}` })
  headers.append('Set-Cookie', cookie(OAUTH_COOKIE, '', 0))
  if (extraCookie) headers.append('Set-Cookie', extraCookie)
  return new Response(null, { status: 302, headers })
}

async function callback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const raw = cookies(request).get(OAUTH_COOKIE)
  if (!raw) return backHome('expired')
  let pending: { state: string; verifier: string; exp: number }
  try {
    pending = JSON.parse(await unseal(raw, env.TOKEN_KEY))
  } catch {
    return backHome('expired')
  }
  if (pending.exp < Date.now() || url.searchParams.get('state') !== pending.state) return backHome('state')
  if (url.searchParams.get('error')) return backHome('denied')
  const code = url.searchParams.get('code')
  if (!code) return backHome('denied')

  try {
    const tokens = await exchangeCode(oauthConfig(env), code, pending.verifier)
    const { data } = await graphql<{ account: BufferAccount }>(tokens.accessToken, ACCOUNT_QUERY)
    await accountStub(env, data.account.id).link(tokens, data.account)
    const session = `${data.account.id}.${await sign(data.account.id, env.SESSION_SECRET)}`
    const headers = new Headers({ Location: '/' })
    headers.append('Set-Cookie', cookie(OAUTH_COOKIE, '', 0))
    headers.append('Set-Cookie', cookie(SESSION_COOKIE, session, SESSION_MAX_AGE_S))
    return new Response(null, { status: 302, headers })
  } catch (err) {
    console.error(JSON.stringify({ event: 'oauth_callback_failed', code: err instanceof OAuthError ? err.code : undefined }))
    return backHome('failed')
  }
}

// -------------------------------------------------------------------- API

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T
  } catch {
    throw new Error('Invalid JSON body')
  }
}

async function api(request: Request, env: Env, path: string): Promise<Response> {
  const accountId = await sessionAccountId(request, env)
  if (!accountId) return json({ error: 'not_connected' }, 401)
  // State-changing calls need a custom header, which a cross-site form cannot send.
  if (request.method !== 'GET' && request.headers.get('X-Relaypost') !== '1') return json({ error: 'forbidden' }, 403)
  const stub = accountStub(env, accountId)
  const m = `${request.method} ${path}`

  if (m === 'GET /api/state') return json(await stub.state())
  if (m === 'GET /api/channels') return json(await stub.channels())
  if (m === 'GET /api/queue') return json(await stub.queue())
  if (m === 'POST /api/sync') return json({ ok: true, ...(await stub.sync()) })
  if (m === 'POST /api/destinations/discord') {
    const b = await body<{ label?: string; webhookUrl?: string }>(request)
    return json(await stub.addDiscord(b.label ?? '', b.webhookUrl ?? ''))
  }
  if (m === 'POST /api/destinations/telegram') {
    const b = await body<{ label?: string; channel?: string }>(request)
    return json(await stub.addTelegram(b.label ?? '', b.channel ?? ''))
  }
  if (request.method === 'DELETE' && path.startsWith('/api/destinations/')) {
    await stub.removeDestination(path.split('/').pop()!)
    return json({ ok: true })
  }
  if (m === 'POST /api/rules') {
    const b = await body<{ destinationId: string; tagName?: string; channelId?: string }>(request)
    const match = b.channelId ? { kind: 'channel' as const, channelId: b.channelId } : { kind: 'tag' as const, tagName: b.tagName ?? '' }
    if (match.kind === 'tag' && !match.tagName.trim()) return json({ error: 'Tag name is required' }, 400)
    return json(await stub.addRule(b.destinationId, match))
  }
  if (request.method === 'DELETE' && path.startsWith('/api/rules/')) {
    await stub.removeRule(path.split('/').pop()!)
    return json({ ok: true })
  }
  if (m === 'POST /api/posts/tag') {
    const b = await body<{ postId: string; tagId: string; on: boolean; currentTagIds: string[] }>(request)
    return json(await stub.setPostTag(b.postId, b.tagId, Boolean(b.on), Array.isArray(b.currentTagIds) ? b.currentTagIds : []))
  }
  if (m === 'POST /api/logout') return json({ ok: true }, 200, { 'Set-Cookie': cookie(SESSION_COOKIE, '', 0) })
  if (m === 'POST /api/disconnect') {
    await stub.disconnect()
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(SESSION_COOKIE, '', 0) })
  }
  return json({ error: 'not_found' }, 404)
}

// Errors thrown inside the Durable Object cross the RPC boundary as plain Errors,
// so the class is lost and the message is what identifies them.
function errorResponse(err: unknown): Response {
  const text = err instanceof Error ? err.message : ''
  if (err instanceof NotConnectedError || /Not connected|Connect again/.test(text)) {
    return json({ error: 'not_connected', message: text }, 401)
  }
  if ((err instanceof BufferApiError && err.status === 429) || /rate limit/i.test(text)) {
    return json({ error: 'rate_limited', message: 'Buffer asked us to slow down. Try again in a moment.', retryAfter: err instanceof BufferApiError ? err.retryAfterSeconds : undefined }, 429)
  }
  const message = err instanceof Error ? err.message : 'Unexpected error'
  console.error(JSON.stringify({ event: 'api_error', message }))
  return json({ error: 'failed', message }, 400)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const missing = missingConfig(env)
    if (missing.length && (url.pathname.startsWith('/auth') || url.pathname.startsWith('/api') || url.pathname === '/callback')) {
      console.error(JSON.stringify({ event: 'missing_config', missing }))
      return json({ error: 'misconfigured' }, 500)
    }
    try {
      if (url.pathname === '/auth/start' && request.method === 'GET') return startAuth(env)
      if (url.pathname === '/callback' && request.method === 'GET') return callback(request, env)
      if (url.pathname.startsWith('/api/')) return await api(request, env, url.pathname)
      return env.ASSETS.fetch(request)
    } catch (err) {
      return errorResponse(err)
    }
  },
} satisfies ExportedHandler<Env>
