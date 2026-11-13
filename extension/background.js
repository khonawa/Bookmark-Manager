import { HOST, capture, flushQueue, connectionError } from './core.js'
const send = request => chrome.runtime.sendNativeMessage(HOST, request)
let serial = Promise.resolve()
function exclusive(task) {
  const result = serial.then(task)
  serial = result.catch(() => {})
  return result
}
async function badge(queue) {
  await chrome.action.setBadgeText({ text: queue.length ? String(queue.length) : '' })
  await chrome.action.setBadgeBackgroundColor({ color: queue.some(e => e.error) ? '#a32222' : '#495acc' })
}
async function retry() {
  const { queue = [], enabled = false } = await chrome.storage.local.get(['queue', 'enabled'])
  if (!enabled) return
  const remaining = await flushQueue(queue, send)
  await chrome.storage.local.set({ queue: remaining })
  await badge(remaining)
}
async function save(tab, defaults) {
  const { enabled = false, queue = [] } = await chrome.storage.local.get(['enabled', 'queue'])
  if (!enabled) throw new Error('Enable the connector in extension setup after explicitly pairing in desktop.')
  const request = capture(tab, defaults)
  if (queue.length >= 500) throw new Error('Queue is full (500). Retry or remove pending saves first.')
  // Persist before transport: browser closure or a lost acknowledgement cannot lose the request.
  queue.push({ request })
  await chrome.storage.local.set({ queue })
  await retry()
  const { queue: remaining = [] } = await chrome.storage.local.get('queue')
  const pending = remaining.find(entry => entry.request.requestId === request.requestId)
  return pending ? { ok: true, status: pending.error ? 'needs-attention' : 'queued', error: pending.error, transportError: pending.transportError } : { ok: true, status: 'saved-or-already-saved' }
}
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll()
  chrome.contextMenus.create({ id: 'save', title: 'Save to Bookmark Desk', contexts: ['page'], documentUrlPatterns: ['http://*/*', 'https://*/*'] })
  await chrome.alarms.create('retry', { periodInMinutes: 1 })
})
chrome.runtime.onStartup.addListener(() => { void chrome.alarms.create('retry', { periodInMinutes: 1 }); void exclusive(retry) })
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'retry') void exclusive(retry) })
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'save' || !tab) return
  void exclusive(async () => {
    const { defaults = {} } = await chrome.storage.local.get('defaults')
    try { const result = await save(tab, defaults); await chrome.storage.local.set({ lastStatus: result.status + (result.error ? ': ' + result.error : '') }) }
    catch (error) { await chrome.storage.local.set({ lastStatus: String(error) }); await chrome.action.setBadgeText({ text: '!' }) }
  })
})
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return false
  void exclusive(async () => {
    if (message.op === 'saveTab') return save(message.tab, message.defaults)
    if (message.op === 'retry') { await retry(); return { ok: true } }
    if (message.op === 'remove') {
      const { queue = [] } = await chrome.storage.local.get('queue')
      const remaining = queue.filter(e => e.request.requestId !== message.requestId)
      await chrome.storage.local.set({ queue: remaining }); await badge(remaining); return { ok: true }
    }
    if (message.op === 'repair') {
      const { queue = [] } = await chrome.storage.local.get('queue')
      for (const e of queue) delete e.error
      await chrome.storage.local.set({ queue }); await retry(); return { ok: true }
    }
    if (['catalog', 'check'].includes(message.op)) {
      const { enabled = false } = await chrome.storage.local.get('enabled')
      if (!enabled) throw new Error('Complete extension setup first.')
      return send(message)
    }
    throw new Error('Unknown action')
  }).then(respond, error => respond({ ok: false, error: connectionError(error) }))
  return true
})
