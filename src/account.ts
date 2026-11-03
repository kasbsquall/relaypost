// One Durable Object per Buffer account. It is the only place that refreshes the
// account's rotating refresh token, and its alarm wakes up when a post is due.

import { DurableObject } from 'cloudflare:workers'
import { BufferApiError, graphql, type RateWindow } from './buffer/graphql'
import { OAuthError, refresh, type OAuthConfig, type TokenSet } from './buffer/oauth'
import {
  ACCOUNT_QUERY,
  CHANNELS_QUERY,
  CREATE_TAG_MUTATION,
  POSTS_QUERY,
  SET_POST_TAGS_MUTATION,
  TAGS_QUERY,
  type BufferAccount,
  type BufferChannel,
  type BufferPost,
  type BufferTag,
} from './buffer/queries'
import type { Env } from './env'
import { randomToken, seal, unseal } from './lib/crypto'
import { discordPayload, isDiscordWebhook, sendDiscord, sendTelegram, telegramCall, type DeliveryResult } from './relay/deliver'
import {
  MAX_DELIVERY_ATTEMPTS,
  RETRY_DELAY_MS,
  decide,
  nextAlarm,
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

export interface CallLog {
  count: number
  rateLimit: RateWindow[]
}

const SYNC_BACK_MS = 2 * 3_600_000
const SYNC_AHEAD_MS = 14 * 86_400_000
const CHANNEL_CACHE_MS = 10 * 60_000
const MAX_RELAYS_KEPT = 300
const SYNC_STATUSES = ['scheduled', 'sending', 'sent', 'error', 'needs_approval']
const RELAY_TAG_COLOR = '#2F6B4F'

export class NotConnectedError extends Error {}

export class AccountDO extends DurableObject<Env> {
  private refreshing: Promise<string> | null = null

  // ---------------------------------------------------------------- storage

  private async tokens(): Promise<TokenSet | null> {
    const sealed = await this.ctx.storage.get<string>('tokens')
    return sealed ? (JSON.parse(await unseal(sealed, this.env.TOKEN_KEY)) as TokenSet) : null
  }

  private async saveTokens(tokens: TokenSet): Promise<void> {
    await this.ctx.storage.put('tokens', await seal(JSON.stringify(tokens), this.env.TOKEN_KEY))
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
      redirectUri: this.env.REDIRECT_URI,
      scopes: this.env.BUFFER_SCOPES,
    }
  }

  // ------------------------------------------------------------ Buffer calls

  private async accessToken(): Promise<string> {
    const tokens = await this.tokens()
    if (!tokens) throw new NotConnectedError('Not connected to Buffer')
    if (Date.now() < tokens.expiresAt) return tokens.accessToken
    // Requests can interleave while a fetch is in flight; they all wait on the
    // same refresh so a spent refresh token is never replayed.
    this.refreshing ??= (async () => {
      try {
        const next = await refresh(this.oauthConfig(), tokens.refreshToken)
        await this.saveTokens(next)
        return next.accessToken
      } catch (err) {
        if (err instanceof OAuthError) {
          await this.ctx.storage.delete('tokens')
          throw new NotConnectedError('Your Buffer connection expired. Connect again.')
        }
        throw err
      } finally {
        this.refreshing = null
      }
    })()
    return this.refreshing
  }

  private async call<T>(query: string, variables: Record<string, unknown>): Promise<T> {
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
  }

  async disconnect(): Promise<void> {
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
  }

  async state() {
    const profile = await this.profile()
    const destinations = await this.list<StoredDestination>('destinations')
    const relays = await this.list<Relay>('relays')
    return {
      account: { name: profile.account.name, email: profile.account.email, avatar: profile.account.avatar },
      organizationId: profile.organizationId,
      connected: (await this.tokens()) !== null,
      destinations: destinations.map(({ id, kind, label, createdAt }) => ({ id, kind, label, createdAt })),
      rules: await this.list<Rule>('rules'),
      relays: [...relays].sort((a, b) => b.dueAt - a.dueAt).slice(0, 60),
      lastSyncAt: (await this.ctx.storage.get<number>('lastSyncAt')) ?? null,
      calls: (await this.ctx.storage.get<CallLog>('calls')) ?? { count: 0, rateLimit: [] },
    }
  }

  // ------------------------------------------------------------- Buffer data

  async channels(): Promise<BufferChannel[]> {
    const cached = await this.ctx.storage.get<{ at: number; channels: BufferChannel[] }>('channelCache')
    if (cached && Date.now() - cached.at < CHANNEL_CACHE_MS) return cached.channels
    const { organizationId } = await this.profile()
    const data = await this.call<{ channels: BufferChannel[] }>(CHANNELS_QUERY, { organizationId })
    await this.ctx.storage.put('channelCache', { at: Date.now(), channels: data.channels })
    return data.channels
  }

  // The queue the UI shows: what is scheduled in the next two weeks.
  async queue(): Promise<BufferPost[]> {
    const { organizationId } = await this.profile()
    const now = Date.now()
    return this.fetchPosts(organizationId, { status: ['scheduled', 'needs_approval'], dueAt: { start: new Date(now).toISOString(), end: new Date(now + SYNC_AHEAD_MS).toISOString() } })
  }

  private async fetchPosts(organizationId: string, filter: Record<string, unknown>): Promise<BufferPost[]> {
    type Page = { posts: { edges: { node: BufferPost }[] | null; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
    const posts: BufferPost[] = []
    let after: string | null = null
    for (let page = 0; page < 3; page++) {
      const data: Page = await this.call<Page>(POSTS_QUERY, { organizationId, filter, first: 100, after })
      posts.push(...(data.posts.edges ?? []).map((e) => e.node))
      if (!data.posts.pageInfo.hasNextPage) break
      after = data.posts.pageInfo.endCursor
    }
    return posts
  }

  private async ensureTag(name: string): Promise<BufferTag> {
    const { organizationId } = await this.profile()
    const data = await this.call<{ tagsV2: { edges: { node: BufferTag }[] } }>(TAGS_QUERY, { organizationId })
    const existing = data.tagsV2.edges.map((e) => e.node).find((t) => t.name.toLowerCase() === name.toLowerCase())
    if (existing) return existing
    const created = await this.call<{ createTag: { tag?: BufferTag; message?: string } }>(CREATE_TAG_MUTATION, { organizationId, name, color: RELAY_TAG_COLOR })
    if (!created.createTag.tag) throw new Error(created.createTag.message ?? 'Buffer could not create the tag')
    return created.createTag.tag
  }

  // ------------------------------------------------------------ destinations

  async addDiscord(label: string, webhookUrl: string): Promise<{ id: string }> {
    const url = webhookUrl.trim()
    if (!isDiscordWebhook(url)) throw new Error('That is not a Discord webhook URL')
    const test = await sendDiscord(url, { content: 'Relaypost is connected. Posts you route here will show up in this channel.', allowed_mentions: { parse: [] } })
    if (!test.ok) throw new Error(`Discord did not accept the test message (${test.detail})`)
    return this.storeDestination('discord', label || 'Discord', url)
  }

  // Public channels: the bot must already be an admin; we prove it by posting.
  async addTelegram(label: string, channel: string): Promise<{ id: string }> {
    const chatId = channel.trim()
    if (!/^@[A-Za-z0-9_]{5,32}$/.test(chatId) && !/^-100\d{6,}$/.test(chatId)) {
      throw new Error('Use the channel @username, for example @mybrandnews')
    }
    const test = await telegramCall(this.env.TELEGRAM_BOT_TOKEN, 'sendMessage', { chat_id: chatId, text: 'Relaypost is connected to this channel.' })
    if (!test.ok) throw new Error(`Telegram refused the test message: ${test.description ?? 'unknown error'}. Is the bot an admin of the channel?`)
    return this.storeDestination('telegram', label || chatId, chatId)
  }

  private async storeDestination(kind: DestinationKind, label: string, target: string): Promise<{ id: string }> {
    const destinations = await this.list<StoredDestination>('destinations')
    const id = `d_${randomToken(6)}`
    const entry: StoredDestination = { id, kind, label: label.slice(0, 60), sealedTarget: await seal(target, this.env.TOKEN_KEY), createdAt: Date.now() }
    await this.ctx.storage.put('destinations', [...destinations, entry])
    return { id }
  }

  async removeDestination(id: string): Promise<void> {
    const destinations = await this.list<StoredDestination>('destinations')
    const rules = await this.list<Rule>('rules')
    await this.ctx.storage.put('destinations', destinations.filter((d) => d.id !== id))
    await this.ctx.storage.put('rules', rules.filter((r) => r.destinationId !== id))
  }

  // ------------------------------------------------------------------ rules

  async addRule(destinationId: string, match: { kind: 'tag'; tagName: string } | { kind: 'channel'; channelId: string }): Promise<Rule> {
    const destinations = await this.list<StoredDestination>('destinations')
    if (!destinations.some((d) => d.id === destinationId)) throw new Error('Unknown destination')
    let resolved: RuleMatch
    if (match.kind === 'tag') {
      const tag = await this.ensureTag(match.tagName.trim().slice(0, 40))
      resolved = { kind: 'tag', tagId: tag.id, tagName: tag.name }
    } else {
      const channels = await this.channels()
      if (!channels.some((c) => c.id === match.channelId)) throw new Error('Unknown Buffer channel')
      resolved = match
    }
    const rules = await this.list<Rule>('rules')
    const duplicate = rules.find((r) => r.destinationId === destinationId && JSON.stringify(r.match) === JSON.stringify(resolved))
    if (duplicate) return duplicate
    const rule: Rule = { id: `r_${randomToken(6)}`, destinationId, match: resolved }
    await this.ctx.storage.put('rules', [...rules, rule])
    await this.sync()
    return rule
  }

  async removeRule(id: string): Promise<void> {
    await this.ctx.storage.put('rules', (await this.list<Rule>('rules')).filter((r) => r.id !== id))
    await this.sync()
  }

  // Toggle a tag rule on one post from the queue view: adds or removes the tag in Buffer.
  async setPostTag(postId: string, tagId: string, on: boolean, currentTagIds: string[]): Promise<BufferPost> {
    const tagIds = on ? [...new Set([...currentTagIds, tagId])] : currentTagIds.filter((id) => id !== tagId)
    const data = await this.call<{ editPost: { post?: BufferPost; message?: string } }>(SET_POST_TAGS_MUTATION, { id: postId, tagIds })
    if (!data.editPost.post) throw new Error(data.editPost.message ?? 'Buffer could not update the post')
    await this.sync()
    return data.editPost.post
  }

  // ----------------------------------------------------------- sync + relay

  async sync(): Promise<{ posts: BufferPost[] }> {
    const rules = await this.list<Rule>('rules')
    const now = Date.now()
    const window = { start: now - SYNC_BACK_MS, end: now + SYNC_AHEAD_MS }
    const posts: BufferPost[] = []
    if (rules.length) {
      const { organizationId } = await this.profile()
      const base = { status: SYNC_STATUSES, dueAt: { start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString() } }
      const tagIds = [...new Set(rules.flatMap((r) => (r.match.kind === 'tag' ? [r.match.tagId] : [])))]
      const channelIds = [...new Set(rules.flatMap((r) => (r.match.kind === 'channel' ? [r.match.channelId] : [])))]
      if (tagIds.length) posts.push(...(await this.fetchPosts(organizationId, { ...base, tagIds })))
      if (channelIds.length) posts.push(...(await this.fetchPosts(organizationId, { ...base, channelIds })))
    }
    const unique = [...new Map(posts.map((p) => [p.id, p])).values()]
    const relays = reconcile(await this.list<Relay>('relays'), unique, rules, window)
    await this.ctx.storage.put('relays', relays.sort((a, b) => b.dueAt - a.dueAt).slice(0, MAX_RELAYS_KEPT))
    await this.ctx.storage.put('lastSyncAt', now)
    await this.processDue(unique, now)
    return { posts: unique }
  }

  private async processDue(posts: BufferPost[], now: number): Promise<void> {
    const byId = new Map(posts.map((p) => [p.id, p]))
    const destinations = new Map((await this.list<StoredDestination>('destinations')).map((d) => [d.id, d]))
    const relays = await this.list<Relay>('relays')
    const updated: Relay[] = []
    for (const relay of relays) {
      if (relay.status !== 'waiting' || relay.checkAt > now) {
        updated.push(relay)
        continue
      }
      const post = byId.get(relay.postId)
      const decision = decide(post, relay, now)
      if (decision.action === 'wait') updated.push({ ...relay, checkAt: decision.checkAt })
      else if (decision.action === 'fail') updated.push({ ...relay, status: 'failed', detail: decision.detail })
      else if (decision.action === 'skip') updated.push({ ...relay, status: 'skipped', detail: decision.detail })
      else updated.push(await this.deliver(relay, post!, destinations.get(relay.destinationId), now))
    }
    await this.ctx.storage.put('relays', updated)
    await this.schedule()
  }

  private async deliver(relay: Relay, post: BufferPost, destination: StoredDestination | undefined, now: number): Promise<Relay> {
    if (!destination) return { ...relay, status: 'skipped', detail: 'The destination was removed' }
    const target = await unseal(destination.sealedTarget, this.env.TOKEN_KEY)
    const result: DeliveryResult =
      destination.kind === 'discord' ? await sendDiscord(target, discordPayload(post)) : await sendTelegram(this.env.TELEGRAM_BOT_TOKEN, target, post)
    const attempts = relay.attempts + 1
    if (result.ok) return { ...relay, status: 'delivered', attempts, detail: result.detail, externalLink: post.externalLink, deliveredAt: now }
    if (result.retryable && attempts < MAX_DELIVERY_ATTEMPTS) return { ...relay, attempts, detail: result.detail, checkAt: now + RETRY_DELAY_MS }
    return { ...relay, status: 'failed', attempts, detail: result.detail }
  }

  private async schedule(): Promise<void> {
    const at = nextAlarm(await this.list<Relay>('relays'), (await this.ctx.storage.get<number>('lastSyncAt')) ?? Date.now(), (await this.list<Rule>('rules')).length > 0)
    if (at === null) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(Math.max(at, Date.now() + 1_000))
  }

  async alarm(): Promise<void> {
    if (!(await this.tokens())) return
    try {
      await this.sync()
    } catch (err) {
      // Keep the loop alive through transient Buffer or network trouble.
      if (err instanceof NotConnectedError) return
      console.error(JSON.stringify({ event: 'alarm_failed', message: err instanceof Error ? err.message : String(err) }))
      await this.ctx.storage.setAlarm(Date.now() + RETRY_DELAY_MS)
    }
  }

  async account(): Promise<BufferAccount> {
    const data = await this.call<{ account: BufferAccount }>(ACCOUNT_QUERY, {})
    return data.account
  }
}

