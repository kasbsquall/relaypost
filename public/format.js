// Small shared helpers: escaping, icons and dates in the viewer's own time zone.

export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export const icon = (name) => `<svg class="ic" aria-hidden="true"><use href="/icons.svg#i-${name}"></use></svg>`

const SERVICE_ICONS = {
  instagram: 'instagram-logo',
  linkedin: 'linkedin-logo',
  threads: 'threads-logo',
  bluesky: 'butterfly',
  mastodon: 'mastodon-logo',
  twitter: 'x-logo',
  x: 'x-logo',
  tiktok: 'tiktok-logo',
  pinterest: 'pinterest-logo',
  youtube: 'youtube-logo',
  facebook: 'facebook-logo',
  googlebusiness: 'storefront',
  startPage: 'globe',
  substack: 'globe',
  whatsapp: 'globe',
}
const SERVICE_NAMES = {
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  threads: 'Threads',
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
  twitter: 'X',
  x: 'X',
  tiktok: 'TikTok',
  pinterest: 'Pinterest',
  youtube: 'YouTube',
  facebook: 'Facebook',
  googlebusiness: 'Google Business',
  startPage: 'Start Page',
  substack: 'Substack',
  whatsapp: 'WhatsApp',
}
export const serviceIcon = (service) => SERVICE_ICONS[service] ?? 'globe'
export const serviceName = (service) => SERVICE_NAMES[service] ?? service
export const destIcon = (kind) => (kind === 'telegram' ? 'telegram-logo' : 'discord-logo')

const pad = (n) => String(n).padStart(2, '0')
export const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
export const dayShort = (d) => d.toLocaleDateString('en-GB', { weekday: 'short' })
export const dayLong = (d) => d.toLocaleDateString('en-GB', { weekday: 'long' })
export const dateShort = (d) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
export const longWhen = (d) => `${dayLong(d)} ${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'long' })} at ${hm(d)}`

// "today", "tomorrow" or "on Thursday" (within a week), else the date.
export function dayPhrase(d, now = new Date()) {
  const a = new Date(now)
  a.setHours(0, 0, 0, 0)
  const b = new Date(d)
  b.setHours(0, 0, 0, 0)
  const days = Math.round((b - a) / 864e5)
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days > 1 && days < 7) return `on ${dayLong(d)}`
  return `on ${dateShort(d)}`
}

export function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return dateShort(new Date(ms))
}

// Hours and minutes until a date, as [value, unit] pairs for the big clock.
export function until(d, now = new Date()) {
  const mins = Math.max(0, Math.round((d - now) / 60000))
  if (mins < 60) return [[mins, 'min']]
  const h = Math.floor(mins / 60)
  if (h < 48) return [[h, 'h'], [pad(mins % 60), 'm']]
  return [[Math.floor(h / 24), 'd'], [pad(h % 24), 'h']]
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve']
export const word = (n) => WORDS[n] ?? String(n)
