// Turning a sent Buffer post into a Discord or Telegram message.

import type { BufferPost } from '../buffer/queries'

const SERVICE_NAMES: Record<string, string> = {
  bluesky: 'Bluesky',
  facebook: 'Facebook',
  googlebusiness: 'Google Business Profile',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  mastodon: 'Mastodon',
  pinterest: 'Pinterest',
  startPage: 'Start Page',
  substack: 'Substack',
  threads: 'Threads',
  tiktok: 'TikTok',
  twitter: 'X',
  whatsapp: 'WhatsApp',
  youtube: 'YouTube',
}

export function serviceName(service: string): string {
  return SERVICE_NAMES[service] ?? service
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

export function firstImage(post: BufferPost): string | null {
  const image = post.assets.find((a) => a.type === 'image')
  return image?.source ?? null
}

export interface DeliveryResult {
  ok: boolean
  detail: string
  // Retrying makes sense for network trouble and 5xx/429, never for 4xx.
  retryable: boolean
  // Where the delivered message can be opened, when the destination tells us.
  link?: string | null
  // Discord answers with the message and channel ids; the server id comes from the webhook itself.
  discordMessage?: { id: string; channelId: string }
}

// --- Discord: incoming webhooks (https://discord.com/developers/docs/resources/webhook#execute-webhook)

const DISCORD_WEBHOOK = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/

export function isDiscordWebhook(url: string): boolean {
  return DISCORD_WEBHOOK.test(url.trim())
}

export function discordPayload(post: BufferPost): Record<string, unknown> {
  const image = firstImage(post)
  const embed: Record<string, unknown> = {
    description: clip(post.text, 4000),
    color: 0xb14328,
    footer: { text: `Also on ${serviceName(post.channelService)} · relayed by Relaypost` },
  }
  if (post.externalLink) {
    embed.title = `Open on ${serviceName(post.channelService)}`
    embed.url = post.externalLink
  }
  if (post.sentAt) embed.timestamp = post.sentAt
  if (image) embed.image = { url: image }
  return { embeds: [embed], allowed_mentions: { parse: [] } }
}

export async function sendDiscord(webhookUrl: string, payload: Record<string, unknown>, fetcher: typeof fetch = fetch): Promise<DeliveryResult> {
  try {
    const res = await fetcher(`${webhookUrl}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.ok) {
      const message = (await res.json().catch(() => ({}))) as { id?: string; channel_id?: string }
      const discordMessage = message.id && message.channel_id ? { id: message.id, channelId: message.channel_id } : undefined
      return { ok: true, detail: 'Posted to Discord', retryable: false, discordMessage }
    }
    return { ok: false, detail: `Discord answered HTTP ${res.status}`, retryable: res.status === 429 || res.status >= 500 }
  } catch {
    return { ok: false, detail: 'Could not reach Discord', retryable: true }
  }
}

// GET on a webhook URL returns the webhook object, which carries the server id.
export async function discordGuildId(webhookUrl: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetcher(webhookUrl)
    if (!res.ok) return null
    const hook = (await res.json()) as { guild_id?: string }
    return hook.guild_id ?? null
  } catch {
    return null
  }
}

export function discordMessageLink(guildId: string | null | undefined, message: { id: string; channelId: string } | undefined): string | null {
  return guildId && message ? `https://discord.com/channels/${guildId}/${message.channelId}/${message.id}` : null
}

// --- Telegram: Bot API (https://core.telegram.org/bots/api)

const TELEGRAM_CAPTION_MAX = 1024
const TELEGRAM_TEXT_MAX = 4096

export function telegramMessage(post: BufferPost): { method: 'sendPhoto' | 'sendMessage'; body: Record<string, unknown> } {
  const link = post.externalLink ? `\n\nAlso on ${serviceName(post.channelService)}: ${post.externalLink}` : ''
  const image = firstImage(post)
  if (image) {
    return { method: 'sendPhoto', body: { photo: image, caption: clip(post.text, TELEGRAM_CAPTION_MAX - link.length) + link } }
  }
  return { method: 'sendMessage', body: { text: clip(post.text, TELEGRAM_TEXT_MAX - link.length) + link } }
}

export async function telegramCall(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; result?: unknown; description?: string }> {
  const res = await fetcher(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string }
  return { ok: Boolean(json.ok), status: res.status, result: json.result, description: json.description }
}

// Only public channels have a username, and only those have a link anyone can open.
export function telegramLink(result: unknown): string | null {
  const m = result as { message_id?: number; chat?: { username?: string } } | undefined
  return m?.message_id && m.chat?.username ? `https://t.me/${m.chat.username}/${m.message_id}` : null
}

export async function sendTelegram(
  botToken: string,
  chatId: string,
  post: BufferPost,
  fetcher: typeof fetch = fetch,
): Promise<DeliveryResult> {
  const message = telegramMessage(post)
  try {
    const first = await telegramCall(botToken, message.method, { chat_id: chatId, ...message.body }, fetcher)
    if (first.ok) return { ok: true, detail: 'Posted to Telegram', retryable: false, link: telegramLink(first.result) }
    // Telegram fetches the photo itself; if the host refuses it, fall back to text with the link.
    if (message.method === 'sendPhoto') {
      const text = telegramMessage({ ...post, assets: [] })
      const second = await telegramCall(botToken, text.method, { chat_id: chatId, ...text.body }, fetcher)
      if (second.ok) return { ok: true, detail: 'Posted to Telegram (text only, the image could not be fetched)', retryable: false, link: telegramLink(second.result) }
    }
    return {
      ok: false,
      detail: `Telegram refused it: ${first.description ?? `HTTP ${first.status}`}`,
      retryable: first.status === 429 || first.status >= 500,
    }
  } catch {
    return { ok: false, detail: 'Could not reach Telegram', retryable: true }
  }
}

// --- Slack: incoming webhooks (https://api.slack.com/messaging/webhooks)

const SLACK_WEBHOOK = /^https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+$/
const SLACK_SECTION_MAX = 3000

export function isSlackWebhook(url: string): boolean {
  return SLACK_WEBHOOK.test(url.trim())
}

// Slack reads <, > and & as control characters (links, @channel); escaping them keeps the post as plain text.
function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function slackPayload(post: BufferPost): Record<string, unknown> {
  const service = serviceName(post.channelService)
  const text = clip(slackEscape(post.text), SLACK_SECTION_MAX)
  const blocks: Record<string, unknown>[] = [{ type: 'section', text: { type: 'mrkdwn', text, verbatim: true } }]
  const image = firstImage(post)
  if (image) blocks.push({ type: 'image', image_url: image, alt_text: `Image from the ${service} post` })
  const footer = post.externalLink ? `Also on <${post.externalLink}|${service}> · relayed by Relaypost` : `Also on ${service} · relayed by Relaypost`
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: footer }] })
  return { text: clip(slackEscape(post.text), 280), blocks, unfurl_links: false, unfurl_media: false }
}

export async function sendSlack(webhookUrl: string, payload: Record<string, unknown>, fetcher: typeof fetch = fetch): Promise<DeliveryResult> {
  try {
    const res = await fetcher(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.ok) return { ok: true, detail: 'Posted to Slack', retryable: false }
    const reason = (await res.text().catch(() => '')).slice(0, 60)
    return { ok: false, detail: `Slack answered HTTP ${res.status}${reason ? ` (${reason})` : ''}`, retryable: res.status === 429 || res.status >= 500 }
  } catch {
    return { ok: false, detail: 'Could not reach Slack', retryable: true }
  }
}

// --- Notices: a short plain-text heads-up to the channel the user picked.

export type NoticeKind = 'discord' | 'telegram' | 'slack'

// A notice never holds up a handoff for long: a destination that hangs is given up on.
export const NOTICE_TIMEOUT_MS = 5000

export async function sendNotice(
  kind: NoticeKind,
  target: string,
  text: string,
  botToken: string,
  fetcher: typeof fetch = fetch,
): Promise<DeliveryResult> {
  const timed = ((input: RequestInfo | URL, init?: RequestInit) => fetcher(input, { ...init, signal: AbortSignal.timeout(NOTICE_TIMEOUT_MS) })) as typeof fetch
  if (kind === 'discord') return sendDiscord(target, { content: clip(text, 2000), allowed_mentions: { parse: [] } }, timed)
  if (kind === 'slack') return sendSlack(target, { text: slackEscape(text), unfurl_links: false, unfurl_media: false }, timed)
  try {
    const res = await telegramCall(botToken, 'sendMessage', { chat_id: target, text: clip(text, TELEGRAM_TEXT_MAX), link_preview_options: { is_disabled: true } }, timed)
    return res.ok
      ? { ok: true, detail: 'Notice sent to Telegram', retryable: false }
      : { ok: false, detail: `Telegram refused it: ${res.description ?? `HTTP ${res.status}`}`, retryable: res.status === 429 || res.status >= 500 }
  } catch {
    return { ok: false, detail: 'Could not reach Telegram', retryable: true }
  }
}
