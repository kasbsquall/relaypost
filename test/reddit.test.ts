import { describe, expect, it, vi } from 'vitest'
import type { BufferPost } from '../src/buffer/queries'
import { sendNotice } from '../src/relay/deliver'
import { REDDIT_TITLE_MAX, REDDIT_URL_MAX, normalizeSubreddit, redditBody, redditDraft, redditSubmitUrl, redditTitle } from '../src/relay/reddit'

function post(overrides: Partial<BufferPost> = {}): BufferPost {
  return {
    id: 'p1',
    text: 'Our spring workshop opens on Saturday. Bring a friend and a notebook.',
    status: 'sent',
    dueAt: '2026-11-10T15:00:00Z',
    sentAt: '2026-11-10T15:00:21Z',
    externalLink: 'https://bsky.app/profile/x/post/1',
    channelId: 'ch-bsky',
    channelService: 'bluesky',
    tags: [],
    assets: [],
    error: null,
    ...overrides,
  }
}

function params(url: string): URLSearchParams {
  return new URL(url).searchParams
}

describe('Reddit drafts', () => {
  it('accepts a subreddit however it is pasted, and rejects anything else', () => {
    expect(normalizeSubreddit('r/SideProject')).toBe('SideProject')
    expect(normalizeSubreddit('/r/test/')).toBe('test')
    expect(normalizeSubreddit('https://www.reddit.com/r/webdev/')).toBe('webdev')
    expect(normalizeSubreddit('indiehackers')).toBe('indiehackers')
    expect(normalizeSubreddit('r/a')).toBeNull()
    expect(normalizeSubreddit('r/has space')).toBeNull()
    expect(normalizeSubreddit('https://evil.example/r/test')).toBeNull()
  })

  it('takes the first sentence as the title', () => {
    expect(redditTitle(post())).toBe('Our spring workshop opens on Saturday.')
  })

  it('cuts a long first line at a word, within Reddit title limit', () => {
    const title = redditTitle(post({ text: 'word '.repeat(120) }))
    expect(title.length).toBeLessThanOrEqual(REDDIT_TITLE_MAX)
    expect(title.endsWith('…')).toBe(true)
  })

  it('falls back to the network name for a media-only post', () => {
    expect(redditTitle(post({ text: '' }))).toBe('New post from Bluesky')
  })

  it('keeps the full text, the image and the link to the original in the body', () => {
    const p = post({ assets: [{ type: 'image', source: 'https://img.example/a.png', thumbnail: '' }] })
    const body = redditBody(p, redditTitle(p))
    expect(body).toContain('Bring a friend and a notebook.')
    expect(body).toContain('Image: https://img.example/a.png')
    expect(body).toContain('Originally posted on Bluesky: https://bsky.app/profile/x/post/1')
  })

  it('does not repeat a one-sentence post in the body', () => {
    const p = post({ text: 'Doors open at nine.' })
    expect(redditBody(p, redditTitle(p))).toBe('Originally posted on Bluesky: https://bsky.app/profile/x/post/1')
  })

  it('opens the subreddit submit page with title and text filled in', () => {
    const { url } = redditDraft(post(), 'SideProject')
    expect(url.startsWith('https://www.reddit.com/r/SideProject/submit?')).toBe(true)
    const q = params(url)
    expect(q.get('type')).toBe('TEXT')
    expect(q.get('title')).toBe('Our spring workshop opens on Saturday.')
    expect(q.get('text')).toContain('Originally posted on Bluesky')
  })

  it('shortens the body, never the title, when the link would be too long', () => {
    const url = redditSubmitUrl('test', 'A title', 'long text '.repeat(2000))
    expect(url.length).toBeLessThanOrEqual(REDDIT_URL_MAX)
    expect(params(url).get('title')).toBe('A title')
  })

  it('drops the body entirely rather than loop when nothing fits', () => {
    const url = redditSubmitUrl('test', 'x'.repeat(REDDIT_URL_MAX), 'body')
    expect(params(url).get('text')).toBeNull()
  })
})

describe('Notices', () => {
  it('sends plain text to Discord without pinging anyone', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: '1', channel_id: '2' }), { status: 200 }))
    const res = await sendNotice('discord', 'https://discord.com/api/webhooks/1/a', '@everyone Buffer did not publish', '', fetcher as unknown as typeof fetch)
    expect(res.ok).toBe(true)
    const sent = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(sent.content).toBe('@everyone Buffer did not publish')
    expect(sent.allowed_mentions).toEqual({ parse: [] })
  })

  it('escapes Slack control characters', async () => {
    const fetcher = vi.fn(async () => new Response('ok', { status: 200 }))
    await sendNotice('slack', 'https://hooks.slack.com/services/T/B/x', 'Ready <!channel> & go', '', fetcher as unknown as typeof fetch)
    const sent = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(sent.text).toBe('Ready &lt;!channel&gt; &amp; go')
  })

  it('sends a Telegram message without a link preview, and reports a refusal', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }))
    expect((await sendNotice('telegram', '@chan', 'hi', 'token', ok as unknown as typeof fetch)).ok).toBe(true)
    const sent = JSON.parse((ok.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(sent).toMatchObject({ chat_id: '@chan', text: 'hi', link_preview_options: { is_disabled: true } })
    const refused = vi.fn(async () => new Response(JSON.stringify({ ok: false, description: 'chat not found' }), { status: 400 }))
    const res = await sendNotice('telegram', '@gone', 'hi', 'token', refused as unknown as typeof fetch)
    expect(res).toMatchObject({ ok: false, retryable: false })
    expect(res.detail).toContain('chat not found')
  })
})
