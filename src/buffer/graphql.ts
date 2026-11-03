// One endpoint, always POST. Rate limits are per app client and shared by every
// connected user (judges included), so each call is counted and the RateLimit
// headers are kept for the UI and the logs.

export const API_URL = 'https://api.buffer.com'
const MAX_INLINE_BACKOFF_SECONDS = 5

export interface RateWindow {
  policy: string
  remaining: number
  resetSeconds: number
}

export class BufferApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
  }
}

// Header shape (developers.buffer.com/guides/api-limits.html):
//   RateLimit: "150-in-15min";r=98;t=897, "600-in-1day";r=598;t=86397
export function parseRateLimit(header: string | null): RateWindow[] {
  if (!header) return []
  const windows: RateWindow[] = []
  for (const match of header.matchAll(/"([^"]+)";r=(\d+);t=(\d+)/g)) {
    windows.push({ policy: match[1]!, remaining: Number(match[2]), resetSeconds: Number(match[3]) })
  }
  return windows
}

export interface GraphqlResult<T> {
  data: T
  rateLimit: RateWindow[]
}

export async function graphql<T>(
  accessToken: string,
  query: string,
  variables: Record<string, unknown> = {},
  fetcher: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  backedOff = false,
): Promise<GraphqlResult<T>> {
  const res = await fetcher(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const rateLimit = parseRateLimit(res.headers.get('RateLimit'))

  if (res.status === 401) throw new BufferApiError('Buffer rejected the access token', 401, 'UNAUTHENTICATED')

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After')) || 0
    if (!backedOff && retryAfter > 0 && retryAfter <= MAX_INLINE_BACKOFF_SECONDS) {
      await sleep(retryAfter * 1000)
      return graphql<T>(accessToken, query, variables, fetcher, sleep, true)
    }
    throw new BufferApiError('Buffer API rate limit reached', 429, 'RATE_LIMITED', retryAfter)
  }

  const json = (await res.json().catch(() => null)) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] } | null
  // A failed GraphQL request still answers HTTP 200; the real outcome is in `errors`.
  if (!res.ok || !json || json.errors?.length) {
    const first = json?.errors?.[0]
    throw new BufferApiError(first?.message ?? `Buffer API HTTP ${res.status}`, res.status, first?.extensions?.code)
  }
  return { data: json.data as T, rateLimit }
}
