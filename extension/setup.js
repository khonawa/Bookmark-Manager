import { connectionError } from './core.js'
const $ = id => document.getElementById(id)
$('id').textContent = chrome.runtime.id
async function render() {
  const { enabled = false, queue = [] } = await chrome.storage.local.get(['enabled', 'queue'])
  $('enabled').checked = enabled
  $('queue').replaceChildren()
  for (const entry of queue) {
    const li = document.createElement('li')
    const text = document.createElement('p'); text.textContent = entry.request.title + ' — ' + entry.request.url + ' — ' + (entry.error || entry.transportError || 'Waiting for desktop — use Test connection to diagnose')
    const remove = document.createElement('button'); remove.textContent = 'Remove pending save'
    remove.onclick = async () => { await chrome.runtime.sendMessage({ op: 'remove', requestId: entry.request.requestId }); await render() }
    li.append(text, remove); $('queue').append(li)
  }
}
$('enabled').onchange = async () => { await chrome.storage.local.set({ enabled: $('enabled').checked }); await render() }
$('test').onclick = async () => {
  try {
    const result = await chrome.runtime.sendMessage({ op: 'catalog' })
    $('status').textContent = result.ok ? 'Connected to paired desktop. Collections: ' + result.collections.length : 'Not connected: ' + connectionError(result.error)
    if (result.ok) await chrome.storage.local.set({ catalogCollections: result.collections })
    await chrome.runtime.sendMessage({ op: 'retry' })
  } catch (error) { $('status').textContent = 'Not connected: ' + connectionError(error) }
  await render()
}
$('repair').onclick = async () => { await chrome.runtime.sendMessage({ op: 'repair' }); await render() }
await render()
