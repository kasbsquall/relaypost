import { describe, expect, it, vi } from 'vitest'
import type { BufferPost } from '../src/buffer/queries'
import { discordPayload, isDiscordWebhook, sendDiscord, sendTelegram, telegramMessage } from '../src/relay/deliver'

function post(overrides: Partial<BufferPost> = {}): BufferPost {
  return {
    id: 'p1',
    text: 'Our spring workshop opens on Saturday.',
    status: 'sent',
    dueAt: '2026-11-10T15:00:00Z',
    sentAt: '2026-11-10T15:00:21Z',
    externalLink: 'https://www.linkedin.com/feed/update/urn:li:share:1',
    channelId: 'ch-li',
    channelService: 'linkedin',
    tags: [],
    assets: [],
    error: null,
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('Discord', () => {
  it('accepts only real Discord webhook URLs', () => {
    expect(isDiscordWebhook('https://discord.com/api/webhooks/123/abc-DEF_9')).toBe(true)
    expect(isDiscordWebhook('https://evil.example/api/webhooks/123/abc')).toBe(false)
    expect(isDiscordWebhook('http://discord.com/api/webhooks/123/abc')).toBe(false)
  })

  it('builds an embed that links back to the original and never pings anyone', () => {
    const payload = discordPayload(post({ text: '@everyone hello', assets: [{ type: 'image', source: 'https://img.example/a.png', thumbnail: '' }] }))
    const embed = (payload.embeds as Record<string, unknown>[])[0]!
    expect(embed.url).toBe('https://www.linkedin.com/feed/update/urn:li:share:1')
    expect(embed.image).toEqual({ url: 'https://img.example/a.png' })
    expect(payload.allowed_mentions).toEqual({ parse: [] })
  })

  it('marks 5xx as retryable and 4xx as final', async () => {
    const f5 = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch
    const f4 = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch
    expect((await sendDiscord('https://discord.com/api/webhooks/1/a', {}, f5)).retryable).toBe(true)
    expect((await sendDiscord('https://discord.com/api/webhooks/1/a', {}, f4)).retryable).toBe(false)
  })
})

describe('Telegram', () => {
  it('sends a photo with a caption when the post has an image', () => {
    const m = telegramMessage(post({ assets: [{ type: 'image', source: 'https://img.example/a.png', thumbnail: '' }] }))
    expect(m.method).toBe('sendPhoto')
    expect(String(m.body.caption)).toContain('Also on LinkedIn: https://www.linkedin.com/')
  })

  it('keeps captions inside the 1024 character limit, link included', () => {
    const m = telegramMessage(post({ text: 'x'.repeat(5000), assets: [{ type: 'image', source: 'https://img.example/a.png', thumbnail: '' }] }))
    expect(String(m.body.caption).length).toBeLessThanOrEqual(1024)
    expect(String(m.body.caption)).toContain('https://www.linkedin.com/')
  })

  it('falls back to text when Telegram cannot fetch the image', async () => {
    const calls: string[] = []
    const fetcher = vi.fn(async (url: string) => {
      calls.push(url.split('/').pop()!)
      return calls.length === 1 ? jsonResponse({ ok: false, description: 'Bad Request: wrong file identifier' }, 400) : jsonResponse({ ok: true })
    }) as unknown as typeof fetch
    const result = await sendTelegram('TOKEN', '-100', post({ assets: [{ type: 'image', source: 'https://img.example/a.png', thumbnail: '' }] }), fetcher)
    expect(calls).toEqual(['sendPhoto', 'sendMessage'])
    expect(result.ok).toBe(true)
  })
})
