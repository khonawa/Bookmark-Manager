import { useState } from 'react'
import type { Bookmark } from './library'
import Dismissible from './Dismissible'

export default function DuplicateReview({ groups, collections, busy, close, merge }: { groups: Bookmark[][]; collections: { id: string; name: string }[]; busy: boolean; close: () => void; merge: (ids: string[], survivorId: string) => Promise<boolean> }) {
  const [chosen, setChosen] = useState('')
  const [groupIndex, setGroupIndex] = useState(0)
  const index = Math.min(groupIndex, Math.max(0, groups.length - 1))
  const group = groups[index]
  return <Dismissible close={close} busy={busy}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="duplicate-title">
    <div className="modal-heading"><h2 id="duplicate-title">Review duplicates</h2><button disabled={busy} data-dismiss aria-label="Close duplicate review">×</button></div>
    <p>Only identical normalized URLs are suggested. Query parameters and fragments remain significant. Choose the title to keep; notes, tags and collections are combined. Removed originals go to Trash and Undo is available.</p>
    {!group ? <p>No exact duplicate URLs found.</p> : <>
      <p>Group {index + 1} of {groups.length}</p><p style={{ overflowWrap: 'anywhere' }}>{group[0].url}</p>
      <div style={{ maxHeight: '45vh', overflow: 'auto' }}>{group.map(b => <label key={b.id} style={{ display: 'block', padding: 12 }}><input type="radio" disabled={busy} name="survivor" checked={chosen === b.id} onChange={() => setChosen(b.id)} /> Keep title: <strong>{b.title}</strong><p>{b.description || 'No notes'}</p><small>Tags: {b.tags.join(', ') || 'none'} · Collections: {b.collectionIds.map(id => collections.find(c => c.id === id)?.name ?? id).join(', ') || 'Inbox'} · Added: {b.createdAt}</small></label>)}</div>
      <div className="modal-actions"><button disabled={busy || index === 0} onClick={() => { setGroupIndex(index - 1); setChosen('') }}>Previous group</button><button disabled={busy || index + 1 >= groups.length} onClick={() => { setGroupIndex(index + 1); setChosen('') }}>Next group</button><button className="primary" disabled={busy || !group.some(b => b.id === chosen)} onClick={async () => { if (await merge(group.map(b => b.id), chosen)) setChosen('') }}>Merge this group</button></div>
    </>}
  </section></Dismissible>
}
