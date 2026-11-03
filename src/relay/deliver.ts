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
    color: 0x2f6b4f,
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
    if (res.ok) return { ok: true, detail: 'Posted to Discord', retryable: false }
    return { ok: false, detail: `Discord answered HTTP ${res.status}`, retryable: res.status === 429 || res.status >= 500 }
  } catch {
    return { ok: false, detail: 'Could not reach Discord', retryable: true }
  }
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

export async function sendTelegram(
  botToken: string,
  chatId: string,
  post: BufferPost,
  fetcher: typeof fetch = fetch,
): Promise<DeliveryResult> {
  const message = telegramMessage(post)
  try {
    const first = await telegramCall(botToken, message.method, { chat_id: chatId, ...message.body }, fetcher)
    if (first.ok) return { ok: true, detail: 'Posted to Telegram', retryable: false }
    // Telegram fetches the photo itself; if the host refuses it, fall back to text with the link.
    if (message.method === 'sendPhoto') {
      const text = telegramMessage({ ...post, assets: [] })
      const second = await telegramCall(botToken, text.method, { chat_id: chatId, ...text.body }, fetcher)
      if (second.ok) return { ok: true, detail: 'Posted to Telegram (text only, the image could not be fetched)', retryable: false }
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
