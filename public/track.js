// The track: one lane per Buffer channel, posts running toward "now" on the
// right, and each destination waiting in the exchange zone past the line.
// Pure DOM drawing; app.js owns the data.

import { dayShort, esc, hm, icon, longWhen } from './format.js'

const TOKEN_W = 140

const kindOf = (p) => (p.dests.length ? 'relay' : 'only')

function destDots(p, stations) {
  const known = p.dests.map((id) => stations.find((s) => s.id === id)).filter(Boolean)
  const shown = known.slice(0, 3).map((s) => `<span class="dest" title="${esc(s.name)}">${icon(s.icon)}</span>`).join('')
  return shown + (known.length > 3 ? `<span class="more num">+${known.length - 3}</span>` : '')
}

function ariaFor(p, lane, stations) {
  const names = p.dests.map((id) => stations.find((s) => s.id === id)?.name).filter(Boolean)
  const where = names.length ? `relays to ${names.join(' and ')}` : 'stays in Buffer only'
  return `${lane.name}, ${longWhen(p.due)}: ${p.text.slice(0, 120)}. ${where}. Open details.`
}

function postButton(p, i, style, ctx, compact) {
  const lane = ctx.lanes.find((l) => l.id === p.laneId)
  const k = kindOf(p)
  const t = `<span class="t num">${dayShort(p.due)} ${hm(p.due)}</span>`
  const inner = k === 'relay' ? t + destDots(p, ctx.stations) : t + '<span class="note">No relay</span>'
  const snip = compact ? '' : `<span class="snip">${p.photo ? icon('image') : ''}<span>${esc(p.text)}</span></span>`
  const tip = compact ? ` title="${esc(p.text.slice(0, 140))}"` : ''
  return `<button type="button"${tip} class="post ${k}${p.id === ctx.selectedId ? ' selected' : ''}" data-id="${esc(p.id)}" style="--i:${Math.min(i, 7)};${style}" aria-label="${esc(ariaFor(p, lane, ctx.stations))}"${ctx.example ? ' disabled' : ''}>
    <span class="pill">${inner}</span>${snip}</button>`
}

function stationHTML(s, style) {
  const lines = s.lines.map((l) => `<div class="st-line ${l.cls ?? ''}">${icon(l.icon)}<span>${esc(l.text)}</span></div>`).join('')
  return `<div class="station" data-st="${esc(s.id)}" style="${style}">
    <div class="st-head"><span class="st-icon">${icon(s.icon)}</span>
      <div style="min-width:0"><b>${esc(s.name)}</b><small>${esc(s.place)}</small></div></div>${lines}</div>`
}

function midnights(now, horizonH) {
  const out = []
  const d = new Date(now)
  d.setHours(24, 0, 0, 0)
  while ((d - now) / 36e5 < horizonH) {
    out.push(new Date(d))
    d.setDate(d.getDate() + 1)
  }
  return out
}

const curve = (x1, y1, x2, y2, vertical) =>
  vertical
    ? `M${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2 + 10}, ${x2} ${y2}`
    : `M${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2 - 10} ${y2}, ${x2} ${y2}`

// Posts that would overlap in one lane alternate between two rows, without snippet.
function rows(placed, gap) {
  const byLane = new Map()
  for (const it of placed) byLane.set(it.li, [...(byLane.get(it.li) ?? []), it])
  for (const list of byLane.values()) {
    list.sort((a, b) => a.pos - b.pos)
    list.forEach((it, i) => {
      const prev = list[i - 1]
      const next = list[i + 1]
      const tight = (prev && Math.abs(it.pos - prev.pos) < gap) || (next && Math.abs(next.pos - it.pos) < gap)
      it.compact = Boolean(tight)
      it.row = tight && prev && Math.abs(it.pos - prev.pos) < gap ? 1 - prev.row : 0
    })
  }
  return placed
}

function renderHorizontal(W, ctx) {
  const { lanes, posts, stations, now, horizon } = ctx
  const n = Math.max(lanes.length, 1)
  const AX = 44
  // Few channels get taller lanes so the track keeps its weight on screen.
  const LH = n > 6 ? 62 : Math.max(72, Math.min(132, (260 - AX - 14) / n))
  const TH = Math.max(AX + n * LH + 14, AX + stations.length * 104 + 24)
  const labelW = 196
  const zoneW = Math.min(380, Math.max(320, W * 0.27))
  const nowX = W - zoneW
  const L = labelW + 18 + TOKEN_W / 2
  const R = nowX - 30
  const x = (h) => R - (R - L) * Math.sqrt(Math.max(h, 0) / horizon)
  const laneY = (i) => AX + i * LH

  let s = `<defs><clipPath id="clip"><rect width="${W}" height="${TH}" rx="14"/></clipPath></defs><g clip-path="url(#clip)">`
  s += `<rect width="${W}" height="${TH}" fill="var(--track)"/>`
  s += `<rect width="${labelW}" height="${TH}" fill="var(--track-deep)"/>`
  s += `<rect x="${nowX}" width="${zoneW}" height="${TH}" fill="var(--track-zone)"/>`
  const mids = midnights(now, horizon)
  const ticks = [nowX, ...mids.map((m) => x((m - now) / 36e5)), labelW]
  let dayLabels = ''
  mids.forEach((m, i) => {
    const xr = ticks[i + 1]
    const xl = ticks[i + 2]
    if (i % 2 === 0) s += `<rect x="${xl}" y="${AX}" width="${xr - xl}" height="${TH - AX}" fill="oklch(97% .005 70)" fill-opacity=".045"/>`
    s += `<line x1="${xr}" x2="${xr}" y1="${AX - 10}" y2="${TH}" stroke="var(--lane)" stroke-opacity=".22"/>`
    if (xr - xl > 46) dayLabels += `<span class="axis-label num" style="left:${xr - 8}px;top:${AX / 2 - 9}px;transform:translateX(-100%)">${dayShort(m)} ${m.getDate()}</span>`
  })
  s += `<line x1="0" x2="${W}" y1="${AX}" y2="${AX}" stroke="var(--lane)" stroke-opacity=".28"/>`
  for (let i = 1; i < n; i++) s += `<line x1="${labelW}" x2="${nowX}" y1="${laneY(i)}" y2="${laneY(i)}" stroke="var(--lane)" stroke-opacity=".5" stroke-width="1.5"/>`
  for (let i = 1; i < n; i++) s += `<line x1="0" x2="${labelW}" y1="${laneY(i)}" y2="${laneY(i)}" stroke="var(--lane)" stroke-opacity=".14"/>`
  for (let i = 0; i <= n; i++) {
    const y = Math.min(laneY(i), TH - 1)
    s += `<path d="M${nowX - 16} ${y - 5} L${nowX - 6} ${y} L${nowX - 16} ${y + 5}Z" fill="var(--baton)"/>`
  }
  s += `<line x1="${nowX}" x2="${nowX}" y1="${AX}" y2="${TH}" stroke="var(--lane)" stroke-width="2"/>`

  const placed = rows(
    posts.map((p) => ({ p, li: Math.max(0, lanes.findIndex((l) => l.id === p.laneId)), pos: x((p.due - now) / 36e5) })),
    TOKEN_W + 8,
  )
  // Time marks on the lane edge only where the lane is short enough to read them with the pill.
  if (LH <= 72) placed.forEach(({ li, pos }) => {
    s += `<line x1="${pos}" x2="${pos}" y1="${laneY(li) + LH - 9}" y2="${laneY(li) + LH}" stroke="var(--baton)" stroke-width="2"/>`
  })

  const stX = nowX + 132
  const stW = W - stX - 16
  const m = stations.length
  const avail = TH - AX - 20
  const stH = m ? Math.min(132, LH * 2 - 20, (avail - 10 * (m - 1)) / m) : 0
  const stTop = AX + 10 + (avail - (m * stH + 10 * (m - 1))) / 2
  const st = stations.map((d, i) => ({ id: d.id, x: stX, y: stTop + i * (stH + 10), h: stH }))
  const sx = nowX + 66
  const sy = AX + LH / 2
  const routes = {}
  for (const k of st) {
    routes[k.id] = curve(sx, sy, k.x, k.y + k.h / 2, false)
    s += `<path class="route" d="${routes[k.id]}"/>`
  }
  for (const k of st) s += `<path class="trail" data-trail="${k.id}" d="${routes[k.id]}"/>`
  s += '</g>'

  let o = `<span class="axis-label" style="left:18px;top:${AX / 2 - 9}px">Buffer channels</span>`
  o += `<span class="axis-label later" style="left:${labelW + 14}px;top:${AX / 2 - 9}px">Later ${icon('arrow-right')}</span>`
  o += dayLabels
  o += `<span class="now-pill num" style="left:${nowX}px;top:${AX / 2}px">Now · ${dayShort(now)} ${hm(now)}</span>`
  o += `<span class="axis-label" style="left:${nowX + 66}px;top:${AX / 2 - 9}px">Destinations</span>`
  if (m && !ctx.example) o += `<button type="button" class="add-dest" data-act="add-dest" style="right:14px;top:${AX / 2 - 14}px">${icon('plus')}Add</button>`
  lanes.forEach((l, i) => {
    const pic = l.avatar ? `<img src="${esc(l.avatar)}" alt="" width="26" height="26" loading="lazy" referrerpolicy="no-referrer">` : icon(l.icon)
    o += `<div class="lane-label" style="left:0;top:${laneY(i)}px;height:${LH}px;width:${labelW}px">${pic}<div><b>${esc(l.name)}</b><span>${esc(l.handle)}</span></div></div>`
  })
  if (!lanes.length) o += `<div class="track-note" style="left:${labelW + 24}px;top:${AX + 24}px">No Buffer channels yet. Connect one in Buffer and it shows up here.</div>`
  else if (!posts.length) o += `<div class="track-note" style="left:${labelW + 24}px;top:${AX + LH / 2 - 10}px">Nothing scheduled in Buffer for this stretch.</div>`
  placed
    .sort((a, b) => a.p.due - b.p.due)
    .forEach(({ p, li, pos, row, compact }, i) => {
      const top = laneY(li) + LH / 2 + (compact ? row * 34 - 32 : -24)
      o += postButton(p, i, `left:${pos - TOKEN_W / 2}px;top:${top}px;width:${TOKEN_W}px`, ctx, compact)
    })
  o += `<img class="baton" src="/img/baton.webp" alt="" width="150" height="69" style="left:${nowX - 72}px;top:${sy - 38}px;width:150px">`
  stations.forEach((d, i) => {
    o += stationHTML(d, `left:${st[i].x}px;top:${st[i].y}px;width:${stW}px;height:${st[i].h}px`)
  })
  if (!m) {
    o += `<div class="zone-empty" style="left:${nowX + 24}px;top:${AX + 22}px;width:${zoneW - 48}px"><b>No destinations yet</b><span>Add a Discord channel or a Telegram channel and choose which posts hand off to it.</span><button type="button" class="btn baton-btn" data-act="add-dest">${icon('plus')}Add a destination</button></div>`
  }
  o += `<span class="runner" style="left:${sx}px;top:${sy}px"></span>`
  return { svg: s, overlay: o, W, TH, start: [sx, sy], ends: Object.fromEntries(st.map((v) => [v.id, [v.x, v.y + v.h / 2]])) }
}

function renderVertical(W, ctx) {
  const { lanes, posts, stations, now, horizon } = ctx
  const n = Math.max(lanes.length, 1)
  const m = stations.length
  const gap = 10
  const stW = m === 1 ? W - 28 : (W - 28 - gap) / 2
  const stH = 118
  const stRows = Math.max(1, Math.ceil(m / 2))
  const NY = 14 + stRows * stH + (stRows - 1) * gap + 64
  const LW = n > 5 ? 16 : 20
  const LX = 60
  const CX = LX + n * LW + 16
  const CW = W - CX - 12
  const T0 = NY + 50
  const K = 440
  const y = (h) => T0 + K * Math.sqrt(Math.max(h, 0) / horizon)
  const laneCx = (i) => LX + i * LW + LW / 2
  const cardH = 54

  let prevBottom = T0 - 12
  const placed = [...posts]
    .sort((a, b) => a.due - b.due)
    .map((p) => {
      const li = Math.max(0, lanes.findIndex((l) => l.id === p.laneId))
      const yy = y((p.due - now) / 36e5)
      const top = Math.max(yy - cardH / 2, prevBottom + 10)
      prevBottom = top + cardH
      return { p, li, yy, top }
    })
  const TH = Math.max(T0 + K, prevBottom) + 28

  let s = `<defs><clipPath id="clip"><rect width="${W}" height="${TH}" rx="14"/></clipPath></defs><g clip-path="url(#clip)">`
  s += `<rect width="${W}" height="${TH}" fill="var(--track)"/>`
  s += `<rect width="${W}" height="${NY}" fill="var(--track-zone)"/>`
  const mids = midnights(now, horizon)
  let dayLabels = ''
  mids.forEach((d, i) => {
    const yt = y((d - now) / 36e5)
    const yb = i + 1 < mids.length ? y((mids[i + 1] - now) / 36e5) : TH
    if (i % 2 === 0) s += `<rect x="0" y="${yt}" width="${W}" height="${yb - yt}" fill="oklch(97% .005 70)" fill-opacity=".045"/>`
    s += `<line x1="8" x2="${W - 8}" y1="${yt}" y2="${yt}" stroke="var(--lane)" stroke-opacity=".2"/>`
    if (yb - yt > 26) dayLabels += `<span class="axis-label num" style="left:10px;top:${yt + 6}px;font-size:11px;line-height:1.15;width:44px;white-space:normal">${dayShort(d)}<br>${d.getDate()}</span>`
  })
  for (let i = 0; i <= n; i++) s += `<line x1="${LX + i * LW}" x2="${LX + i * LW}" y1="${NY}" y2="${TH}" stroke="var(--lane)" stroke-opacity="${i === 0 || i === n ? 0.5 : 0.38}" stroke-width="1.5"/>`
  for (let i = 0; i <= n; i++) {
    const xx = LX + i * LW
    s += `<path d="M${xx - 5} ${NY + 15} L${xx} ${NY + 6} L${xx + 5} ${NY + 15}Z" fill="var(--baton)"/>`
  }
  s += `<line x1="0" x2="${W}" y1="${NY}" y2="${NY}" stroke="var(--lane)" stroke-width="2"/>`
  placed.forEach(({ p, li, yy, top }) => {
    const cx = laneCx(li)
    s += `<path d="M${cx} ${yy} L${CX - 14} ${yy} L${CX - 4} ${top + 15}" fill="none" stroke="var(--lane)" stroke-opacity=".55" stroke-width="1"/>`
    s += kindOf(p) === 'relay'
      ? `<circle cx="${cx}" cy="${yy}" r="5.5" fill="var(--baton)" stroke="var(--ink)" stroke-opacity=".35"/>`
      : `<circle cx="${cx}" cy="${yy}" r="4.5" fill="var(--track)" stroke="var(--lane)" stroke-width="1.5"/>`
  })
  const st = stations.map((d, i) => ({ id: d.id, x: 14 + (i % 2) * (stW + gap), y: 14 + Math.floor(i / 2) * (stH + gap) }))
  const sx = W / 2
  const sy = NY - 26
  const routes = {}
  for (const k of st) {
    routes[k.id] = curve(sx, sy, k.x + stW / 2, k.y + stH, true)
    s += `<path class="route" d="${routes[k.id]}"/>`
  }
  for (const k of st) s += `<path class="trail" data-trail="${k.id}" d="${routes[k.id]}"/>`
  s += '</g>'

  let o = dayLabels
  o += `<span class="now-pill num" style="left:${72}px;top:${NY}px">Now · ${dayShort(now)} ${hm(now)}</span>`
  if (m && !ctx.example) o += `<button type="button" class="add-dest" data-act="add-dest" style="right:12px;top:${NY - 15}px;background:var(--track-zone)">${icon('plus')}Add</button>`
  lanes.forEach((l, i) => {
    o += `<span title="${esc(l.name)}" style="position:absolute;left:${laneCx(i) - 8}px;top:${NY + 22}px;color:var(--lane);line-height:0">${icon(l.icon)}</span>`
  })
  if (!posts.length) o += `<div class="track-note" style="left:${CX}px;top:${T0 + 10}px;width:${CW}px">Nothing scheduled in Buffer for this stretch.</div>`
  else if (mids.length && placed[0].top > y((mids[0] - now) / 36e5)) {
    o += `<div class="track-note" style="left:${CX}px;top:${T0 - 4}px;width:${CW}px;font-size:12px">Rest of today: nothing scheduled</div>`
  }
  placed.forEach(({ p, top }, i) => {
    o += postButton(p, i, `left:${CX}px;top:${top}px;width:${CW}px`, ctx, false)
  })
  o += `<img class="baton" src="/img/baton.webp" alt="" width="124" height="57" style="left:${sx - 62}px;top:${sy - 30}px;width:124px">`
  stations.forEach((d, i) => {
    o += stationHTML(d, `left:${st[i].x}px;top:${st[i].y}px;width:${stW}px;height:${stH}px`)
  })
  if (!m) {
    o += `<div class="zone-empty" style="left:16px;top:16px;width:${W - 32}px"><b>No destinations yet</b><button type="button" class="btn baton-btn" data-act="add-dest">${icon('plus')}Add a destination</button></div>`
  }
  o += `<span class="runner" style="left:${sx}px;top:${sy}px"></span>`
  return { svg: s, overlay: o, W, TH, start: [sx, sy], ends: Object.fromEntries(st.map((v) => [v.id, [v.x + stW / 2, v.y + stH]])) }
}

export function renderTrack(root, ctx) {
  const svg = root.querySelector('svg.ground')
  const overlay = root.querySelector('.overlay')
  const W = Math.round(root.clientWidth)
  const geo = W < 700 ? renderVertical(W, ctx) : renderHorizontal(W, ctx)
  svg.setAttribute('viewBox', `0 0 ${W} ${geo.TH}`)
  svg.style.height = `${geo.TH}px`
  svg.innerHTML = geo.svg
  overlay.innerHTML = geo.overlay
  root.style.height = `${geo.TH}px`
  return geo
}

// The signature moment: the baton leaves the line of now and reaches each
// destination in the order the deliveries happened.
export function handoff(root, geo, destinationIds) {
  if (!geo || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const svg = root.querySelector('svg.ground')
  const overlay = root.querySelector('.overlay')
  const runner = overlay.querySelector('.runner')
  const baton = overlay.querySelector('.baton')
  const out = 'cubic-bezier(.23,1,.32,1)'
  const move = 'cubic-bezier(.77,0,.175,1)'
  baton?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.07) rotate(-2deg)' }, { transform: 'scale(1)' }], { duration: 260, easing: out })
  destinationIds.filter((id) => geo.ends[id]).forEach((id, idx) => {
    const delay = 140 + idx * 300
    const path = svg.querySelector(`[data-trail="${CSS.escape(id)}"]`)
    if (path) {
      const len = path.getTotalLength()
      path.style.strokeDasharray = len
      path.animate([{ opacity: 1, strokeDashoffset: len }, { opacity: 1, strokeDashoffset: 0, offset: 0.75 }, { opacity: 0, strokeDashoffset: 0 }], { duration: 900, delay, easing: 'linear', fill: 'both' })
    }
    const [sx, sy] = geo.start
    const [ex, ey] = geo.ends[id]
    const r = runner.cloneNode()
    overlay.appendChild(r)
    r.animate(
      [{ opacity: 1, transform: 'translate(0,0)' }, { opacity: 1, transform: `translate(${ex - sx}px,${ey - sy}px)`, offset: 0.92 }, { opacity: 0, transform: `translate(${ex - sx}px,${ey - sy}px) scale(.6)` }],
      { duration: 290, delay, easing: move, fill: 'both' },
    ).finished.then(() => r.remove())
    overlay.querySelector(`[data-st="${CSS.escape(id)}"]`)?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.035)' }, { transform: 'scale(1)' }], { duration: 260, delay: delay + 270, easing: out })
  })
}
