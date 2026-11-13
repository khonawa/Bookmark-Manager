const $ = id => document.getElementById(id)
const message = data => chrome.runtime.sendMessage(data)
let tab, draftKey, sourceUrl
let initialized = false
let revision = 0
let writes = Promise.resolve()
let collectionIds = []
const edited = new Set()
const selectedCollections = () => Array.from($('collections').selectedOptions, option => option.value)
const enqueue = operation => {
  writes = writes.catch(() => {}).then(operation)
  return writes
}
const persist = () => {
  if (!initialized || !draftKey) return
  const draft = { tabId: tab.id, sourceUrl, title: $('title').value, url: $('url').value, tags: $('tags').value, collectionIds: [...collectionIds] }
  void enqueue(() => chrome.storage.local.set({ [draftKey]: draft })).catch(error => { $('status').textContent = 'Draft not stored: ' + String(error) })
}
for (const id of ['title', 'url', 'tags', 'collections']) {
  const onEdit = () => {
    edited.add(id)
    revision++
    if (id === 'collections') collectionIds = selectedCollections()
    persist()
  }
  $(id).addEventListener('input', onEdit)
  $(id).addEventListener('change', onEdit)
}
const renderCollections = collections => {
  const choices = new Map(collections.map(c => [c.id, c.name]))
  for (const id of collectionIds) if (!choices.has(id)) choices.set(id, 'Offline collection: ' + id)
  $('collections').replaceChildren()
  for (const [id, name] of choices) {
    const option = new Option(name, id)
    option.selected = collectionIds.includes(id)
    $('collections').append(option)
  }
}
$('setup').onclick = () => chrome.runtime.openOptionsPage()
const localReady = (async () => {
  ;[tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  sourceUrl = tab?.url
  if (Number.isInteger(tab?.id) && sourceUrl) draftKey = 'popupDraft:' + tab.id
  const data = await chrome.storage.local.get(['defaults', 'lastStatus', 'catalogCollections', ...(draftKey ? [draftKey] : [])])
  const { defaults = {}, lastStatus = '', catalogCollections = [] } = data
  const stored = data[draftKey]
  const draft = stored?.tabId === tab?.id && stored?.sourceUrl === sourceUrl ? stored : undefined
  for (const [id, value] of Object.entries({ title: draft?.title ?? tab?.title ?? '', url: draft?.url ?? sourceUrl ?? '', tags: draft?.tags ?? (defaults.tags ?? []).join(', ') })) {
    if (!edited.has(id)) $(id).value = value
  }
  if (!edited.has('collections')) collectionIds = draft?.collectionIds ?? defaults.collectionIds ?? []
  renderCollections(catalogCollections)
  $('status').textContent = lastStatus
  initialized = true
  if (edited.size) persist()
})()
$('save').onsubmit = async event => {
  event.preventDefault()
  $('submit').disabled = true
  try {
    await localReady
    const submittedRevision = revision
    const defaults = { tags: $('tags').value.split(',').map(t => t.trim()).filter(Boolean), collectionIds: selectedCollections() }
    const result = await message({ op: 'saveTab', tab: { ...tab, url: $('url').value, title: $('title').value }, defaults })
    if (!result.ok) throw new Error(result.error)
    if (result.status !== 'needs-attention' && ['queued', 'saved', 'already-saved', 'saved-or-already-saved'].includes(result.status) && revision === submittedRevision && draftKey) {
      await enqueue(() => chrome.storage.local.remove(draftKey))
    }
    if ($('remember').checked) await chrome.storage.local.set({ defaults })
    $('status').textContent = result.status === 'queued' ? 'Queued locally. ' + (result.transportError ? result.transportError + ' ' : '') + 'Keep this extension installed; automatic retry runs once per minute while the browser is open.' : result.status === 'needs-attention' ? 'Not saved: ' + result.error + ' Open pending queue.' : 'Desktop confirmed: saved or already saved (no duplicate).'
  } catch (error) { $('status').textContent = String(error) }
  finally { $('submit').disabled = false }
}
try {
  await localReady
  const catalog = await message({ op: 'catalog' })
  if (!catalog.ok) throw new Error(catalog.error)
  renderCollections(catalog.collections)
  await chrome.storage.local.set({ catalogCollections: catalog.collections })
  for (const tag of catalog.tags ?? []) $('known-tags').append(new Option(tag, tag))
  const check = await message({ op: 'check', url: sourceUrl })
  if (!check.ok) throw new Error(check.error)
  $('connection').textContent = check.saved ? 'Already saved. Saving again will not duplicate or overwrite it.' : 'Desktop connected.'
} catch (error) {
  $('connection').textContent = 'Desktop unavailable: ' + String(error) + ' Saves can be queued after setup. Cached collection defaults will be retained.'
}

