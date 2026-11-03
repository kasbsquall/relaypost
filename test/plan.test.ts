import { describe, expect, it } from 'vitest'
import type { BufferPost } from '../src/buffer/queries'
import {
  FIRST_CHECK_DELAY_MS,
  GIVE_UP_AFTER_MS,
  RETRY_DELAY_MS,
  SYNC_INTERVAL_MS,
  decide,
  destinationsFor,
  nextAlarm,
  prune,
  reconcile,
  RETENTION_MS,
  type Relay,
  type Rule,
} from '../src/relay/plan'

const T0 = Date.parse('2026-11-10T15:00:00Z')

function post(overrides: Partial<BufferPost> = {}): BufferPost {
  return {
    id: 'p1',
    text: 'Workshop on Saturday',
    status: 'scheduled',
    dueAt: new Date(T0).toISOString(),
    sentAt: null,
    externalLink: null,
    channelId: 'ch-ig',
    channelService: 'instagram',
    tags: [{ id: 'tag-community', name: 'Community', color: '#000' }],
    assets: [],
    error: null,
    ...overrides,
  }
}

const rules: Rule[] = [
  { id: 'r1', destinationId: 'd-telegram', match: { kind: 'tag', tagId: 'tag-community', tagName: 'Community' } },
  { id: 'r2', destinationId: 'd-discord', match: { kind: 'channel', channelId: 'ch-ig' } },
  { id: 'r3', destinationId: 'd-discord', match: { kind: 'tag', tagId: 'tag-community', tagName: 'Community' } },
]

const window = { start: T0 - 3_600_000, end: T0 + 7 * 86_400_000 }

describe('destinationsFor', () => {
  it('collects destinations from tag and channel rules without duplicates', () => {
    expect(destinationsFor(post(), rules).sort()).toEqual(['d-discord', 'd-telegram'])
  })

  it('returns nothing when no rule matches', () => {
    expect(destinationsFor(post({ tags: [], channelId: 'ch-li' }), rules)).toEqual([])
  })
})

describe('reconcile', () => {
  it('creates one waiting relay per matched destination, checked shortly after dueAt', () => {
    const relays = reconcile([], [post()], rules, window)
    expect(relays).toHaveLength(2)
    for (const r of relays) {
      expect(r.status).toBe('waiting')
      expect(r.checkAt).toBe(T0 + FIRST_CHECK_DELAY_MS)
    }
  })

  it('moves the check when the post is rescheduled in Buffer', () => {
    const first = reconcile([], [post()], rules, window)
    const later = new Date(T0 + 86_400_000).toISOString()
    const second = reconcile(first, [post({ dueAt: later })], rules, window)
    expect(second.every((r) => r.checkAt === T0 + 86_400_000 + FIRST_CHECK_DELAY_MS)).toBe(true)
  })

  it('skips a waiting relay whose post disappeared from a covered window', () => {
    const first = reconcile([], [post()], rules, window)
    const second = reconcile(first, [], rules, window)
    expect(second.every((r) => r.status === 'skipped')).toBe(true)
  })

  it('keeps a waiting relay when the read did not cover its dueAt', () => {
    const first = reconcile([], [post()], rules, window)
    const second = reconcile(first, [], rules, { start: T0 + 1, end: T0 + 2 })
    expect(second.every((r) => r.status === 'waiting')).toBe(true)
  })

  it('never reopens a delivered relay', () => {
    const delivered: Relay[] = reconcile([], [post()], rules, window).map((r) => ({ ...r, status: 'delivered' as const }))
    const again = reconcile(delivered, [post()], rules, window)
    expect(again.every((r) => r.status === 'delivered')).toBe(true)
    expect(again).toHaveLength(2)
  })
})

describe('decide', () => {
  const relay = reconcile([], [post()], rules, window)[0]!

  it('delivers once Buffer reports sent', () => {
    expect(decide(post({ status: 'sent' }), relay, T0 + 60_000)).toEqual({ action: 'deliver' })
  })

  it('fails with Buffer error message when publishing failed', () => {
    const d = decide(post({ status: 'error', error: { message: 'Image too large', supportUrl: null } }), relay, T0)
    expect(d).toEqual({ action: 'fail', detail: 'Buffer could not publish it: Image too large' })
  })

  it('waits and retries while Buffer is still sending', () => {
    expect(decide(post({ status: 'sending' }), relay, T0 + 60_000)).toEqual({ action: 'wait', checkAt: T0 + 60_000 + RETRY_DELAY_MS })
  })

  it('gives up after the grace period', () => {
    const d = decide(post({ status: 'scheduled' }), relay, T0 + GIVE_UP_AFTER_MS)
    expect(d.action).toBe('fail')
  })

  it('skips drafts and deleted posts', () => {
    expect(decide(post({ status: 'draft' }), relay, T0).action).toBe('skip')
    expect(decide(undefined, relay, T0).action).toBe('skip')
  })
})

describe('nextAlarm', () => {
  it('picks the earliest waiting check, capped by the next sync', () => {
    const relays = reconcile([], [post()], rules, window)
    expect(nextAlarm(relays, T0, true)).toBe(T0 + FIRST_CHECK_DELAY_MS)
    expect(nextAlarm(relays, T0 - SYNC_INTERVAL_MS, true)).toBe(T0)
  })

  it('sleeps when there are no rules and nothing waiting', () => {
    expect(nextAlarm([], T0, false)).toBeNull()
  })
})

describe('prune', () => {
  it('drops finished relays past retention and keeps anything still waiting', () => {
    const [a, b] = reconcile([], [post()], rules, window)
    const old = { ...a!, status: 'delivered' as const, dueAt: T0 - RETENTION_MS - 1 }
    const waitingOld = { ...b!, dueAt: T0 - RETENTION_MS - 1 }
    expect(prune([old, waitingOld], T0)).toEqual([waitingOld])
  })
})
