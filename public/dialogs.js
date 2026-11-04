// The post sheet and the two forms: add a destination, new rule.

import { api, app, channelLabel, destOf, destinationsFor, loadQueue, loadState, play, renderAll, toast } from './app.js'
import { dateShort, dayPhrase, destIcon, destKindName, esc, hm, icon, serviceIcon, serviceName } from './format.js'

const TELEGRAM_POLL_MS = 3000
const $ = (sel) => document.querySelector(sel)

function closeOnBackdrop(dialog) {
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close()
  })
}

// ------------------------------------------------------------- post sheet

const sheet = $('#sheet')
let opener = null
let sheetPostId = null
closeOnBackdrop(sheet)
$('#sheet-close').addEventListener('click', () => sheet.close())
sheet.addEventListener('close', () => {
  app.selectedId = null
  sheetPostId = null
  document.querySelectorAll('#track .post.selected').forEach((b) => b.classList.remove('selected'))
  const again = opener && document.querySelector(`#track .post[data-id="${CSS.escape(opener.dataset.id)}"]`)
  again?.focus()
})

const defaultTag = (dest) => (/^relaypost\b/i.test(dest.label) ? dest.label : `Relaypost ${dest.label}`).replace(/\s+/g, ' ').slice(0, 40)

export function openPostSheet(id, btn) {
  const p = app.queue?.find((q) => q.id === id)
  if (!p) return
  opener = btn
  sheetPostId = id
  app.selectedId = id
  document.querySelectorAll('#track .post').forEach((b) => b.classList.toggle('selected', b.dataset.id === id))
  renderSheet()
  if (!sheet.open) sheet.showModal()
}

function renderSheet() {
  const p = app.queue.find((q) => q.id === sheetPostId)
  if (!p) return sheet.close()
  const ch = app.channels.find((c) => c.id === p.channelId)
  const due = new Date(p.dueAt)
  $('#sheet-ch').innerHTML = `${icon(serviceIcon(ch?.service))}<span>${esc(channelLabel(ch))} · ${esc(ch?.displayName || ch?.name || '')}</span>`
  $('#sheet-time').textContent = `${dateShort(due)}, ${hm(due)}`
  $('#sheet-text').textContent = p.text || '(media only)'
  const images = p.assets.filter((a) => a.type === 'image').length
  $('#sheet-meta').innerHTML =
    (images ? `<span>${icon('image')}${images} ${images === 1 ? 'image' : 'images'}, sent along</span>` : `<span>${icon('text-aa')}Text only</span>`) +
    (p.tags.length ? p.tags.map((t) => `<span>${icon('tag-simple')}${esc(t.name)}</span>`).join('') : `<span>${icon('tag-simple')}No tags</span>`)
  renderSheetDests(p, ch, due)
  renderLands(p, ch)
}

// ------------------------------------------------------------ how it lands
// Mirrors the server's payloads in src/relay/deliver.ts: same limits, same footer.

const LIMITS = { discord: 4000, slack: 3000, telegramText: 4096, telegramCaption: 1024 }
let landsKind = null

function clipped(text, max) {
  return text.length <= max ? { text, cut: false } : { text: `${text.slice(0, max - 1)}…`, cut: true }
}

function landsPreview(kind, p, ch) {
  const service = serviceName(ch?.service)
  const image = p.assets.find((a) => a.type === 'image')?.source
  const img = /^https:\/\//.test(image ?? '') ? `<img src="${esc(image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''
  const text = p.text || ''
  if (kind === 'discord') {
    const c = clipped(text, LIMITS.discord)
    return { note: c.cut ? `Discord embeds hold ${LIMITS.discord.toLocaleString('en-US')} characters, so the end is cut.` : 'Sent as an embed: the link to the original appears once Buffer publishes.',
      html: `<div class="mock discord"><span class="stripe" aria-hidden="true"></span><div>
        <p class="m-title">Open on ${esc(service)}</p><p class="m-text">${esc(c.text)}</p>${img}
        <p class="m-foot">Also on ${esc(service)} · relayed by Relaypost</p></div></div>` }
  }
  if (kind === 'slack') {
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const c = escaped.length <= LIMITS.slack ? clipped(text, LIMITS.slack) : { text: `${escaped.slice(0, LIMITS.slack - 1)}…`.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), cut: true }
    return { note: c.cut ? `Slack sections hold ${LIMITS.slack.toLocaleString('en-US')} characters, so the end is cut.` : 'Plain text, so a stray @channel or link markup stays harmless.',
      html: `<div class="mock slack"><p class="m-text">${esc(c.text)}</p>${img}<p class="m-foot">Also on <u>${esc(service)}</u> · relayed by Relaypost</p></div>` }
  }
  const max = image ? LIMITS.telegramCaption : LIMITS.telegramText
  // The real link is unknown until Buffer publishes; a typical post URL is about 70 characters.
  const link = `

Also on ${service}: ${'x'.repeat(70)}`
  const c = clipped(text, max - link.length)
  return { note: image ? `Sent as a photo. Telegram captions hold ${LIMITS.telegramCaption.toLocaleString('en-US')} characters${c.cut ? ', so the end is cut' : ''}.` : c.cut ? 'Telegram messages hold 4,096 characters, so the end is cut.' : 'Sent as a message, with the link to the original at the end.',
    html: `<div class="mock telegram">${img}<p class="m-text">${esc(c.text)}</p><p class="m-link">Also on ${esc(service)}: <u>link once published</u></p></div>` }
}

function renderLands(p, ch) {
  const kinds = [...new Set(app.state.destinations.map((d) => d.kind))]
  const box = $('#sheet-lands')
  box.hidden = kinds.length === 0
  if (!kinds.length) return
  if (!kinds.includes(landsKind)) landsKind = kinds[0]
  $('#lands-seg').innerHTML = kinds.map((k) => `<button type="button" data-kind="${k}" aria-pressed="${k === landsKind}">${icon(destIcon(k))}${destKindName(k)}</button>`).join('')
  const view = landsPreview(landsKind, p, ch)
  $('#lands-view').innerHTML = `${view.html}<p class="land-note">${icon('info')}<span>${esc(view.note)}</span></p>`
  $('#lands-seg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    landsKind = b.dataset.kind
    renderLands(p, ch)
    $(`#lands-seg [data-kind="${landsKind}"]`)?.focus()
  }))
}

function renderSheetDests(p, ch, due) {
  const box = $('#sheet-dests')
  const dests = app.state.destinations
  if (!dests.length) {
    box.innerHTML = `<p class="notice">${icon('info')}<span>No destinations yet. Add a Discord, Telegram or Slack channel first.</span></p>
      <p><button class="btn baton-btn" type="button" data-act="add-dest">${icon('plus')}Add a destination</button></p>`
    return
  }
  const on = new Set(destinationsFor(p, app.state.rules))
  const tags = new Set(p.tags.map((t) => t.id))
  const channel = serviceName(ch?.service)
  box.innerHTML = dests.map((d) => {
    const byChannel = app.state.rules.some((r) => r.destinationId === d.id && r.match.kind === 'channel' && r.match.channelId === p.channelId)
    const tagRule = app.state.rules.find((r) => r.destinationId === d.id && r.match.kind === 'tag' && tags.has(r.match.tagId))
      ?? app.state.rules.find((r) => r.destinationId === d.id && r.match.kind === 'tag')
    const tagName = tagRule?.match.tagName ?? defaultTag(d)
    let why
    if (byChannel) why = `Sent by your ${channel} rule: every post from ${channel} goes here. Change that in Rules.`
    else if (on.has(d.id)) why = `Goes to ${d.label} at ${hm(due)} ${dayPhrase(due)}, right after ${channel}. Turning it off removes the tag "${tagName}" in Buffer.`
    else why = `Not relayed. Turning it on adds the tag "${tagName}" to this post in Buffer.`
    return `<div class="drow"><span class="st-icon">${icon(destIcon(d.kind))}</span>
      ${byChannel ? `<b class="dlabel">${esc(d.label)}</b>` : `<label for="sw-${esc(d.id)}">${esc(d.label)}</label>`}
      ${byChannel
        ? `<span class="locked" id="sw-${esc(d.id)}">${icon('lock-simple')}By rule</span>`
        : `<input class="switch" type="checkbox" role="switch" id="sw-${esc(d.id)}" data-dest="${esc(d.id)}" ${on.has(d.id) ? 'checked' : ''} aria-describedby="why-${esc(d.id)}">`}
      <span class="why" id="why-${esc(d.id)}">${esc(why)}</span></div>`
  }).join('') + '<p class="notice fail" id="sheet-error" hidden></p>'
  box.querySelectorAll('.switch').forEach((sw) => sw.addEventListener('change', () => toggleDest(p, sw)))
}

async function toggleDest(p, sw) {
  const dest = destOf(sw.dataset.dest)
  const on = sw.checked
  const err = $('#sheet-error')
  err.hidden = true
  sw.disabled = true
  sw.setAttribute('aria-busy', 'true')
  play('toggle')
  try {
    const tags = new Set(p.tags.map((t) => t.id))
    let rule = app.state.rules.find((r) => r.destinationId === dest.id && r.match.kind === 'tag' && (on || tags.has(r.match.tagId)))
    if (!rule && on) rule = await api('/api/rules', 'POST', { destinationId: dest.id, tagName: defaultTag(dest) })
    if (!rule) throw new Error('This post reaches that destination through a channel rule.')
    const updated = await api('/api/posts/tag', 'POST', { postId: p.id, tagId: rule.match.tagId, on })
    app.queue = app.queue.map((q) => (q.id === p.id ? { ...q, tags: updated.tags } : q))
    await loadState()
    renderAll({ settled: true })
    renderSheet()
    $(`#sw-${CSS.escape(dest.id)}`)?.focus()
    toast(on ? `Tagged in Buffer. It hands off to ${dest.label}.` : `Tag removed in Buffer. It stays off ${dest.label}.`)
  } catch (e) {
    sw.checked = !on
    sw.disabled = false
    sw.removeAttribute('aria-busy')
    err.hidden = false
    err.innerHTML = `${icon('warning-circle')}<span>${esc(e.message)}</span>`
  }
}

// --------------------------------------------------------- add destination

const destDialog = $('#dest-dialog')
closeOnBackdrop(destDialog)
destDialog.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => destDialog.close()))
let telegramTimer = null
destDialog.addEventListener('close', () => clearInterval(telegramTimer))

function selectTab(kind) {
  destDialog.querySelectorAll('[role="tab"]').forEach((t) => {
    const sel = t.dataset.kind === kind
    t.setAttribute('aria-selected', String(sel))
    t.tabIndex = sel ? 0 : -1
  })
  $('#panel-discord').hidden = kind !== 'discord'
  $('#panel-telegram').hidden = kind !== 'telegram'
  $('#panel-slack').hidden = kind !== 'slack'
}
const destTabs = [...destDialog.querySelectorAll('[role="tab"]')]
destTabs.forEach((t, i) => {
  t.addEventListener('click', () => selectTab(t.dataset.kind))
  t.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const other = destTabs[(i + (e.key === 'ArrowRight' ? 1 : destTabs.length - 1)) % destTabs.length]
    selectTab(other.dataset.kind)
    other.focus()
  })
})

export function addDestinationDialog(kind = 'discord') {
  $('#discord-form').reset()
  $('#discord-error').hidden = true
  $('#slack-form').reset()
  $('#slack-error').hidden = true
  $('#tg-code-box').hidden = true
  $('#tg-error').hidden = true
  $('#tg-get').disabled = false
  $('#tg-bot').textContent = app.state.telegramBot ? `@${app.state.telegramBot}` : 'the Relaypost bot'
  selectTab(['telegram', 'slack'].includes(kind) ? kind : 'discord')
  if (sheet.open) sheet.close()
  destDialog.showModal()
}

// Discord and Slack both connect by pasting an incoming webhook.
const webhookSubmit = (kind) => async (e) => {
  e.preventDefault()
  const f = e.currentTarget
  const btn = f.querySelector('button[type="submit"]')
  const err = $(`#${kind}-error`)
  err.hidden = true
  btn.disabled = true
  btn.lastChild.textContent = 'Sending a test message'
  try {
    await api(`/api/destinations/${kind}`, 'POST', { label: f.label.value.trim(), webhookUrl: f.url.value.trim() })
    await loadState()
    renderAll({ settled: true })
    destDialog.close()
    play('added')
    toast(`${destKindName(kind)} connected. The test message is in the channel.`)
  } catch (ex) {
    err.hidden = false
    err.innerHTML = `${icon('warning-circle')}<span>${esc(ex.message)}</span>`
  } finally {
    btn.disabled = false
    btn.lastChild.textContent = 'Connect and send a test message'
  }
}
$('#discord-form').addEventListener('submit', webhookSubmit('discord'))
$('#slack-form').addEventListener('submit', webhookSubmit('slack'))

$('#tg-get').addEventListener('click', async (e) => {
  const btn = e.currentTarget
  const err = $('#tg-error')
  err.hidden = true
  btn.disabled = true
  try {
    const known = new Set(app.state.destinations.map((d) => d.id))
    const res = await api('/api/destinations/telegram', 'POST', { label: $('#tg-label').value.trim() })
    $('#tg-code').value = res.code
    $('#tg-code').textContent = res.code
    $('#tg-code-box').hidden = false
    clearInterval(telegramTimer)
    telegramTimer = setInterval(async () => {
      await loadState().catch(() => undefined)
      const added = app.state.destinations.find((d) => d.kind === 'telegram' && !known.has(d.id))
      if (added) {
        clearInterval(telegramTimer)
        renderAll({ settled: true })
        destDialog.close()
        play('added')
        toast(`Telegram connected: ${added.label}.`)
      } else if (!app.state.pendingTelegram) {
        clearInterval(telegramTimer)
        btn.disabled = false
        err.hidden = false
        err.innerHTML = `${icon('warning-circle')}<span>The code expired. Get a new one.</span>`
      }
    }, TELEGRAM_POLL_MS)
  } catch (ex) {
    btn.disabled = false
    err.hidden = false
    err.innerHTML = `${icon('warning-circle')}<span>${esc(ex.message)}</span>`
  }
})

$('#tg-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#tg-code').textContent)
    play('toggle')
    toast('Code copied.')
  } catch {
    toast('Copy did not work. Select the code and copy it by hand.', true)
  }
})

// ---------------------------------------------------------------- new rule

const ruleDialog = $('#rule-dialog')
closeOnBackdrop(ruleDialog)
ruleDialog.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => ruleDialog.close()))

function syncRuleKind() {
  const kind = $('#rule-form').kind.value
  $('#rule-channel-field').hidden = kind !== 'channel'
  $('#rule-tag-field').hidden = kind !== 'tag'
}
$('#rule-form').querySelectorAll('input[name="kind"]').forEach((r) => r.addEventListener('change', syncRuleKind))

export function newRuleDialog() {
  const f = $('#rule-form')
  f.reset()
  $('#rule-error').hidden = true
  f.channel.innerHTML = (app.channels ?? []).filter((c) => !c.isDisconnected)
    .map((c) => `<option value="${esc(c.id)}">${esc(serviceName(c.service))} · ${esc(c.displayName || c.name)}</option>`).join('')
  f.dest.innerHTML = app.state.destinations.map((d) => `<option value="${esc(d.id)}">${esc(d.label)} (${destKindName(d.kind)})</option>`).join('')
  syncRuleKind()
  ruleDialog.showModal()
}

$('#rule-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const f = e.currentTarget
  const btn = f.querySelector('button[type="submit"]')
  const err = $('#rule-error')
  err.hidden = true
  btn.disabled = true
  try {
    const body = f.kind.value === 'channel'
      ? { destinationId: f.dest.value, channelId: f.channel.value }
      : { destinationId: f.dest.value, tagName: f.tag.value.trim() }
    await api('/api/rules', 'POST', body)
    await Promise.all([loadState(), loadQueue()])
    renderAll({ settled: true })
    ruleDialog.close()
    play('added')
    toast('Rule saved. Matching posts now hand off.')
  } catch (ex) {
    err.hidden = false
    err.innerHTML = `${icon('warning-circle')}<span>${esc(ex.message)}</span>`
  } finally {
    btn.disabled = false
  }
})
