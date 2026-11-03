// One Durable Object per Buffer account. It is the only place that refreshes the
// account's rotating refresh token, and its alarm wakes up when a post is due.

import { DurableObject } from 'cloudflare:workers'
import { BufferApiError, graphql, type RateWindow } from './buffer/graphql'
import { OAuthError, refresh, type OAuthConfig, type TokenSet } from './buffer/oauth'
import {
  CHANNELS_QUERY,
  CREATE_TAG_MUTATION,
  POSTS_QUERY,
  SET_POST_TAGS_MUTATION,
  TAGS_QUERY,
  QUEUE_STATUSES,
  SYNC_STATUSES,
  syncFilters,
  tagEditVariables,
  type BufferAccount,
  type BufferChannel,
  type BufferPost,
  type BufferTag,
  type PostStatus,
} from './buffer/queries'
import type { Env } from './env'
import { randomToken, seal, unseal } from './lib/crypto'
import { discordPayload, isDiscordWebhook, sendDiscord, sendTelegram, type DeliveryResult } from './relay/deliver'
import {
  MAX_DELIVERY_ATTEMPTS,
  RETRY_DELAY_MS,
  decide,
  nextAlarm,
  prune,
  reconcile,
  type Destination,
  type DestinationKind,
  type Relay,
  type Rule,
  type RuleMatch,
} from './relay/plan'

interface StoredDestination extends Destination {
  sealedTarget: string
  createdAt: number
}

interface Profile {
  account: BufferAccount
  organizationId: string
}

interface PendingTelegram {
  code: string
  label: string
  expiresAt: number
}

export interface CallLog {
  count: number
  rateLimit: RateWindow[]
}

const SYNC_BACK_MS = 2 * 3_600_000
const SYNC_AHEAD_MS = 14 * 86_400_000
const CHANNEL_CACHE_MS = 10 * 60_000
const QUEUE_CACHE_MS = 60_000
const MANUAL_SYNC_COOLDOWN_MS = 30_000
const IDLE_AFTER_MS = 14 * 86_400_000
const MAX_PAGES = 3
const MAX_DESTINATIONS = 10
const MAX_RULES = 30
// Requests kept in reserve for scheduled relays: on-demand calls stop before this.
const RATE_RESERVE = 20
const RELAY_TAG_COLOR = '#B14328'
const TELEGRAM_CODE_TTL_MS = 30 * 60_000

export class NotConnectedError extends Error {}

type CallKind = 'background' | 'interactive'

export class AccountDO extends DurableObject<Env> {
  // Promise chains that serialize token use and sync. A Durable Object can
  // interleave requests while one awaits a fetch; these keep each critical
  // section whole, so a spent refresh token is never replayed and no relay is
  // delivered twice.
  private tokenChain: Promise<unknown> = Promise.resolve()
  private syncChain: Promise<unknown> = Promise.resolve()

  private serialize<T>(chain: 'tokenChain' | 'syncChain', task: () => Promise<T>): Promise<T> {
    const run = this[chain].then(task, task)
    this[chain] = run.catch(() => undefined)
    return run
  }

  // ---------------------------------------------------------------- storage

  private async tokens(): Promise<TokenSet | null> {
    const sealed = await this.ctx.storage.get<string>('tokens')
    return sealed ? (JSON.parse(await unseal(sealed, this.env.TOKEN_KEY, 'tokens')) as TokenSet) : null
  }

  private async saveTokens(tokens: TokenSet): Promise<void> {
    await this.ctx.storage.put('tokens', await seal(JSON.stringify(tokens), this.env.TOKEN_KEY, 'tokens'))
  }

  private async profile(): Promise<Profile> {
    const p = await this.ctx.storage.get<Profile>('profile')
    if (!p) throw new NotConnectedError('Not connected to Buffer')
    return p
  }

  private async list<T>(key: string): Promise<T[]> {
    return (await this.ctx.storage.get<T[]>(key)) ?? []
  }

  private oauthConfig(): OAuthConfig {
    return {
      clientId: this.env.BUFFER_CLIENT_ID,
      clientSecret: this.env.BUFFER_CLIENT_SECRET,
      redirectUri: this.env.REDIRECT_URI.trim(),
      scopes: this.env.BUFFER_SCOPES,
    }
  }

  // ------------------------------------------------------------ Buffer calls

  private accessToken(): Promise<string> {
    return this.serialize('tokenChain', async () => {
      const tokens = await this.tokens()
      if (!tokens) throw new NotConnectedError('Not connected to Buffer')
      if (Date.now() < tokens.expiresAt) return tokens.accessToken
      try {
        const next = await refresh(this.oauthConfig(), tokens.refreshToken)
        await this.saveTokens(next)
        return next.accessToken
      } catch (err) {
        // Only a rejected grant ends the connection. A Buffer outage or a 429
        // keeps the tokens so the next attempt can still refresh.
        if (err instanceof OAuthError && err.code === 'invalid_grant') {
          await this.ctx.storage.delete('tokens')
          throw new NotConnectedError('Your Buffer connection expired. Connect again.')
        }
        throw err
      }
    })
  }

  private async guardQuota(kind: CallKind): Promise<void> {
    if (kind === 'background') return
    const log = await this.ctx.storage.get<CallLog>('calls')
    const low = log?.rateLimit.find((w) => w.remaining < RATE_RESERVE)
    if (low) {
      throw new Error(`Relaypost is close to Buffer's shared rate limit. Scheduled relays keep working; try again in ${Math.ceil(low.resetSeconds / 60)} min.`)
    }
  }

  private async call<T>(query: string, variables: Record<string, unknown>, kind: CallKind): Promise<T> {
    await this.guardQuota(kind)
    const token = await this.accessToken()
    try {
      const result = await graphql<T>(token, query, variables)
      const log = (await this.ctx.storage.get<CallLog>('calls')) ?? { count: 0, rateLimit: [] }
      await this.ctx.storage.put('calls', { count: log.count + 1, rateLimit: result.rateLimit.length ? result.rateLimit : log.rateLimit })
      return result.data
    } catch (err) {
      if (err instanceof BufferApiError && err.status === 401) {
        await this.ctx.storage.delete('tokens')
        throw new NotConnectedError('Buffer no longer accepts this connection. Connect again.')
      }
      throw err
    }
  }

  // ------------------------------------------------------------- lifecycle

  async link(tokens: TokenSet, account: BufferAccount): Promise<void> {
    const organizationId = account.organizations[0]?.id
    if (!organizationId) throw new Error('This Buffer account has no organization')
    await this.saveTokens(tokens)
    const prior = await this.ctx.storage.get<Profile>('profile')
    await this.ctx.storage.put('profile', { account, organizationId: prior?.organizationId ?? organizationId })
    await this.ctx.storage.put('lastSeenAt', Date.now())
    await this.schedule()
  }

  async disconnect(): Promise<void> {
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
  }

  async state() {
    const profile = await this.profile()
    await this.ctx.storage.put('lastSeenAt', Date.now())
    const destinations = await this.list<StoredDestination>('destinations')
    const pending = await this.ctx.storage.get<PendingTelegram>('pendingTelegram')
    return {
      account: { name: profile.account.name, avatar: profile.account.avatar },
      organizationId: profile.organizationId,
      connected: (await this.tokens()) !== null,
      destinations: destinations.map(({ id, kind, label, createdAt }) => ({ id, kind, label, createdAt })),
      pendingTelegram: pending && pending.expiresAt > Date.now() ? pending : null,
      rules: await this.list<Rule>('rules'),
      relays: [...(await this.list<Relay>('relays'))].sort((a, b) => b.dueAt - a.dueAt).slice(0, 60),
      lastSyncAt: (await this.ctx.storage.get<number>('lastSyncAt')) ?? null,
      calls: (await this.ctx.storage.get<CallLog>('calls')) ?? { count: 0, rateLimit: [] },
    }
  }

  // ------------------------------------------------------------- Buffer data

  async channels(): Promise<BufferChannel[]> {
    const cached = await this.ctx.storage.get<{ at: number; channels: BufferChannel[] }>('channelCache')
    if (cached && Date.now() - cached.at < CHANNEL_CACHE_MS) return cached.channels
    const { organizationId } = await this.profile()
    const data = await this.call<{ channels: BufferChannel[] }>(CHANNELS_QUERY, { organizationId }, 'interactive')
    await this.ctx.storage.put('channelCache', { at: Date.now(), channels: data.channels })
    return data.channels
  }

  // What the UI shows: scheduled posts for the next two weeks, cached a minute.
  async queue(): Promise<BufferPost[]> {
    const cached = await this.ctx.storage.get<{ at: number; posts: BufferPost[] }>('queueCache')
    if (cached && Date.now() - cached.at < QUEUE_CACHE_MS) return cached.posts
    const { organizationId } = await this.profile()
    const now = Date.now()
    const { posts } = await this.fetchPosts(
      organizationId,
      { status: QUEUE_STATUSES, dueAt: { start: new Date(now).toISOString(), end: new Date(now + SYNC_AHEAD_MS).toISOString() } },
      'interactive',
    )
    await this.ctx.storage.put('queueCache', { at: now, posts })
    return posts
  }

  private async fetchPosts(organizationId: string, filter: Record<string, unknown>, kind: CallKind): Promise<{ posts: BufferPost[]; truncated: boolean }> {
    type Page = { posts: { edges: { node: BufferPost }[] | null; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
    const posts: BufferPost[] = []
    let after: string | null = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const data: Page = await this.call<Page>(POSTS_QUERY, { organizationId, filter, first: 100, after }, kind)
      posts.push(...(data.posts.edges ?? []).map((e) => e.node))
      if (!data.posts.pageInfo.hasNextPage) return { posts, truncated: false }
      after = data.posts.pageInfo.endCursor
    }
    return { posts, truncated: true }
  }

  private async ensureTag(name: string): Promise<BufferTag> {
    const { organizationId } = await this.profile()
    const data = await this.call<{ tagsV2: { edges: { node: BufferTag }[] } }>(TAGS_QUERY, { organizationId }, 'interactive')
    const existing = data.tagsV2.edges.map((e) => e.node).find((t) => t.name.toLowerCase() === name.toLowerCase())
    if (existing) return existing
    const created = await this.call<{ createTag: { tag?: BufferTag; message?: string } }>(CREATE_TAG_MUTATION, { organizationId, name, color: RELAY_TAG_COLOR }, 'interactive')
    if (!created.createTag.tag) throw new Error(created.createTag.message ?? 'Buffer could not create the tag')
    return created.createTag.tag
  }

  // ------------------------------------------------------------ destinations

  async addDiscord(label: string, webhookUrl: string): Promise<{ id: string }> {
    const url = webhookUrl.trim()
    if (!isDiscordWebhook(url)) throw new Error('That is not a Discord webhook URL')
    await this.assertRoomForDestination()
    const test = await sendDiscord(url, { content: 'Relaypost is connected. Posts you route here will show up in this channel.', allowed_mentions: { parse: [] } })
    if (!test.ok) throw new Error(`Discord did not accept the test message (${test.detail})`)
    return this.storeDestination('discord', label || 'Discord', url)
  }

  // Step 1 of linking a Telegram channel: a one-time code the user posts in the
  // channel after adding the bot as admin. The Worker's webhook does step 2.
  async startTelegram(label: string): Promise<PendingTelegram> {
    await this.profile()
    await this.assertRoomForDestination()
    const code = `RP-${randomToken(6).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8).padEnd(8, '7')}`
    const pending: PendingTelegram = { code, label: label.slice(0, 60) || 'Telegram', expiresAt: Date.now() + TELEGRAM_CODE_TTL_MS }
    await this.ctx.storage.put('pendingTelegram', pending)
    return pending
  }

  async finishTelegram(code: string, chatId: string, title: string): Promise<boolean> {
    const pending = await this.ctx.storage.get<PendingTelegram>('pendingTelegram')
    if (!pending || pending.code !== code || pending.expiresAt < Date.now()) return false
    await this.ctx.storage.delete('pendingTelegram')
    await this.storeDestination('telegram', pending.label === 'Telegram' && title ? title : pending.label, chatId)
    return true
  }

  private async assertRoomForDestination(): Promise<void> {
    if ((await this.list<StoredDestination>('destinations')).length >= MAX_DESTINATIONS) {
      throw new Error(`Up to ${MAX_DESTINATIONS} destinations per account`)
    }
  }

  private async storeDestination(kind: DestinationKind, label: string, target: string): Promise<{ id: string }> {
    const destinations = await this.list<StoredDestination>('destinations')
    const id = `d_${randomToken(6)}`
    const entry: StoredDestination = { id, kind, label: label.slice(0, 60), sealedTarget: await seal(target, this.env.TOKEN_KEY, 'destination'), createdAt: Date.now() }
    await this.ctx.storage.put('destinations', [...destinations, entry])
    return { id }
  }

  async removeDestination(id: string): Promise<void> {
    await this.ctx.storage.put('destinations', (await this.list<StoredDestination>('destinations')).filter((d) => d.id !== id))
    await this.ctx.storage.put('rules', (await this.list<Rule>('rules')).filter((r) => r.destinationId !== id))
  }

  // ------------------------------------------------------------------ rules

  async addRule(destinationId: string, match: { kind: 'tag'; tagName: string } | { kind: 'channel'; channelId: string }): Promise<Rule> {
    if (!(await this.list<StoredDestination>('destinations')).some((d) => d.id === destinationId)) throw new Error('Unknown destination')
    const rules = await this.list<Rule>('rules')
    if (rules.length >= MAX_RULES) throw new Error(`Up to ${MAX_RULES} rules per account`)
    let resolved: RuleMatch
    if (match.kind === 'tag') {
      const tag = await this.ensureTag(match.tagName.trim().slice(0, 40))
      resolved = { kind: 'tag', tagId: tag.id, tagName: tag.name }
    } else {
      if (!(await this.channels()).some((c) => c.id === match.channelId)) throw new Error('Unknown Buffer channel')
      resolved = match
    }
    const duplicate = rules.find((r) => r.destinationId === destinationId && JSON.stringify(r.match) === JSON.stringify(resolved))
    if (duplicate) return duplicate
    const rule: Rule = { id: `r_${randomToken(6)}`, destinationId, match: resolved }
    await this.ctx.storage.put('rules', [...rules, rule])
    await this.sync('interactive')
    return rule
  }

  async removeRule(id: string): Promise<void> {
    await this.ctx.storage.put('rules', (await this.list<Rule>('rules')).filter((r) => r.id !== id))
    await this.sync('interactive')
  }

  // Toggle a tag on one post from the queue view: adds or removes the tag in Buffer.
  async setPostTag(postId: string, tagId: string, on: boolean): Promise<BufferPost> {
    const post = (await this.queue()).find((p) => p.id === postId)
    if (!post) throw new Error('That post is no longer in your Buffer queue')
    const data = await this.call<{ editPost: { post?: BufferPost; message?: string } }>(SET_POST_TAGS_MUTATION, tagEditVariables(post, tagId, on), 'interactive')
    if (!data.editPost.post) throw new Error(data.editPost.message ?? 'Buffer could not update the post')
    await this.ctx.storage.delete('queueCache')
    await this.sync('interactive')
    return data.editPost.post
  }

  // ----------------------------------------------------------- sync + relay

  async manualSync(): Promise<{ syncedAt: number }> {
    const last = (await this.ctx.storage.get<number>('lastSyncAt')) ?? 0
    if (Date.now() - last < MANUAL_SYNC_COOLDOWN_MS) return { syncedAt: last }
    await this.sync('interactive')
    return { syncedAt: Date.now() }
  }

  private sync(kind: CallKind): Promise<void> {
    return this.serialize('syncChain', async () => {
      const rules = await this.list<Rule>('rules')
      const now = Date.now()
      const window = { start: now - SYNC_BACK_MS, end: now + SYNC_AHEAD_MS }
      const posts: BufferPost[] = []
      let truncated = false
      if (rules.length) {
        const { organizationId } = await this.profile()
        const tagIds = [...new Set(rules.flatMap((r) => (r.match.kind === 'tag' ? [r.match.tagId] : [])))]
        const channelIds = [...new Set(rules.flatMap((r) => (r.match.kind === 'channel' ? [r.match.channelId] : [])))]
        for (const filter of syncFilters(window, SYNC_STATUSES, tagIds, channelIds)) {
          const page = await this.fetchPosts(organizationId, filter, kind)
          posts.push(...page.posts)
          truncated ||= page.truncated
        }
      }
      const unique = [...new Map(posts.map((p) => [p.id, p])).values()]
      // A truncated read cannot prove a post is gone, so nothing is skipped on it.
      const covered = truncated ? { start: 1, end: 0 } : window
      const relays = prune(reconcile(await this.list<Relay>('relays'), unique, rules, covered), now)
      await this.ctx.storage.put('relays', relays)
      await this.ctx.storage.put('lastSyncAt', now)
      await this.processDue(unique, now)
    })
  }

  private async processDue(posts: BufferPost[], now: number): Promise<void> {
    const byId = new Map(posts.map((p) => [p.id, p]))
    const destinations = new Map((await this.list<StoredDestination>('destinations')).map((d) => [d.id, d]))
    const relays = await this.list<Relay>('relays')
    for (let i = 0; i < relays.length; i++) {
      const relay = relays[i]!
      if (relay.status !== 'waiting' || relay.checkAt > now) continue
      const post = byId.get(relay.postId)
      const decision = decide(post, relay, now)
      let next: Relay
      if (decision.action === 'wait') next = { ...relay, checkAt: decision.checkAt }
      else if (decision.action === 'fail') next = { ...relay, status: 'failed', detail: decision.detail }
      else if (decision.action === 'skip') next = { ...relay, status: 'skipped', detail: decision.detail }
      else {
        try {
          next = await this.deliver(relay, post!, destinations.get(relay.destinationId), now)
        } catch {
          next = { ...relay, status: 'failed', detail: 'Relaypost could not read this destination; connect it again' }
        }
      }
      relays[i] = next
      // Saved after every relay: a crash later in the loop cannot resend this one.
      await this.ctx.storage.put('relays', relays)
    }
    await this.schedule()
  }

  private async deliver(relay: Relay, post: BufferPost, destination: StoredDestination | undefined, now: number): Promise<Relay> {
    if (!destination) return { ...relay, status: 'skipped', detail: 'The destination was removed' }
    const target = await unseal(destination.sealedTarget, this.env.TOKEN_KEY, 'destination')
    const result: DeliveryResult =
      destination.kind === 'discord' ? await sendDiscord(target, discordPayload(post)) : await sendTelegram(this.env.TELEGRAM_BOT_TOKEN, target, post)
    const attempts = relay.attempts + 1
    if (result.ok) return { ...relay, status: 'delivered', attempts, detail: result.detail, externalLink: post.externalLink, deliveredAt: now }
    if (result.retryable && attempts < MAX_DELIVERY_ATTEMPTS) return { ...relay, attempts, detail: result.detail, checkAt: now + RETRY_DELAY_MS }
    return { ...relay, status: 'failed', attempts, detail: result.detail }
  }

  private async schedule(): Promise<void> {
    const now = Date.now()
    const lastSeen = (await this.ctx.storage.get<number>('lastSeenAt')) ?? now
    // Accounts nobody has opened in two weeks stop periodic polling; anything
    // already waiting still gets delivered.
    const poll = (await this.list<Rule>('rules')).length > 0 && now - lastSeen < IDLE_AFTER_MS
    const at = nextAlarm(await this.list<Relay>('relays'), (await this.ctx.storage.get<number>('lastSyncAt')) ?? now, poll)
    if (at === null) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(Math.max(at, now + 1_000))
  }

  async alarm(): Promise<void> {
    if (!(await this.tokens())) return
    try {
      await this.sync('background')
    } catch (err) {
      if (err instanceof NotConnectedError) return
      const retryAfter = err instanceof BufferApiError && err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : RETRY_DELAY_MS
      console.error(JSON.stringify({ event: 'alarm_failed', message: err instanceof Error ? err.message : String(err) }))
      await this.ctx.storage.setAlarm(Date.now() + Math.max(retryAfter, RETRY_DELAY_MS))
    }
  }
}
