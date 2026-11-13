import { useState, type FormEvent } from 'react'
import { normalizeDomain, type SmartCollection } from './library'
import Dismissible from './Dismissible'

export default function SmartCollectionDialog({ initial, busy, save, remove, close }: { initial: SmartCollection; busy: boolean; save: (value: SmartCollection) => Promise<void>; remove?: () => Promise<void>; close: () => void }) {
  const [error, setError] = useState('')
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (busy) return
    const data = new FormData(e.currentTarget)
    try {
      await save({ id: initial.id, name: String(data.get('name')).trim(), rules: { text: String(data.get('text')).trim(), tags: [...new Set(String(data.get('tags')).split(',').map(t => t.trim()).filter(Boolean))], domain: normalizeDomain(String(data.get('domain'))), untagged: data.has('untagged'), inbox: data.has('inbox') } })
    } catch (e) { setError(String(e)) }
  }
  return <Dismissible close={close} busy={busy}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="smart-heading"><h2 id="smart-heading">Smart collection</h2><p>All rules must match. Results update automatically; no bookmark memberships change.</p>{error && <p role="alert">{error}</p>}<form onSubmit={submit}><label>Name<input name="name" required defaultValue={initial.name} /></label><label>Text<input name="text" defaultValue={initial.rules.text} /></label><label>All tags (comma separated)<input name="tags" defaultValue={initial.rules.tags.join(', ')} /></label><label>Exact domain (ignores www)<input name="domain" defaultValue={initial.rules.domain} placeholder="example.com" /></label><label><input type="checkbox" name="untagged" defaultChecked={initial.rules.untagged} />Untagged only</label><label><input type="checkbox" name="inbox" defaultChecked={initial.rules.inbox} />Inbox only (no collections)</label><footer><button type="button" disabled={busy} data-dismiss>Cancel</button>{remove && <button type="button" disabled={busy} onClick={() => void remove()}>Delete smart collection</button>}<button disabled={busy} type="submit">Save smart collection</button></footer></form></section></Dismissible>
}
