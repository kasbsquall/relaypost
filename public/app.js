// Relaypost app: loads the account state and the Buffer queue, draws the track,
// the handoff history, rules and destinations, and keeps them fresh.

import { addDestinationDialog, newRuleDialog, openPostSheet } from './dialogs.js'
import { example } from './example.js'
import { ago, dateShort, dayPhrase, destIcon, destKindName, esc, hm, icon, serviceIcon, serviceName, until, word } from './format.js'
import { handoff, renderTrack } from './track.js'

const STATE_POLL_MS = 20_000
const QUEUE_REFRESH_MS = 5 * 60_000
const HISTORY_ROWS = 12
const $ = (sel) => document.querySelector(sel)

// ------------------------------------------------------------------ sound

const SOUNDS = Object.fromEntries(['toggle', 'handoff', 'added', 'sync'].map((n) => {
  const a = new Audio(`/sfx/${n}.mp3`)
  a.preload = 'auto'
  a.volume = 0.28
  return [n, a]
}))
let soundOn = true
try { soundOn = localStorage.getItem('rp-sound') !== 'off' } catch { /* storage blocked: keep default */ }
export function play(name) {
  if (!soundOn) return
  const a = SOUNDS[name]
  if (!a) return
  a.currentTime = 0
  a.play().catch(() => undefined)
}
function renderSoundButton() {
  const b = $('#sound')
  b.innerHTML = icon(soundOn ? 'speaker-high' : 'speaker-slash')
  b.setAttribute('aria-pressed', String(soundOn))
  b.setAttribute('aria-label', soundOn ? 'Sounds on' : 'Sounds off')
}

// -------------------------------------------------------------------- api

export async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: { 'X-Relaypost': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.message || (res.status === 401 ? 'Not connected' : 'Something went wrong on our side.'))
    err.status = res.status
    throw err
  }
  return data
}

let toastTimer
export function toast(text, fail = false) {
  document.querySelector('.toast')?.remove()
  const t = document.createElement('div')
  t.className = `toast${fail ? ' fail' : ''}`
  t.setAttribute('role', 'status')
  t.innerHTML = `${icon(fail ? 'warning-circle' : 'check-circle')}<span>${esc(text)}</span>`
  document.body.appendChild(t)
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.remove(), 4200)
}

// ------------------------------------------------------------------ model

export const app = { state: null, channels: null, queue: null, queueError: null, horizon: 168, selectedId: null, geo: null, example: false }

// Same matching as src/relay/plan.ts destinationsFor.
export function destinationsFor(post, rules) {
  const tagIds = new Set(post.tags.map((t) => t.id))
  const ids = new Set()
  for (const r of rules) {
    const hit = r.match.kind === 'tag' ? tagIds.has(r.match.tagId) : r.match.channelId === post.channelId
    if (hit) ids.add(r.destinationId)
  }
  return [...ids]
}

const channelOf = (id) => app.channels?.find((c) => c.id === id)
export const channelLabel = (c) => (c ? serviceName(c.service) : 'Buffer')
export const destOf = (id) => app.state?.destinations.find((d) => d.id === id)

function lanes() {
  return (app.channels ?? []).filter((c) => !c.isDisconnected).map((c) => ({
    id: c.id,
    name: serviceName(c.service),
    handle: c.displayName || c.name,
    icon: serviceIcon(c.service),
    avatar: c.avatar,
  }))
}

function trackPosts() {
  const now = Date.now()
  return (app.queue ?? [])
    .filter((p) => p.dueAt && new Date(p.dueAt) - now < app.horizon * 36e5)
    .map((p) => ({
      id: p.id,
      laneId: p.channelId,
      due: new Date(p.dueAt),
      text: p.text || '(media only)',
      photo: p.assets.some((a) => a.type === 'image'),
      dests: destinationsFor(p, app.state.rules),
    }))
}

function ruleSummary(destId) {
  const rules = app.state.rules.filter((r) => r.destinationId === destId)
  if (!rules.length) return 'No rule yet. Turn it on from a post.'
  const list = (items) => (items.length <= 3 ? items.slice(0, -1).join(', ') + (items.length > 1 ? ' and ' : '') + items.at(-1) : `${items.slice(0, 2).join(', ')} and ${items.length - 2} more`)
  const channels = rules.filter((r) => r.match.kind === 'channel').map((r) => channelLabel(channelOf(r.match.channelId)))
  const tags = rules.filter((r) => r.match.kind === 'tag').map((r) => r.match.tagName)
  const parts = []
  if (channels.length) parts.push(`all of ${list(channels)}`)
  if (tags.length) parts.push(`posts tagged ${list(tags)}`)
  return `Takes ${parts.join(', plus ')}`
}

const handoffSeconds = (r) => Math.max(0, Math.round((r.deliveredAt - r.dueAt) / 1000))

function stations() {
  return app.state.destinations.map((d) => {
    const mine = app.state.relays.filter((r) => r.destinationId === d.id && r.status !== 'waiting')
    const last = mine[0]
    const lines = [{ icon: 'funnel-simple', text: ruleSummary(d.id) }]
    if (last?.status === 'delivered') lines.push({ cls: 'ok', icon: 'check-circle', text: `Last handoff +${handoffSeconds(last)} s, ${dayPhrase(new Date(last.deliveredAt))}` })
    else if (last?.status === 'failed') lines.push({ cls: 'fail', icon: 'warning-circle', text: 'Last handoff failed. See history.' })
    else lines.push({ icon: 'hourglass-medium', text: 'No handoffs yet' })
    return { id: d.id, name: d.label, place: `${destKindName(d.kind)} channel`, icon: destIcon(d.kind), lines }
  })
}

// ------------------------------------------------------------------- head

function renderHead() {
  const posts = trackPosts().filter((p) => p.due - Date.now() < 7 * 864e5)
  const relayed = posts.filter((p) => p.dests.length).sort((a, b) => a.due - b.due)
  const strong = $('#lead-strong')
  const rest = $('#lead-rest')
  if (app.queue === null) {
    strong.textContent = 'Reading your Buffer queue.'
    rest.textContent = ''
  } else if (!posts.length) {
    strong.textContent = 'Nothing is scheduled in Buffer for the next seven days.'
    rest.textContent = 'Posts you schedule there show up on this track.'
  } else {
    strong.textContent = relayed.length === 0
      ? `None of this week's ${word(posts.length).toLowerCase()} ${posts.length === 1 ? 'post hands' : 'posts hand'} off yet.`
      : relayed.length === posts.length
      ? posts.length === 1 ? "This week's only post hands off to your community." : `All ${word(posts.length).toLowerCase()} of this week's posts hand off to your community.`
      : `${word(relayed.length)} of this week's ${word(posts.length).toLowerCase()} posts ${relayed.length === 1 ? 'hands' : 'hand'} off to your community.`
    const next = relayed[0]
    rest.textContent = next
      ? `The next one goes to ${next.dests.map((id) => destOf(id)?.label).filter(Boolean).join(' and ')} at ${hm(next.due)} ${dayPhrase(next.due)}, right after ${lanes().find((l) => l.id === next.laneId)?.name ?? 'Buffer'}.`
      : app.state.destinations.length
        ? 'None is set to relay yet. Open a post and turn on a destination, or add a rule.'
        : 'Add a Discord, Telegram or Slack destination to start relaying.'
  }
  const name = app.state.account.name || 'your Buffer account'
  const live = (app.channels ?? []).filter((c) => !c.isDisconnected).length
  $('#built').textContent = `Built on the Buffer API. Reading ${live} ${live === 1 ? 'channel' : 'channels'} from ${name}.`

  const value = $('#clock-value')
  const next = relayed[0]
  if (app.queue === null) {
    value.className = 'clock-value num'
    value.innerHTML = '<span class="skel" style="display:inline-block;width:180px;height:56px"></span>'
    $('#clock-sub').textContent = ''
  } else if (next) {
    const parts = until(next.due)
    value.className = 'clock-value num'
    value.innerHTML = parts.map(([n, u]) => `${n}<span class="u">${u}</span>`).join('')
    value.setAttribute('aria-label', `in ${parts.map(([n, u]) => `${n} ${u}`).join(' ')}`)
    const lane = lanes().find((l) => l.id === next.laneId)
    $('#clock-sub').textContent = `${dateShort(next.due)}, ${hm(next.due)} · ${lane?.name ?? 'Buffer'} to ${destOf(next.dests[0])?.label ?? ''}`
  } else {
    value.className = 'clock-value quiet'
    value.textContent = 'None scheduled'
    value.removeAttribute('aria-label')
    $('#clock-sub').textContent = 'in the next 14 days'
  }
}

function renderTop() {
  const day = app.state.calls.rateLimit.find((w) => w.policy === '24h')
  const quota = day ? `${day.remaining}${day.limit ? ` of ${day.limit}` : ''} Buffer API calls left today` : ''
  $('#quota-text').textContent = quota
  $('#quota').hidden = !day
  $('#quota-meter').hidden = !day?.limit
  if (day?.limit) {
    $('#quota-meter i').style.transform = `scaleX(${Math.min(1, day.remaining / day.limit)})`
    $('#quota-meter').setAttribute('aria-valuenow', String(day.remaining))
    $('#quota-meter').setAttribute('aria-valuemax', String(day.limit))
  }
  const synced = app.state.lastSyncAt ? `Synced ${ago(app.state.lastSyncAt)}` : 'Not synced yet'
  $('#sync-label').textContent = synced
  $('#phone-quota').innerHTML = `${icon('gauge')}<span>${esc([quota, synced].filter(Boolean).join(' · '))}</span>`
  const acc = app.state.account
  $('#acc-name').textContent = acc.name || 'Buffer account'
  $('#acc-avatar').outerHTML = acc.avatar
    ? `<img class="avatar" id="acc-avatar" src="${esc(acc.avatar)}" alt="" referrerpolicy="no-referrer">`
    : `<span class="avatar" id="acc-avatar" aria-hidden="true">${esc((acc.name || 'B').slice(0, 2).toUpperCase())}</span>`
}

// ------------------------------------------------------------------ track

export function drawTrack(settled = false) {
  const root = $('#track')
  if (app.queueError) {
    root.style.height = 'auto'
    root.querySelector('svg.ground').innerHTML = ''
    root.querySelector('.overlay').innerHTML = ''
    root.querySelector('.track-error').hidden = false
    root.querySelector('.track-error p').textContent = `Buffer did not answer: ${app.queueError}`
    return
  }
  root.querySelector('.track-error').hidden = true
  if (app.queue === null || app.channels === null) {
    root.querySelector('svg.ground').innerHTML = ''
    root.querySelector('.overlay').innerHTML = '<div class="skel" style="position:absolute;inset:0;border-radius:14px"></div>'
    root.style.height = '340px'
    return
  }
  root.classList.toggle('settled', settled)
  app.geo = renderTrack(root, { lanes: lanes(), posts: trackPosts(), stations: stations(), now: new Date(), horizon: app.horizon, selectedId: app.selectedId })
}

// ---------------------------------------------------------------- history

function friendly(r) {
  const d = r.detail ?? ''
  if (r.status === 'delivered') return { cls: 'ok', ic: 'check-circle', head: 'Delivered', sub: /text only/.test(d) ? 'Text only: the image could not be fetched.' : '' }
  if (r.status === 'waiting') {
    const at = new Date(r.checkAt)
    return { cls: 'wait', ic: 'hourglass-medium', head: r.attempts ? 'Trying again' : 'Waiting for Buffer', sub: r.attempts ? `${d}. Next try at ${hm(at)}.` : `Hands off after Buffer publishes it, about ${hm(at)}.` }
  }
  if (r.status === 'skipped') return { cls: 'skip', ic: 'skip-forward', head: 'Skipped', sub: d }
  let sub = d
  if (/Discord answered HTTP 404/.test(d)) sub = 'The webhook was deleted in Discord.'
  else if (/Discord answered HTTP (401|403)/.test(d)) sub = 'Discord no longer accepts this webhook.'
  else if (/Slack answered HTTP (403|404|410)/.test(d)) sub = 'Slack no longer accepts this webhook, or the channel is gone.'
  else if (/chat not found|bot was kicked|not a member/i.test(d)) sub = 'The Relaypost bot is no longer in this channel.'
  const fix = /Discord answered HTTP (401|403|404)/.test(d) ? 'discord' : /Slack answered HTTP (403|404|410)/.test(d) ? 'slack' : ''
  return { cls: 'fail', ic: 'warning-circle', head: 'Failed', sub, fix }
}

function renderHistory(freshKeys = new Set()) {
  const body = $('#results')
  const relays = app.state.relays.slice(0, HISTORY_ROWS)
  $('#history-empty').hidden = relays.length > 0
  $('#history-table').hidden = relays.length === 0
  $('#replay').hidden = !app.state.relays.some((r) => r.status === 'delivered')
  body.innerHTML = relays.map((r, i) => {
    const ch = channelOf(r.channelId)
    const dest = destOf(r.destinationId)
    const f = friendly(r)
    const time = r.status === 'delivered'
      ? `<span class="race num" aria-label="${handoffSeconds(r)} seconds after its scheduled time">+${handoffSeconds(r)}<span class="u">s</span></span>`
      : r.status === 'waiting' ? `<span class="dash num">${hm(new Date(r.dueAt))}</span>` : '<span class="dash">No time</span>'
    const act = f.fix
      ? `<button class="btn dark" type="button" data-act="add-dest" data-kind="${f.fix}">${icon('link')}Paste a new webhook</button>`
      : /^https:\/\//.test(r.externalLink ?? '') ? `<a class="link" href="${esc(r.externalLink)}" target="_blank" rel="noopener">Original${icon('arrow-square-out')}<span class="sr"> (opens in a new tab)</span></a>` : ''
    const key = `${r.postId}:${r.destinationId}`
    return `<tr style="--i:${Math.min(i, 7)}"${freshKeys.has(key) ? ' data-fresh' : ''}>
      <td class="post-cell"><div class="when num">${esc(dateShort(new Date(r.dueAt)))}, ${hm(new Date(r.dueAt))}</div><div class="ptext">${icon(serviceIcon(ch?.service))}<span class="sr">${esc(channelLabel(ch))}: </span><span>${esc(r.preview || '(media only)')}</span></div></td>
      <td class="to-cell"><div class="to">${icon(destIcon(dest?.kind))}${esc(dest?.label ?? 'Removed destination')}</div></td>
      <td class="time-cell">${time}</td>
      <td class="st-cell"><div class="status ${f.cls}">${icon(f.ic)}<div><p>${f.head}</p>${f.sub ? `<p>${esc(f.sub)}</p>` : ''}</div></div></td>
      <td class="row-act">${act}</td></tr>`
  }).join('')
  body.querySelectorAll('tr[data-fresh]').forEach((tr, i) => tr.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 240, delay: 500 + i * 300, easing: 'cubic-bezier(.23,1,.32,1)', fill: 'backwards' }))
}

// ------------------------------------------------------- rules + destinations

function renderRules() {
  const rules = app.state.rules
  $('#rules-list').innerHTML = rules.map((r) => {
    const dest = destOf(r.destinationId)
    const from = r.match.kind === 'tag'
      ? `<span class="chip">${icon('tag-simple')}${esc(r.match.tagName)}</span>`
      : `<span class="chip">${icon(serviceIcon(channelOf(r.match.channelId)?.service))}${esc(channelLabel(channelOf(r.match.channelId)))}</span>`
    const label = `${r.match.kind === 'tag' ? `tag ${r.match.tagName}` : channelLabel(channelOf(r.match.channelId))} to ${dest?.label ?? 'destination'}`
    return `<li class="item"><div>
        <div class="item-when">${icon(r.match.kind === 'tag' ? 'tag-simple' : 'broadcast')}${r.match.kind === 'tag' ? 'Posts with a tag' : 'Everything from a channel'}</div>
        <div class="item-what">${from}to<span class="chip">${icon(destIcon(dest?.kind))}${esc(dest?.label ?? '')}</span></div></div>
      <button class="icon-btn" type="button" data-act="del-rule" data-id="${esc(r.id)}" aria-label="Delete rule: ${esc(label)}">${icon('trash')}</button></li>`
  }).join('')
  $('#rules-empty').hidden = rules.length > 0
  $('#rules-list').hidden = rules.length === 0
}

function renderDestinations() {
  const list = app.state.destinations
  $('#dest-list').innerHTML = list.map((d) => `<li class="item"><div>
      <div class="item-when">${icon(destIcon(d.kind))}${destKindName(d.kind)} channel · added ${esc(dateShort(new Date(d.createdAt)))}</div>
      <div class="item-what">${esc(d.label)}</div></div>
    <button class="icon-btn" type="button" data-act="del-dest" data-id="${esc(d.id)}" aria-label="Remove ${esc(d.label)}">${icon('trash')}</button></li>`).join('')
  $('#dest-empty').hidden = list.length > 0
  $('#dest-list').hidden = list.length === 0
}

export function renderAll(opts = {}) {
  renderTop()
  renderHead()
  drawTrack(opts.settled)
  renderHistory(opts.fresh)
  renderRules()
  renderDestinations()
}

// ---------------------------------------------------------------- loading

export async function loadQueue() {
  try {
    const [channels, queue] = await Promise.all([api('/api/channels'), api('/api/queue')])
    app.channels = channels
    app.queue = queue
    app.queueError = null
  } catch (err) {
    if (err.status === 401) return location.reload()
    app.queueError = err.message
  }
}

export async function loadState() {
  app.state = await api('/api/state')
}

async function poll() {
  if (document.visibilityState !== 'visible' || !app.state) return
  const before = new Map(app.state.relays.map((r) => [`${r.postId}:${r.destinationId}`, r.status]))
  try {
    await loadState()
  } catch (err) {
    if (err.status === 401) location.reload()
    return
  }
  const fresh = app.state.relays.filter((r) => r.status === 'delivered' && before.get(`${r.postId}:${r.destinationId}`) !== 'delivered')
  if (fresh.length) await loadQueue()
  renderAll({ settled: true, fresh: new Set(fresh.map((r) => `${r.postId}:${r.destinationId}`)) })
  if (fresh.length) handoff($('#track'), app.geo, fresh.sort((a, b) => a.deliveredAt - b.deliveredAt).map((r) => r.destinationId))
}

// ---------------------------------------------------------------- actions

const confirmations = new Map()
function confirmTwice(btn, text) {
  if (confirmations.get(btn.dataset.id)) return true
  confirmations.set(btn.dataset.id, true)
  const prev = btn.innerHTML
  btn.classList.add('btn')
  btn.classList.remove('icon-btn')
  btn.innerHTML = `${icon('trash')}${text}`
  setTimeout(() => {
    confirmations.delete(btn.dataset.id)
    if (btn.isConnected) {
      btn.classList.remove('btn')
      btn.classList.add('icon-btn')
      btn.innerHTML = prev
    }
  }, 4000)
  return false
}

async function onAction(e) {
  const el = e.target.closest('[data-act]')
  if (!el) return
  const act = el.dataset.act
  try {
    if (act === 'add-dest') return addDestinationDialog(el.dataset.kind)
    if (act === 'retry-queue') {
      el.disabled = true
      await loadQueue()
      el.disabled = false
      return renderAll({ settled: true })
    }
    if (act === 'new-rule') return app.state.destinations.length ? newRuleDialog() : addDestinationDialog()
    if (act === 'del-rule') {
      if (!confirmTwice(el, 'Delete')) return
      el.disabled = true
      await api(`/api/rules/${encodeURIComponent(el.dataset.id)}`, 'DELETE')
      await loadState()
      play('toggle')
      toast('Rule deleted.')
      renderAll({ settled: true })
    }
    if (act === 'del-dest') {
      if (!confirmTwice(el, 'Remove')) return
      el.disabled = true
      await api(`/api/destinations/${encodeURIComponent(el.dataset.id)}`, 'DELETE')
      await loadState()
      play('toggle')
      toast('Destination removed, with its rules.')
      renderAll({ settled: true })
    }
  } catch (err) {
    el.disabled = false
    toast(err.message, true)
  }
}

async function onSync() {
  const b = $('#sync-btn')
  if (b.getAttribute('aria-busy') === 'true') return
  b.setAttribute('aria-busy', 'true')
  play('sync')
  try {
    await api('/api/sync', 'POST')
    await Promise.all([loadState(), loadQueue()])
    renderAll({ settled: true })
    toast('Synced with Buffer.')
  } catch (err) {
    toast(err.message, true)
  } finally {
    b.removeAttribute('aria-busy')
  }
}

// Marks the section in view as current in the top nav and the phone tab bar.
function trackSection() {
  const ids = ['track', 'history', 'rules', 'destinations']
  const update = () => {
    let current = ids[0]
    for (const id of ids) if (document.getElementById(id).getBoundingClientRect().top < 140) current = id
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) current = ids[ids.length - 1]
    document.querySelectorAll('.nav a, .tabbar a').forEach((a) => {
      if (a.getAttribute('href') === `#${current}`) a.setAttribute('aria-current', 'true')
      else a.removeAttribute('aria-current')
    })
  }
  addEventListener('scroll', update, { passive: true })
  update()
}

function bind() {
  trackSection()
  document.addEventListener('click', onAction)
  $('#sync-btn').addEventListener('click', onSync)
  $('#sound').addEventListener('click', () => {
    soundOn = !soundOn
    try { localStorage.setItem('rp-sound', soundOn ? 'on' : 'off') } catch { /* not persisted */ }
    renderSoundButton()
    play('toggle')
  })
  $('#track').addEventListener('click', (e) => {
    const b = e.target.closest('.post')
    if (b) openPostSheet(b.dataset.id, b)
  })
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)))
    app.horizon = Number(b.dataset.h)
    play('toggle')
    renderHead()
    drawTrack(true)
  }))
  $('#replay').addEventListener('click', () => {
    const last = app.state.relays.find((r) => r.status === 'delivered')
    if (!last) return
    play('handoff')
    const ids = app.state.relays.filter((r) => r.postId === last.postId && r.status === 'delivered').map((r) => r.destinationId)
    handoff($('#track'), app.geo, ids)
  })
  $('#logout').addEventListener('click', async () => {
    await api('/api/logout', 'POST').catch(() => undefined)
    location.href = '/'
  })
  $('#disconnect').addEventListener('click', async (e) => {
    const b = e.currentTarget
    if (b.dataset.armed !== '1') {
      b.dataset.armed = '1'
      b.querySelector('span').textContent = 'Click again: deletes destinations, rules and history'
      return
    }
    await api('/api/disconnect', 'POST').catch(() => undefined)
    location.href = '/'
  })
  let rt
  addEventListener('resize', () => {
    clearTimeout(rt)
    rt = setTimeout(() => drawTrack(true), 80)
  })
  setInterval(poll, STATE_POLL_MS)
  setInterval(async () => {
    if (document.visibilityState !== 'visible') return
    await loadQueue()
    renderAll({ settled: true })
  }, QUEUE_REFRESH_MS)
  // The clock and the line of now move every minute.
  setInterval(() => {
    if (document.visibilityState !== 'visible' || !app.queue) return
    renderHead()
    drawTrack(true)
  }, 60_000)
}

// ------------------------------------------------------------------- boot

const CONNECT_REASONS = {
  expired: 'The sign-in took too long. Try again.',
  state: 'That sign-in came from another tab or was already used. Try again.',
  denied: 'Buffer access was not granted, so nothing was connected.',
  failed: 'Buffer did not finish the connection. Try again in a minute.',
}

function landing() {
  document.body.dataset.view = 'landing'
  document.querySelector('.skip').href = '#landing'
  const reason = new URLSearchParams(location.search).get('connect')
  if (reason && CONNECT_REASONS[reason]) {
    $('#connect-note').hidden = false
    $('#connect-note span').textContent = CONNECT_REASONS[reason]
  }
  if (reason) history.replaceState(null, '', '/')
  const draw = () => renderTrack($('#example-track'), example())
  draw()
  let rt
  addEventListener('resize', () => {
    clearTimeout(rt)
    rt = setTimeout(draw, 80)
  })
}

async function boot() {
  renderSoundButton()
  try {
    await loadState()
  } catch (err) {
    if (err.status === 401) return landing()
    document.body.dataset.view = 'landing'
    $('#connect-note').hidden = false
    $('#connect-note span').textContent = 'Relaypost could not load your account. Reload the page in a minute.'
    return
  }
  document.body.dataset.view = 'app'
  document.querySelector('.skip').href = '#app'
  if (new URLSearchParams(location.search).get('connect')) history.replaceState(null, '', '/')
  bind()
  renderAll()
  await loadQueue()
  renderAll()
}

document.fonts.ready.then(boot)
