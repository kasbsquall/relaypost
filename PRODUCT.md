# Relaypost

## What it is

What you schedule in Buffer also lands in your Telegram channel, your Discord server and your Slack workspace, less than a minute later, without copy and paste. Built on the Buffer API for Buffer Commit 2026.

## Who it is for

Creators, small businesses and community managers who already schedule in Buffer and also keep a community in a Telegram channel or a Discord server. Telegram (1,452 votes), Discord (1,364) and Tumblr (1,328) are the 2nd, 3rd and 4th most requested channels on Buffer's own channel request board (suggestions.buffer.com, read 3 Nov 2026), all still "under review".

Typical person: a creator who batches the week's posts in Buffer on Sunday night, then forgets to paste the Instagram announcement into her Telegram channel and her Discord #announcements on Wednesday.

## The job

1. Connect Buffer (OAuth).
2. Add destinations: a Discord webhook (pasted, verified with a test message) and a Telegram channel (add the Relaypost bot as admin, post a one-time code in the channel).
3. Decide what goes where: by Buffer channel ("everything from my Instagram also goes to Discord") or by tag ("posts tagged Community go to Telegram"), or flip a switch on a single post in the queue, which adds the tag in Buffer.
4. Forget about it. When Buffer reports the post as sent, Relaypost relays it with its image and the link to the original. If Buffer failed to publish, nothing is relayed and the history says why.

## Real content available (no lorem ipsum)

From the Buffer API, per connected account: account name and avatar; channels (name, service such as instagram, linkedin, threads, bluesky, mastodon, x, tiktok, pinterest, youtube; avatar; timezone; paused or disconnected); scheduled posts for the next 14 days (text, due time, channel, tags, image assets, status: scheduled, sending, sent, error); tags. From Relaypost: destinations (Discord, Telegram or Slack, label), rules, relay history (per post and destination: waiting, delivered, skipped, failed, with the reason and the link to the original post), and the shared Buffer rate limit remaining.

## Voice

Plain, calm, specific. Says what will happen and when ("Goes to #announcements at 9:00 on Thursday, right after Instagram"). No hype words, no exclamation marks. Errors say what happened and what to do.

## Constraints

- Must not look like Buffer or use "Buffer" in the product name or logo (contest brand rules). "Built on the Buffer API" and "Connect Buffer" are allowed.
- Judges: Joel Gascoigne (CEO; "great UIs are a big part of the future"), Amanda Marochko (Staff PM of the API), Joe Birch (Staff Engineer, Android GDE, accessibility work). Buffer's design team picks a Delight Award for the most distinctive user experience.
- Works on a phone at 390 px. Keyboard and screen reader friendly.
- Judges must understand it in one screen and try it in under a minute with their own Buffer account.

## Proof

Real relay to a real Discord channel and Telegram channel, triggered by a real Buffer post, visible in the demo video and in the relay history.
