// Buffer OAuth 2.0, Authorization Code flow with PKCE, private (confidential) client.
// Reference: developers.buffer.com/guides/authentication.html and the official
// buffer-sample-apps/app-client-starter-app (MIT).

export const AUTH_URL = 'https://auth.buffer.com/auth'
export const TOKEN_URL = 'https://auth.buffer.com/token'

export interface OAuthConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
  scopes: string
}

export interface TokenSet {
  accessToken: string
  refreshToken: string
  scope: string
  // Epoch ms, already shortened by a safety margin so a token never expires mid-request.
  expiresAt: number
}

export class OAuthError extends Error {
  constructor(message: string, readonly code: string | undefined) {
    super(message)
  }
}

const EXPIRY_MARGIN_MS = 60_000

export function buildAuthorizeUrl(config: OAuthConfig, state: string, codeChallenge: string): string {
  const url = new URL(AUTH_URL)
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: config.scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'consent',
  }).toString()
  return url.toString()
}

async function requestTokens(
  config: OAuthConfig,
  params: Record<string, string>,
  fetcher: typeof fetch,
  now: number,
): Promise<TokenSet> {
  const body = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...params })
  const res = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok || typeof json.error === 'string') {
    const code = typeof json.error === 'string' ? json.error : undefined
    const detail = typeof json.error_description === 'string' ? json.error_description : code ?? `HTTP ${res.status}`
    throw new OAuthError(`Buffer token request failed: ${detail}`, code)
  }
  const accessToken = json.access_token
  const refreshToken = json.refresh_token
  if (typeof accessToken !== 'string') throw new OAuthError('Buffer returned no access token', undefined)
  // Refresh tokens rotate. Without a replacement we would be stuck with a spent
  // token, and replaying it revokes the whole grant.
  if (typeof refreshToken !== 'string') {
    throw new OAuthError('Buffer returned no refresh token; enable offline_access on the app client', undefined)
  }
  const expiresIn = Number(json.expires_in) || 3600
  return {
    accessToken,
    refreshToken,
    scope: typeof json.scope === 'string' ? json.scope : config.scopes,
    expiresAt: now + expiresIn * 1000 - EXPIRY_MARGIN_MS,
  }
}

export function exchangeCode(
  config: OAuthConfig,
  code: string,
  codeVerifier: string,
  fetcher: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<TokenSet> {
  return requestTokens(
    config,
    { grant_type: 'authorization_code', code, redirect_uri: config.redirectUri, code_verifier: codeVerifier },
    fetcher,
    now,
  )
}

export function refresh(
  config: OAuthConfig,
  refreshToken: string,
  fetcher: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<TokenSet> {
  return requestTokens(config, { grant_type: 'refresh_token', refresh_token: refreshToken }, fetcher, now)
}
