// Sample week for the signed-out page. It is drawn with the same track as the
// real app and labeled "Example week" on screen.

function at(dayOffset, h, m) {
  const d = new Date()
  d.setDate(d.getDate() + dayOffset)
  d.setHours(h, m, 0, 0)
  return d
}

export function example() {
  const now = new Date()
  const lanes = [
    { id: 'ig', name: 'Instagram', handle: '@northboundcoffee', icon: 'instagram-logo' },
    { id: 'li', name: 'LinkedIn', handle: 'Northbound Coffee', icon: 'linkedin-logo' },
    { id: 'th', name: 'Threads', handle: '@northboundcoffee', icon: 'threads-logo' },
    { id: 'bs', name: 'Bluesky', handle: 'northbound.coffee', icon: 'butterfly' },
  ]
  const posts = [
    { id: 'e1', laneId: 'ig', due: at(1, 9, 0), photo: true, dests: ['dc'], text: 'New single origin from Huila lands Thursday. 250 g bags.' },
    { id: 'e2', laneId: 'li', due: at(1, 12, 30), photo: false, dests: [], text: "We're hiring a weekend barista." },
    { id: 'e3', laneId: 'th', due: at(2, 8, 0), photo: false, dests: ['tg'], text: 'Cupping night this Friday at 7 pm. Twelve seats.' },
    { id: 'e4', laneId: 'ig', due: at(3, 10, 15), photo: true, dests: ['dc', 'tg'], text: 'Roast day. Huila went in at 8.' },
    { id: 'e5', laneId: 'bs', due: at(4, 9, 0), photo: false, dests: [], text: 'Huila is in. Bags are on the shelf.' },
    { id: 'e6', laneId: 'ig', due: at(5, 18, 0), photo: true, dests: ['dc'], text: 'Cupping night starts in an hour.' },
  ].filter((p) => p.due > now)
  const stations = [
    { id: 'dc', name: '#announcements', place: 'Discord channel', icon: 'discord-logo', lines: [{ icon: 'funnel-simple', text: 'Takes all of Instagram' }, { cls: 'ok', icon: 'check-circle', text: 'Last handoff +41 s, today' }] },
    { id: 'tg', name: 'Northbound Drops', place: 'Telegram channel', icon: 'telegram-logo', lines: [{ icon: 'funnel-simple', text: 'Takes tag Community' }, { cls: 'ok', icon: 'check-circle', text: 'Last handoff +38 s, today' }] },
  ]
  return { lanes, posts, stations, now, horizon: 168, selectedId: null, example: true }
}
