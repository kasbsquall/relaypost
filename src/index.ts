import { AccountDO, NotConnectedError } from './account'
import { BufferApiError, graphql } from './buffer/graphql'
import { OAuthError, buildAuthorizeUrl, exchangeCode, type OAuthConfig } from './buffer/oauth'
import { ACCOUNT_QUERY, type BufferAccount } from './buffer/queries'
import { missingConfig, type Env } from './env'
import { pkceChallenge, randomToken, seal, sign, unseal, verify } from './lib/crypto'
import { RegistryDO } from './registry'

export { AccountDO, RegistryDO }

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

// Session cookie: accountId.expiresAtSeconds.signature. The expiry is signed, so
// a copied cookie stops working on schedule regardless of the browser's Max-Age.
async function sessionCookie(accountId: string, env: Env): Promise<string> {
  const payload = `${accountId}.${Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_S}`
  return `${payload}.${await sign(payload, env.SESSION_SECRET)}`
}

async function sessionAccountId(request: Request, env: Env): Promise<string | null> {
  const raw = cookies(request).get(SESSION_COOKIE)
  if (!raw) return null
  const [accountId, exp, signature] = raw.split('.')
  if (!accountId || !exp || !signature) return null
  if (Number(exp) * 1000 < Date.now()) return null
  return (await verify(`${accountId}.${exp}`, signature, env.SESSION_SECRET)) ? accountId : null
}

function accountStub(env: Env, accountId: string) {
  return env.ACCOUNTS.get(env.ACCOUNTS.idFromName(accountId))
}

// ------------------------------------------------------------------ OAuth

async function startAuth(env: Env): Promise<Response> {
  const state = randomToken(16)
  const verifier = randomToken(32)
  const sealed = await seal(JSON.stringify({ state, verifier, exp: Date.now() + OAUTH_TTL_MS }), env.TOKEN_KEY, 'oauth')
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
    pending = JSON.parse(await unseal(raw, env.TOKEN_KEY, 'oauth'))
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
    const session = await sessionCookie(data.account.id, env)
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

  if (m === 'GET /api/state') {
    const demo = env.DEMO_TELEGRAM_CHAT ? { telegramUrl: env.DEMO_TELEGRAM_URL ?? null, discordInvite: env.DEMO_DISCORD_WEBHOOK ? (env.DEMO_DISCORD_INVITE ?? null) : null } : null
    return json({ ...(await stub.state()), telegramBot: env.TELEGRAM_BOT_USERNAME, demo })
  }
  if (m === 'POST /api/demo') return json(await stub.addDemo())
  if (m === 'POST /api/relays/retry') {
    const b = await body<{ postId?: string; destinationId?: string }>(request)
    if (!b.postId || !b.destinationId) return json({ error: 'postId and destinationId are required' }, 400)
    return json(await stub.retryRelay(b.postId, b.destinationId))
  }
  if (m === 'GET /api/channels') return json(await stub.channels())
  if (m === 'GET /api/queue') return json(await stub.queue())
  if (m === 'POST /api/sync') return json(await stub.manualSync())
  if (m === 'POST /api/destinations/discord') {
    const b = await body<{ label?: string; webhookUrl?: string }>(request)
    return json(await stub.addDiscord(b.label ?? '', b.webhookUrl ?? ''))
  }
  if (m === 'POST /api/destinations/slack') {
    const b = await body<{ label?: string; webhookUrl?: string }>(request)
    return json(await stub.addSlack(b.label ?? '', b.webhookUrl ?? ''))
  }
  if (m === 'POST /api/destinations/reddit') {
    const b = await body<{ label?: string; subreddit?: string }>(request)
    return json(await stub.addReddit(b.label ?? '', b.subreddit ?? ''))
  }
  if (m === 'POST /api/notices') {
    const b = await body<{ destinationId?: string | null }>(request)
    return json(await stub.setNoticeDestination(typeof b.destinationId === 'string' ? b.destinationId : null))
  }
  if (m === 'POST /api/destinations/telegram') {
    const b = await body<{ label?: string }>(request)
    const pending = await stub.startTelegram(b.label ?? '')
    await env.REGISTRY.get(env.REGISTRY.idFromName('global')).register(pending.code, accountId)
    return json({ ...pending, bot: env.TELEGRAM_BOT_USERNAME })
  }
  if (request.method === 'PATCH' && path.startsWith('/api/destinations/')) {
    const b = await body<{ label?: string }>(request)
    await stub.renameDestination(path.split('/').pop()!, b.label ?? '')
    return json({ ok: true })
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
  if (request.method === 'DELETE' && path.startsWith('/api/relays/')) {
    const [postId, destinationId] = path.slice('/api/relays/'.length).split('/')
    if (!postId || !destinationId) return json({ error: 'Use /api/relays/<postId>/<destinationId>' }, 400)
    await stub.hideRelay(decodeURIComponent(postId), decodeURIComponent(destinationId))
    return json({ ok: true })
  }
  if (request.method === 'DELETE' && path.startsWith('/api/rules/')) {
    await stub.removeRule(path.split('/').pop()!)
    return json({ ok: true })
  }
  if (m === 'POST /api/posts/tag') {
    const b = await body<{ postId: string; tagId: string; on: boolean }>(request)
    return json(await stub.setPostTag(b.postId, b.tagId, Boolean(b.on)))
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
  console.error(JSON.stringify({ event: 'api_error', message: text }))
  // Messages written for people (Buffer's own, or ours) pass through; internal
  // configuration or crypto errors do not.
  const safe = /TOKEN_KEY|SESSION_SECRET|decrypt|operation-specific|undefined|TypeError/i.test(text) || !text ? 'Something went wrong on our side.' : text
  return json({ error: 'failed', message: safe }, 400)
}

// --------------------------------------------------------------- Telegram

// Step 2 of linking: the user posted their one-time code in the channel where
// our bot is an admin. Only someone who can post there can produce this update.
async function telegramWebhook(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) return new Response('forbidden', { status: 403 })
  const update = (await request.json().catch(() => null)) as { channel_post?: { message_id: number; text?: string; chat: { id: number; type: string; title?: string } } } | null
  const post = update?.channel_post
  const code = post?.text?.match(/RP-[A-Z0-9]{8}/)?.[0]
  if (!post || !code || post.chat.type !== 'channel') return new Response('ok')
  const accountId = await env.REGISTRY.get(env.REGISTRY.idFromName('global')).consume(code)
  if (!accountId) return new Response('ok')
  const linked = await accountStub(env, accountId).finishTelegram(code, String(post.chat.id), post.chat.title ?? '')
  if (linked) {
    const base = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`
    const headers = { 'Content-Type': 'application/json' }
    await fetch(`${base}/deleteMessage`, { method: 'POST', headers, body: JSON.stringify({ chat_id: post.chat.id, message_id: post.message_id }) }).catch(() => undefined)
    await fetch(`${base}/sendMessage`, { method: 'POST', headers, body: JSON.stringify({ chat_id: post.chat.id, text: 'Relaypost is connected to this channel.' }) }).catch(() => undefined)
  }
  return new Response('ok')
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const missing = missingConfig(env)
    if (missing.length && (url.pathname.startsWith('/auth') || url.pathname.startsWith('/api') || url.pathname.startsWith('/telegram') || url.pathname === '/callback')) {
      console.error(JSON.stringify({ event: 'missing_config', missing }))
      return json({ error: 'misconfigured' }, 500)
    }
    try {
      if (url.pathname === '/auth/start' && request.method === 'GET') return startAuth(env)
      if (url.pathname === '/callback' && request.method === 'GET') return callback(request, env)
      if (url.pathname.startsWith('/api/')) return await api(request, env, url.pathname)
      if (url.pathname === '/telegram/webhook' && request.method === 'POST') return await telegramWebhook(request, env)
      return env.ASSETS.fetch(request)
    } catch (err) {
      return errorResponse(err)
    }
  },
} satisfies ExportedHandler<Env>
