// Reddit no longer lets new apps post through its API, so Relaypost prepares the
// post instead: a link to Reddit's own submit page with the title and the text
// already filled in. The person reviews it and presses Post on Reddit.

import type { BufferPost } from '../buffer/queries'
import { firstImage, serviceName } from './deliver'

const SUBREDDIT = /^[A-Za-z0-9][A-Za-z0-9_]{1,20}$/
// Reddit's own limit for a post title.
export const REDDIT_TITLE_MAX = 300
// Browsers and Reddit handle long query strings, but past this the link gets fragile.
export const REDDIT_URL_MAX = 7500

// Accepts "r/name", "/r/name", "https://www.reddit.com/r/name/" or just "name".
export function normalizeSubreddit(input: string): string | null {
  const name = input
    .trim()
    .replace(/^https?:\/\/(?:www\.|old\.)?reddit\.com/i, '')
    .replace(/^\/?r\//i, '')
    .replace(/\/+$/, '')
  return SUBREDDIT.test(name) ? name : null
}

function clipWords(text: string, max: number): string {
  if (text.length <= max) return text
  const head = text.slice(0, max - 1)
  const space = head.lastIndexOf(' ')
  return `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`
}

// The first sentence of the first line reads like a title; long first lines are cut at a word.
export function redditTitle(post: Pick<BufferPost, 'text' | 'channelService'>): string {
  const firstLine = post.text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const sentence = /^.{12,}?[.!?](?=\s|$)/.exec(firstLine)?.[0] ?? firstLine
  return clipWords(sentence, REDDIT_TITLE_MAX) || `New post from ${serviceName(post.channelService)}`
}

export function redditBody(post: Pick<BufferPost, 'text' | 'channelService' | 'externalLink' | 'assets'>, title: string): string {
  const parts: string[] = []
  // A one-sentence post is all title; repeating it in the body reads as a mistake.
  if (post.text.trim() !== title) parts.push(post.text.trim())
  const image = firstImage(post as BufferPost)
  if (image) parts.push(`Image: ${image}`)
  if (post.externalLink) parts.push(`Originally posted on ${serviceName(post.channelService)}: ${post.externalLink}`)
  return parts.join('\n\n')
}

export function redditSubmitUrl(subreddit: string, title: string, body: string): string {
  const base = `https://www.reddit.com/r/${subreddit}/submit?type=TEXT&title=${encodeURIComponent(title)}`
  let text = body
  let url = text ? `${base}&text=${encodeURIComponent(text)}` : base
  // Too long for a link: shorten the body, never the title.
  while (url.length > REDDIT_URL_MAX && text.length > 0) {
    const shorter = clipWords(text, Math.floor(text.length * 0.8))
    text = shorter.length < text.length ? shorter : ''
    url = text ? `${base}&text=${encodeURIComponent(text)}` : base
  }
  return url
}

export function redditDraft(post: BufferPost, subreddit: string): { title: string; url: string } {
  const title = redditTitle(post)
  return { title, url: redditSubmitUrl(subreddit, title, redditBody(post, title)) }
}
