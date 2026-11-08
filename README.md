# Relaypost

What you schedule in Buffer also lands in your Telegram channel, your Discord server and your Slack workspace, usually within 45 seconds of Buffer publishing it. For Reddit, it hands you a ready-to-post draft.

Live: https://relaypost.kevin2005-10.workers.dev

Built on the Buffer API for Buffer Commit 2026. Relaypost is an independent app; it is not made or endorsed by Buffer.

## The problem

Reddit, Telegram and Discord are the most requested channels on Buffer's own request board (3,008, 1,452 and 1,364 votes, read on 3 Nov 2026 at suggestions.buffer.com), all still under review. People who run a community there schedule the week in Buffer and then paste the same announcement into Telegram, Discord and Reddit by hand, or forget to.

## Try it in a minute

1. Open the live link and connect Buffer. Relaypost asks for `account:read posts:read posts:write offline_access`.
2. No Telegram or Discord of your own? In Destinations, press **Add the public channel**. It connects the public Telegram channel [t.me/relaypost_demo](https://t.me/relaypost_demo) with one rule: only posts tagged `Relaypost demo` go there.
3. Open any scheduled post on the track and switch on the public channel. Relaypost adds the tag in Buffer for you.
4. When Buffer publishes the post, watch it arrive in the public channel. The history shows the handoff time and a link straight to the delivered message.

Everything sent to the public channel is public, and each account can send up to 3 posts a day there. Posts without the tag never go there.

## What it does

- **Rules, two kinds.** Everything from a Buffer channel ("all of LinkedIn goes to #announcements"), or only posts with a tag. Tag rules live in Buffer itself, so a post can be routed from Buffer's own composer, the mobile app or any other client.
- **Waits for Buffer's confirmation.** A handoff fires only after Buffer reports the post as sent. If Buffer failed or the post was deleted, nothing is relayed and the history says why.
- **Formats each destination on its own terms.** A Discord embed with the image and a link to the original; a Telegram photo with caption, or a message when there is no image, within Telegram's 1,024 and 4,096 character limits; a Slack Block Kit message with `<`, `>` and `&` escaped so a stray `@channel` stays inert. The post sheet previews all of them, Reddit included, before it goes.
- **Reddit, as a draft.** Reddit no longer lets new apps post through its API. So when Buffer publishes, Relaypost builds the Reddit post for you: the subreddit's submit page with the title (the first sentence) and the text filled in, plus the link to the original. You check it and press Post.
- **Notices.** Pick one Slack, Discord or Telegram channel and Relaypost tells it when Buffer fails to publish a post it was handing off, once per post, and when a Reddit draft is ready, with the draft link. A failed post in Buffer stops being something you find out about days later.
- **Shows its work.** Each handoff records how many seconds after the scheduled minute it landed, how many tries it took, and links to the delivered message in Telegram or Discord. Failed handoffs can be sent again by hand; a deleted webhook asks for a new one instead.

## Why not Zapier or IFTTT

They can forward a post, but they fire on their own trigger. Relaypost is built around Buffer's queue: it reads the scheduled posts, shows them on a timeline with what will hand off where, waits for Buffer's `sent` status, writes routing tags back to Buffer so the rules survive outside the app, keeps a history with the handoff time of every post, and tells your team when Buffer itself fails to publish. Setup is a Buffer login, one pasted webhook or one bot invite, and a switch.

## How it is built

- Cloudflare Workers with one Durable Object per Buffer account. Its alarm schedules each check for 45 seconds after a post's due minute, retries twice at two-minute intervals, and gives up after 30 minutes.
- Buffer OAuth with PKCE and rotating refresh tokens, serialized so a refresh token is never reused. Tokens and destination secrets are encrypted at rest with per-use context.
- Every Buffer call reads the `RateLimit` and `RateLimit-Policy` headers. The app shows the remaining daily calls, keeps 20 calls in reserve for scheduled handoffs, and honors `Retry-After`.
- GraphQL operations are validated in tests against Buffer's published schema (`test/buffer-schema.json`).
- Data kept: account id, name and avatar; destinations; rules; 14 days of handoff history. Accounts nobody opens for 14 days stop polling.

### Why `posts:write`

Only to add or remove a routing tag on a post and to create that tag. The `editPost` call sends the post's text back exactly as Buffer last returned it, read on the server, so the browser never decides the text or the tag list. Relaypost never creates, rewrites or deletes a post.

## Run it locally

```bash
npm install
npx vitest run
npx wrangler dev
```

Secrets go in `.dev.vars` (see the list in `wrangler.jsonc`): Buffer client id and secret, redirect URI, session secret, encryption key, and the Telegram bot token, username and webhook secret.

