// Pure decisions: which posts get relayed where, and what to do when a relay is due.
// No I/O here, so every rule is covered by test/plan.test.ts.

import type { BufferPost } from '../buffer/queries'

export type DestinationKind = 'discord' | 'telegram' | 'slack'

export interface Destination {
  id: string
  kind: DestinationKind
  label: string
  // One of the public demo channels a judge can watch, added with one click.
  demo?: boolean
}

export type RuleMatch = { kind: 'tag'; tagId: string; tagName: string } | { kind: 'channel'; channelId: string }

export interface Rule {
  id: string
  destinationId: string
  match: RuleMatch
  // When the rule was saved (ms). Rules stored before this field existed have none.
  createdAt?: number
}

export type RelayStatus = 'waiting' | 'delivered' | 'skipped' | 'failed'

export interface Relay {
  postId: string
  destinationId: string
  channelId: string
  dueAt: number
  status: RelayStatus
  // Next time the alarm should look at this relay (ms). Only meaningful while waiting.
  checkAt: number
  attempts: number
  detail: string | null
  externalLink: string | null
  deliveredAt: number | null
  preview: string
  // The delivered message itself, when the destination returns a link (public Telegram channels, Discord).
  messageLink?: string | null
  // Removed from the history by the user. Kept in storage so a later sync cannot hand it off again.
  hidden?: boolean
}

// Buffer usually reports `sent` within a minute of dueAt; we look a little after.
export const FIRST_CHECK_DELAY_MS = 45_000
export const RETRY_DELAY_MS = 2 * 60_000
// After this long without `sent`, the post is treated as not published.
export const GIVE_UP_AFTER_MS = 30 * 60_000
export const SYNC_INTERVAL_MS = 30 * 60_000
export const MAX_DELIVERY_ATTEMPTS = 3
// Finished relays older than this are dropped: we keep only what the history view needs.
export const RETENTION_MS = 14 * 86_400_000
export const MAX_RELAYS_KEPT = 300

export function relayKey(postId: string, destinationId: string): string {
  return `${postId}:${destinationId}`
}

function matches(post: BufferPost, rule: Rule): boolean {
  const m = rule.match
  return m.kind === 'tag' ? post.tags.some((t) => t.id === m.tagId) : m.channelId === post.channelId
}

export function destinationsFor(post: BufferPost, rules: readonly Rule[]): string[] {
  return [...new Set(rules.filter((rule) => matches(post, rule)).map((rule) => rule.destinationId))]
}

// A new rule hands off what comes next, never posts that were already due when it was saved.
function dueAfterRule(post: BufferPost, dueAt: number, destinationId: string, rules: readonly Rule[]): boolean {
  return rules.some((rule) => rule.destinationId === destinationId && matches(post, rule) && dueAt >= (rule.createdAt ?? 0))
}

function previewOf(post: BufferPost): string {
  const text = post.text.replace(/\s+/g, ' ').trim()
  return text.length > 140 ? `${text.slice(0, 139)}…` : text
}

// Merge a fresh read of the queue into the stored relays.
// `window` is the dueAt range the read covered: a waiting relay inside it whose
// post no longer matches has been untagged, moved out or deleted in Buffer.
export function reconcile(
  existing: readonly Relay[],
  posts: readonly BufferPost[],
  rules: readonly Rule[],
  window: { start: number; end: number },
): Relay[] {
  const byKey = new Map(existing.map((r) => [relayKey(r.postId, r.destinationId), r]))
  const seen = new Set<string>()
  const next: Relay[] = []

  for (const post of posts) {
    if (!post.dueAt) continue
    const dueAt = Date.parse(post.dueAt)
    for (const destinationId of destinationsFor(post, rules)) {
      const key = relayKey(post.id, destinationId)
      seen.add(key)
      const prior = byKey.get(key)
      if (prior && prior.status !== 'waiting') continue
      if (!prior && !dueAfterRule(post, dueAt, destinationId, rules)) {
        seen.delete(key)
        continue
      }
      next.push({
        postId: post.id,
        destinationId,
        channelId: post.channelId,
        dueAt,
        status: 'waiting',
        // A rescheduled post moves its check along with it.
        checkAt: prior && prior.dueAt === dueAt ? prior.checkAt : dueAt + FIRST_CHECK_DELAY_MS,
        attempts: prior?.attempts ?? 0,
        detail: null,
        externalLink: null,
        deliveredAt: null,
        preview: previewOf(post),
      })
    }
  }

  for (const relay of existing) {
    const key = relayKey(relay.postId, relay.destinationId)
    if (seen.has(key)) {
      if (relay.status !== 'waiting') next.push(relay)
      continue
    }
    const covered = relay.dueAt >= window.start && relay.dueAt <= window.end
    if (relay.status === 'waiting' && covered) {
      next.push({ ...relay, status: 'skipped', detail: 'No longer matches a rule in Buffer (untagged, moved or deleted)' })
    } else {
      next.push(relay)
    }
  }
  return next
}

export type Decision =
  | { action: 'deliver' }
  | { action: 'wait'; checkAt: number }
  | { action: 'fail'; detail: string }
  | { action: 'skip'; detail: string }

// What to do with a waiting relay whose check time has come, given the post as
// Buffer reports it now (undefined when Buffer no longer returns it).
export function decide(post: BufferPost | undefined, relay: Relay, now: number): Decision {
  if (!post) return { action: 'skip', detail: 'The post is no longer in Buffer' }
  switch (post.status) {
    case 'sent':
      return { action: 'deliver' }
    case 'error':
      return { action: 'fail', detail: `Buffer could not publish it: ${post.error?.message ?? 'unknown error'}` }
    case 'draft':
      return { action: 'skip', detail: 'Moved back to drafts in Buffer' }
    default: {
      if (now - relay.dueAt >= GIVE_UP_AFTER_MS) {
        return { action: 'fail', detail: `Buffer had not published it ${GIVE_UP_AFTER_MS / 60_000} minutes after its time` }
      }
      return { action: 'wait', checkAt: now + RETRY_DELAY_MS }
    }
  }
}

export function nextAlarm(relays: readonly Relay[], lastSyncAt: number, hasRules: boolean): number | null {
  let soonest: number | null = hasRules ? lastSyncAt + SYNC_INTERVAL_MS : null
  for (const relay of relays) {
    if (relay.status !== 'waiting') continue
    if (soonest === null || relay.checkAt < soonest) soonest = relay.checkAt
  }
  return soonest
}

export function prune(relays: readonly Relay[], now: number): Relay[] {
  return [...relays]
    .filter((r) => r.status === 'waiting' || now - r.dueAt < RETENTION_MS)
    .sort((a, b) => b.dueAt - a.dueAt)
    .slice(0, MAX_RELAYS_KEPT)
}
