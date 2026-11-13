import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Bookmark as Mark, Library as LibraryIcon, Inbox, Tags, Folder, Plus, Search, Upload, ArrowUpRight, X, Check, SlidersHorizontal, Trash2, Pencil, Undo2, Info } from 'lucide-react'
import { bulkOrganize, normalizeDomain, deleteCollection, updateCollection, renameTag, trashBookmarks, restoreBookmarks, emptyLibrary, exportHtml, mergeLibrary, normalizeUrl, parseBookmarkHtml, urlKey, validateLibrary, type SmartCollection, type Bookmark, type Library } from './library'
import { desktop, download, loadLibrary, openBookmark, saveLibrary, queryBookmarks, queryBookmarkIds, libraryChanged } from './storage'
import { organizationDrop, validateOrganizationDrop, organizationMime, type OrganizationDrag } from './organization'
import BackupSettings from './BackupSettings'
import ExtensionSetup from './ExtensionSetup'
import SmartCollectionDialog from './SmartCollectionDialog'
import { queryLibrary, type BookmarkPage } from './queries'
import { duplicateGroups, mergeDuplicates } from './duplicates'
import SiteIcon from './SiteIcon'
import DuplicateReview from './DuplicateReview'
import { getMetadata } from './metadata'
import Dismissible from './Dismissible'
import ExportMenu from './ExportMenu'

export default function Workspace() {
  const [library, setLibrary] = useState<Library>(emptyLibrary)
  const [ready, setReady] = useState(false)
  const [extensionSetup, setExtensionSetup] = useState(false)
  const [backupSettings, setBackupSettings] = useState(false)
  const drag = useRef<OrganizationDrag | null>(null)
  const [dragging, setDragging] = useState(false)
  const [dropIndicator, setDropIndicator] = useState<{ target: string | null; valid: boolean } | null>(null)
  function endDrag() { drag.current = null; setDragging(false); setDropIndicator(null) }
  function startDrag(e: React.DragEvent, payload: OrganizationDrag) {
    if (lock.current || !ready || selecting) { e.preventDefault(); return }
    drag.current = payload; setDragging(true)
    e.dataTransfer.setData(organizationMime, 'internal'); e.dataTransfer.effectAllowed = 'move'
  }
  function dropEvents(target: string | null) {
    function valid() {
      try { if (!drag.current || lock.current || !ready) return false; validateOrganizationDrop(latestLibrary.current, drag.current, scope, target); return true } catch { return false }
    }
    return {
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault(); const allowed = valid(); e.dataTransfer.dropEffect = allowed ? 'move' : 'none'
        setDropIndicator({ target, valid: allowed })
      },
      onDragLeave: () => setDropIndicator(null),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault()
        try {
          if (!valid() || !drag.current) throw new Error('Invalid or stale drop. Use a normal collection; collections cannot contain themselves or descendants.')
          const payload = drag.current
          const next = organizationDrop(latestLibrary.current, payload, scope, target)
          void commit(next, payload.kind === 'bookmarks' ? `Moved ${payload.ids.length} bookmarks; previous memberships replaced. Undo available.` : 'Collection moved. Undo available.', true, payload.baseline)
        } catch (error) { setError(String(error)) }
        finally { endDrag() }
      },
    }
  }
  function dropClass(target: string | null) { return dropIndicator?.target === target ? dropIndicator.valid ? ' drop-valid' : ' drop-invalid' : '' }
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [view, setView] = useState('all')
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState('')
  const [domain, setDomain] = useState('')
  const [smartDialog, setSmartDialog] = useState<SmartCollection | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [sort, setSort] = useState('newest')
  const [page, setPage] = useState(0)
  const [selection, setSelection] = useState<{ scope: string; ids: Set<string> }>({ scope: '', ids: new Set() })
  const scope = JSON.stringify([view, tag, query, domain, revision])
  const activeScope = useRef(scope)
  const selectionRequest = useRef(0)
  useEffect(() => { activeScope.current = scope; selectionRequest.current++ }, [scope])
  if (selection.scope !== scope) setSelection({ scope, ids: new Set() })
  const selected = selection.scope === scope ? selection.ids : new Set<string>()
  function setSelected(ids: Set<string>) { selectionRequest.current++; setSelection({ scope, ids }) }
  const [editor, setEditor] = useState<Partial<Bookmark> | null>(null)
  const [fetchingTitle, setFetchingTitle] = useState(false)
  const titleRequest = useRef(0)
  async function suggestTitle(input: HTMLInputElement) {
    const form = input.form
    if (!form) return
    const titleInput = form.elements.namedItem('title') as HTMLInputElement
    if (titleInput.value.trim()) return
    const request = ++titleRequest.current
    const originalUrl = input.value
    try {
      normalizeUrl(originalUrl)
      setFetchingTitle(true)
      const metadata = await getMetadata(originalUrl)
      if (request === titleRequest.current && form.isConnected && input.value === originalUrl && !titleInput.value.trim() && metadata.title) titleInput.value = metadata.title
    } catch { /* Keep the title editable when a website cannot be reached. */ }
    finally { if (request === titleRequest.current) setFetchingTitle(false) }
  }
  const [collectionDialog, setCollectionDialog] = useState<string | null>(null)
  const [tagDialog, setTagDialog] = useState(false)
  const [confirmation, setConfirmation] = useState<{ message: string; apply: () => Promise<void> } | null>(null)
  function confirmChange(message: string, next: Library, permanent = false) {
    const baseline = latestLibrary.current
    setConfirmation({ message, apply: async () => {
      if (baseline !== latestLibrary.current) { setError('Library changed while confirming. Please review and try again.'); setConfirmation(null); return }
      if (await commit(next, permanent ? 'Permanently deleted' : 'Collection deleted; bookmarks kept and children moved to its parent', !permanent)) {
        if (permanent) setPrevious(null)
        setConfirmation(null)
        if (!permanent) { setCollectionDialog(null); navigate('all') }
      }
    } })
  }
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const preview = library.bookmarks.find(b => b.id === previewId)
  const [previous, setPrevious] = useState<Library | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const lock = useRef(false)
  const latestLibrary = useRef(library)
  useEffect(() => { loadLibrary().then(data => { latestLibrary.current = data; setLibrary(data); setReady(true) }).catch(e => setError(`Could not load library: ${String(e)}. Stored data has not been changed.`)) }, [])
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); searchInput.current?.focus() } }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
  async function commit(next: Library, message: string, remember = true, baseline = library) {
    if (lock.current || !ready) return false
    if (baseline !== latestLibrary.current) { setError('Library changed. Please retry this action.'); return false }
    lock.current = true; setBusy(true); setError('')
    try {
      await saveLibrary(next)
      if (remember) setPrevious(baseline)
      latestLibrary.current = next
      setLibrary(next); setRevision(v => v + 1); setSelection({ scope: '', ids: new Set() }); setNotice(message)
      return true
    } catch (e) { setError(`Could not save: ${String(e)}`); return false }
    finally { lock.current = false; setBusy(false) }
  }
  useEffect(() => {
    if (!desktop || !ready) return
    let active = true
    const timer = setInterval(() => {
      if (lock.current) return
      lock.current = true
      void (async () => {
        try {
          if (await libraryChanged()) {
            const data = await loadLibrary()
            if (!active) return
            latestLibrary.current = data; setLibrary(data); setRevision(v => v + 1)
            setPrevious(null); setSelection({ scope: '', ids: new Set() }); setNotice('Library refreshed from desktop connector. Undo cleared to protect external saves.')
          }
        } catch (error) { if (active) setError(`Could not refresh desktop library: ${String(error)}`) }
        finally { lock.current = false }
      })()
    }, 2000)
    return () => { active = false; clearInterval(timer) }
  }, [ready])
  const allTags = [...new Set(library.bookmarks.flatMap(b => b.tags))].sort()
  const groups = useMemo(() => duplicateGroups(library), [library])
  const [duplicateReview, setDuplicateReview] = useState(false)
  const [remote, setRemote] = useState<{ key: string; result: BookmarkPage } | null>(null)
  const [queryError, setQueryError] = useState('')
  const queryKey = JSON.stringify([view, tag, query, domain, sort, page, revision])
  async function selectMatching() {
    const captured = scope, baseline = library
    const request = ++selectionRequest.current
    setSelecting(true)
    try {
      const ids = await queryBookmarkIds(baseline, { view, tag, query, domain, sort, page: 0 })
      if (request === selectionRequest.current && activeScope.current === captured && latestLibrary.current === baseline) setSelected(new Set(ids))
    } catch (e) { setError(String(e)) }
    finally { setSelecting(false) }
  }
  useEffect(() => {
    if (!desktop || !ready) return
    let active = true
    const timer = setTimeout(() => {
      setQueryError('')
      queryBookmarks(emptyLibrary, { view, tag, query, domain, sort, page }).then(result => {
        if (active) setRemote({ key: queryKey, result })
      }).catch(e => { if (active) setQueryError(`Could not search: ${String(e)}`) })
    }, 120)
    return () => { active = false; clearTimeout(timer) }
  }, [ready, view, tag, query, domain, sort, page, queryKey])
  const localPage = useMemo(() => desktop ? null : queryLibrary(library, { view, tag, query, domain, sort, page }), [library, view, tag, query, domain, sort, page])
  const result = desktop ? remote?.key === queryKey ? remote.result : null : localPage
  const querying = ready && !result && !queryError
  const total = result?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / 75))
  const currentPage = Math.min(page, pageCount - 1)
  const visible = result?.bookmarks ?? []
  const title = view === 'trash' ? 'Trash' : view === 'all' ? 'All bookmarks' : view === 'inbox' ? 'Inbox' : view === 'untagged' ? 'Untagged' : library.smartCollections?.find(c => `smart:${c.id}` === view)?.name ?? library.collections.find(c => c.id === view)?.name ?? 'Collection'
  function navigate(value: string) { setView(value); setTag(''); setDomain(''); setPreviewId(null); setPage(0); setSelected(new Set()) }
  async function saveBookmark(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const data = new FormData(e.currentTarget)
    try {
      const url = normalizeUrl(String(data.get('url')))
      if (library.bookmarks.some(b => b.id !== editor?.id && urlKey(b.url) === urlKey(url))) throw new Error('This URL is already saved. Search for it to edit its collections or tags.')
      const bookmark: Bookmark = { id: editor?.id ?? crypto.randomUUID(), title: String(data.get('title')).trim() || new URL(url).hostname, url, description: String(data.get('description')).trim(), tags: [...new Set(String(data.get('tags')).split(',').map(t => t.trim()).filter(Boolean))], collectionIds: data.getAll('collections').map(String), createdAt: editor?.createdAt ?? new Date().toISOString() }
      const next = { ...library, bookmarks: editor?.id ? library.bookmarks.map(b => b.id === editor.id ? bookmark : b) : [bookmark, ...library.bookmarks] }
      if (await commit(next, editor?.id ? 'Bookmark updated' : 'Bookmark saved')) {
        setEditor(null)
        if (!String(data.get('title')).trim()) void fillSavedTitle(bookmark)
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  async function fillSavedTitle(original: Bookmark) {
    try {
      const metadata = await getMetadata(original.url)
      if (!metadata.title) return
      while (lock.current) await new Promise(resolve => setTimeout(resolve, 30))
      const current = latestLibrary.current
      const bookmark = current.bookmarks.find(b => b.id === original.id)
      if (!bookmark || bookmark.url !== original.url || bookmark.title !== original.title) return
      lock.current = true
      try {
        const next = { ...current, bookmarks: current.bookmarks.map(b => b.id === original.id ? { ...b, title: metadata.title! } : b) }
        await saveLibrary(next)
        latestLibrary.current = next
        setRevision(v => v + 1); setSelected(new Set())
        setLibrary(next)
      } finally { lock.current = false }
    } catch { /* Saving a link must succeed even if metadata is unavailable. */ }
  }
  async function importFile(file: File) {
    try {
      const content = await file.text()
      let imported: Library
      if (file.name.toLowerCase().endsWith('.json')) {
        const backup = JSON.parse(content)
        if (backup.version !== 1) throw new Error('Unsupported backup version.')
        imported = validateLibrary(backup.library)
      } else imported = parseBookmarkHtml(content)
      const current = latestLibrary.current
      const next = mergeLibrary(current, imported)
      await commit(next, `Imported ${next.bookmarks.length - current.bookmarks.length} new bookmarks. Duplicate URLs merged.`, true, current)
    } catch (e) { setError(`Import failed: ${String(e)}`) }
  }
  function collectionPath(id: string): string {
    const c = library.collections.find(c => c.id === id)
    return c ? (c.parentId ? `${collectionPath(c.parentId)} / ` : '') + c.name : ''
  }
  function renderCollections(parentId: string | null = null, depth = 0): React.ReactNode {
    return library.collections.filter(c => c.parentId === parentId).map(c => {
      const children = library.collections.some(child => child.parentId === c.id)
      return <div key={c.id}><div className="tree-row" style={{ paddingLeft: depth * 14 }}>
        <button className="tree-toggle" aria-label={`${collapsed.has(c.id) ? 'Expand' : 'Collapse'} ${c.name}`} disabled={!children} onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(c.id)) next.delete(c.id); else next.add(c.id); return next })}>{children ? collapsed.has(c.id) ? '›' : '⌄' : ''}</button>
        <button draggable={!disabled} onDragStart={e => startDrag(e, { kind: 'collection', id: c.id, scope, baseline: library })} onDragEnd={endDrag} {...dropEvents(c.id)} title={`${collectionPath(c.id)} — drop bookmarks to MOVE (replace memberships), or a collection to reparent`} className={`nav-item ${view === c.id ? 'active' : ''}${dropClass(c.id)}`} onClick={() => navigate(c.id)}><Folder size={16} /><span className="collection-name">{c.name}</span><span>{library.bookmarks.filter(b => b.collectionIds.includes(c.id)).length}</span></button>
        <button className="tree-manage" aria-label={`Manage ${c.name}`} disabled={disabled} onClick={() => { setError(''); setCollectionDialog(c.id) }}><Pencil size={12} /></button>
      </div>{!collapsed.has(c.id) && renderCollections(c.id, depth + 1)}</div>
    })
  }
  function newSmart() {
    try {
      setSmartDialog({ id: crypto.randomUUID(), name: '', rules: { text: query, tags: tag ? [tag] : [], domain: normalizeDomain(domain), inbox: view === 'inbox', untagged: view === 'untagged' } })
    } catch(e) { setError(String(e)) }
  }
  function toggle(id: string, checked: boolean) { const next = new Set(selected); if (checked) next.add(id); else next.delete(id); setSelected(next) }
  const disabled = busy || !ready
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><Mark size={21} fill="currentColor" /></span><span>bookmark<span className="brand-light">desk</span><small>A little order for your internet.</small></span></div>
      <div className="workspace-label">WORKSPACE</div>
      <button onClick={() => setExtensionSetup(true)}>Browser extension</button>
      <button disabled={disabled} onClick={() => setBackupSettings(true)}>Backups & restore</button>
      {backupSettings && <BackupSettings close={() => setBackupSettings(false)} restore={async incoming => {
        const baseline = latestLibrary.current
        const next = mergeLibrary(baseline, incoming)
        return commit(next, 'Backup merged safely; existing bookmarks kept. Undo available.', true, baseline)
      }} />}
      {extensionSetup && <ExtensionSetup close={() => setExtensionSetup(false)} />}
      <button disabled={disabled} onClick={() => setDuplicateReview(true)}>Review duplicates ({groups.length})</button>
      <nav aria-label="Library views">
        <button className={`nav-item ${view === 'all' ? 'active' : ''}`} onClick={() => navigate('all')}><LibraryIcon size={18} />All bookmarks<span>{library.bookmarks.length}</span></button>
        <button className={`nav-item ${view === 'inbox' ? 'active' : ''}`} onClick={() => navigate('inbox')}><Inbox size={18} />Inbox<span>{library.bookmarks.filter(b => !b.collectionIds.length).length}</span></button>
        <button className={`nav-item ${view === 'untagged' ? 'active' : ''}`} onClick={() => navigate('untagged')}><Tags size={18} />Untagged<span>{library.bookmarks.filter(b => !b.tags.length).length}</span></button>
        <button className={`nav-item ${view === 'trash' ? 'active' : ''}`} onClick={() => navigate('trash')}><Trash2 size={18} />Trash<span>{library.trash?.length ?? 0}</span></button>
      </nav>
      <section className="sidebar-section collections-section" aria-label="Collections"><div className="section-label" role="heading" aria-level={2}>COLLECTIONS<button aria-label="New collection" disabled={disabled} onClick={() => { setError(''); setCollectionDialog('new') }}><Plus size={16} /></button></div>
      {dragging && <p role="status" className="sidebar-hint">Drop bookmarks to MOVE: replaces all memberships. Smart collections cannot receive drops. Undo available.</p>}
      <button className={`collection-root${dropClass(null)}`} {...dropEvents(null)} title="Drop a collection here to move it to top level">Collection top level (drop collection)</button>
      <div className="collection-list" tabIndex={0} aria-label="Scroll collections">{renderCollections()}{!library.collections.length && <p className="sidebar-hint">Make room for your interests.<br />Create your first collection.</p>}</div>
      </section><section className="sidebar-section smart-section" aria-label="Smart collections"><div className="section-label" role="heading" aria-level={2}>SMART COLLECTIONS<button aria-label="New smart collection" disabled={disabled} onClick={() => newSmart()}><Plus size={16} /></button></div>
      <div className="smart-list" tabIndex={0} aria-label="Scroll smart collections">{(library.smartCollections ?? []).map(c => <div className="tree-row" key={c.id}><button {...dropEvents('smart:' + c.id)} title="Smart collection: not a drop destination" className={`nav-item ${view === 'smart:' + c.id ? 'active' : ''}${dropClass('smart:' + c.id)}`} onClick={() => navigate('smart:' + c.id)}>{c.name}</button><button aria-label={`Edit smart collection ${c.name}`} disabled={disabled} onClick={() => setSmartDialog(c)}><Pencil size={12} /></button></div>)}
      </div></section><section className="sidebar-section tags-section" aria-label="Tags"><div className="section-label" role="heading" aria-level={2}>TAGS<button aria-label="Manage tags" disabled={disabled} onClick={() => { setError(''); setTagDialog(true) }}><Pencil size={14} /></button></div><div className="tag-cloud" tabIndex={0} aria-label="Scroll tags">{allTags.map(t => <button className={`tag-chip ${tag === t ? 'chosen' : ''}`} key={t} onClick={() => { setTag(tag === t ? '' : t); setPage(0) }}># {t}</button>)}{!allTags.length && <p className="sidebar-hint">Your labels will appear here.</p>}</div>
      </section><div className="sidebar-bottom"><span className="status-dot" /><div>Local-first. Yours to keep.<small>{desktop ? 'SQLite on this device' : 'Browser preview · local storage'}</small></div></div>
    </aside>
    <main>
      <header className="topbar"><div className="breadcrumb">My library <span>/</span> <strong>{title}</strong></div><div className="top-actions"><button disabled={disabled} onClick={() => fileInput.current?.click()}><Upload size={16} />Import</button><ExportMenu><button disabled={disabled} onClick={() => download('bookmark-desk-backup.json', JSON.stringify({ version: 1, library }, null, 2), 'application/json')}>Full JSON backup</button><button disabled={disabled} onClick={() => download('bookmarks.html', exportHtml(library), 'text/html')}>Browser bookmarks HTML</button></ExportMenu></div></header>
      <div className="content">
        <div className="page-heading"><div><h1><Folder size={20} />{title}<span>{total}</span></h1></div><button className="primary" disabled={disabled} onClick={() => { setError(''); setEditor({ collectionIds: library.collections.some(c => c.id === view) ? [view] : [] }) }}><Plus size={18} />Add bookmark</button></div>
        {queryError && <div role="alert" className="message error">{queryError}<button onClick={() => setRevision(v => v + 1)}>Retry search</button></div>}
        {error && <div role="alert" className="message error">{error}<button aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}
        {notice && <div role="status" className="message"><Check size={16} />{notice}{previous && <button disabled={disabled} onClick={async () => { if (await commit(previous, 'Last change undone', false)) setPrevious(null) }}><Undo2 size={14} />Undo</button>}<button aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={16} /></button></div>}
        <div className="filterbar"><label className="search"><Search size={18} /><input ref={searchInput} value={query} onChange={e => { setQuery(e.target.value); setPage(0) }} placeholder="Search titles, links, notes, or tags…" aria-label="Search bookmarks" /><kbd>Ctrl K</kbd></label><label className="sort"><SlidersHorizontal size={16} /><select aria-label="Sort bookmarks" value={sort} onChange={e => setSort(e.target.value)}><option value="newest">Newest first</option><option value="title">Title A–Z</option><option value="domain">Website</option></select></label></div>
        <label>Domain<input aria-label="Filter domain" value={domain} placeholder="example.com" onChange={e => { setDomain(e.target.value); setPage(0) }} /></label>
        {view !== 'trash' && <button disabled={disabled} onClick={newSmart}>Save search as smart collection</button>}
        <div className="bulkbar"><button disabled={disabled || selecting || querying || !total} onClick={() => void selectMatching()}>Select all {total} matching</button><span>{selected.size} selected (across pages)</span><button disabled={!selected.size} onClick={() => setSelected(new Set())}>Clear selection</button></div>
        {tag && <button className="tag-chip chosen filter-tag" onClick={() => setTag('')}># {tag}<X size={12} /></button>}
        {view === 'trash' && <div className="bulkbar"><span>Trash is kept until permanently deleted.</span><button disabled={disabled || !selected.size} onClick={() => void commit(restoreBookmarks(library, selected), 'Bookmarks restored; duplicate URLs merged')}>Restore selected</button><button className="danger" disabled={disabled || !selected.size} onClick={() => confirmChange('Permanently delete selected bookmarks? This cannot be undone.', { ...library, trash: (library.trash ?? []).filter(b => !selected.has(b.id)) }, true)}>Delete permanently</button><button className="danger" disabled={disabled || !library.trash?.length} onClick={() => confirmChange('Empty all trash? This cannot be undone.', { ...library, trash: [] }, true)}>Empty trash</button></div>}
        {view !== 'trash' && selected.size > 0 && <div className="bulkbar"><strong>{selected.size} selected</strong><select aria-label="Add selected to collection" value="" disabled={disabled} onChange={e => { const id = e.target.value; if (id) void commit({ ...library, bookmarks: library.bookmarks.map(b => selected.has(b.id) ? { ...b, collectionIds: [...new Set([...b.collectionIds, id])] } : b) }, 'Bookmarks added to collection') }}><option value="">Add to collection…</option>{library.collections.map(c => <option key={c.id} value={c.id}>{collectionPath(c.id)}</option>)}</select><form onSubmit={e => { e.preventDefault(); const form = e.currentTarget; const tags = String(new FormData(form).get('tags')).split(',').map(t => t.trim()).filter(Boolean); if (tags.length) void commit({ ...library, bookmarks: library.bookmarks.map(b => selected.has(b.id) ? { ...b, tags: [...new Set([...b.tags, ...tags])] } : b) }, 'Tags added'); form.reset() }}><input name="tags" placeholder="Tags, comma separated" aria-label="Bulk tags" /><button disabled={disabled}>Apply</button></form><button className="danger" disabled={disabled} onClick={() => void commit(trashBookmarks(library, selected), 'Bookmarks moved to Trash')}><Trash2 size={15} />Delete</button><button aria-label="Clear selection" onClick={() => setSelected(new Set())}><X size={16} /></button></div>}
        {view !== 'trash' && selected.size > 0 && <div className="bulkbar"><select aria-label="Move selected to collection" value="" disabled={disabled} onChange={e => { if(e.target.value) void commit(bulkOrganize(library, selected, 'move', [e.target.value]), 'Bookmarks moved; previous memberships replaced') }}><option value="">Move to collection (replace memberships)?</option>{library.collections.map(c => <option key={c.id} value={c.id}>{collectionPath(c.id)}</option>)}</select><form onSubmit={e => { e.preventDefault(); const values = String(new FormData(e.currentTarget).get('removeTags')).split(',').map(t => t.trim()).filter(Boolean); if(values.length) void commit(bulkOrganize(library, selected, 'removeTags', values), 'Tags removed; Undo available') }}><input name="removeTags" aria-label="Remove tags in bulk" placeholder="Tags to remove, comma separated" /><button disabled={disabled}>Remove tags</button></form></div>}
        <div className="list-heading"><label><input type="checkbox" aria-label="Select this page" checked={visible.length > 0 && visible.every(b => selected.has(b.id))} onChange={e => { const next = new Set(selected); visible.forEach(b => e.target.checked ? next.add(b.id) : next.delete(b.id)); setSelected(next) }} />BOOKMARK</label><span>COLLECTION / TAGS</span><span /></div>
        {(!ready && !error) || querying ? <div className="empty">{ready ? 'Searching library…' : 'Opening your library…'}</div> : total === 0 ? <div className="empty"><div className="empty-icon"><Mark size={32} /></div><h2>{library.bookmarks.length ? 'No bookmarks here yet' : 'Your internet, organized.'}</h2><p>{query || tag ? 'Try a different search or clear your filters.' : 'Bring your bookmarks together. Give every good link a home.'}</p><div><button className="primary" disabled={disabled} onClick={() => fileInput.current?.click()}><Upload size={16} />Import bookmarks</button><button disabled={disabled} onClick={() => setEditor({})}><Plus size={16} />Save a link</button></div><small>Import browser bookmarks HTML or a Bookmark Desk JSON backup.</small></div> : <div className="bookmark-list">{visible.map(b => <article key={b.id} draggable={view !== 'trash' && !disabled && !selecting} onDragStart={e => startDrag(e, { kind: 'bookmarks', ids: selected.has(b.id) ? [...selected] : [b.id], scope, baseline: library })} onDragEnd={endDrag} title="Drag to a normal collection to move; replaces all memberships. Selected bookmarks move together across pages." className={`bookmark-row ${selected.has(b.id) ? 'selected' : ''}`}><div className="bookmark-main"><input aria-label={`Select ${b.title}`} type="checkbox" checked={selected.has(b.id)} onChange={e => toggle(b.id, e.target.checked)} /><SiteIcon url={b.url} /><div className="bookmark-text"><button className="bookmark-title" onClick={() => void openBookmark(b.url).catch(e => setError(String(e)))}>{b.title}<ArrowUpRight size={13} /></button><div className="url" title={b.url}>{new URL(b.url).hostname.replace(/^www\./, '')}<span> · {b.url.replace(/^https?:\/\/[^/]+\/?/, '') || '/'}</span></div>{b.description && <p className="description">{b.description}</p>}</div></div><div className="row-labels">{b.collectionIds.map(id => <button className="collection-chip" key={id} onClick={() => navigate(id)}><Folder size={11} />{library.collections.find(c => c.id === id)?.name}</button>)}{b.tags.map(t => <button key={t} className="tag-chip" onClick={() => { setTag(t); setPage(0) }}># {t}</button>)}</div>{view === 'trash' ? <button className="edit-button" disabled={disabled} aria-label={`Restore ${b.title}`} onClick={() => void commit(restoreBookmarks(library, new Set([b.id])), 'Bookmark restored; duplicate URLs merged')}><Undo2 size={15} /></button> : <div className="bookmark-actions"><button className="edit-button" aria-label={`Details for ${b.title}`} title="Bookmark details" onClick={() => setPreviewId(b.id)}><Info size={15} /></button><button className="edit-button" aria-label={`Edit ${b.title}`} title="Edit bookmark" onClick={() => { setError(''); setEditor(b) }}><Pencil size={15} /></button></div>}</article>)}</div>}
        <footer className="list-footer"><span>{total ? `${currentPage * 75 + 1}–${Math.min((currentPage + 1) * 75, total)} of ${total} bookmarks` : 'A clearer space for your saved links.'}</span><div><button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><span>{currentPage + 1} / {pageCount}</span><button disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>Next</button></div></footer>
        <div className="local-note"><span className="status-dot" />No accounts. No tracking. Just your bookmarks.</div>
      </div>
    </main>
    {smartDialog && <SmartCollectionDialog initial={smartDialog} busy={disabled} close={() => setSmartDialog(null)} save={async value => { const next = validateLibrary({ ...library, smartCollections: [...(library.smartCollections ?? []).filter(c => c.id !== value.id), value] }); if (await commit(next, 'Smart collection saved')) { setSmartDialog(null); navigate('smart:' + value.id) } }} remove={library.smartCollections?.some(c => c.id === smartDialog.id) ? async () => { if(await commit({ ...library, smartCollections: library.smartCollections?.filter(c => c.id !== smartDialog.id) }, 'Smart collection deleted; bookmarks kept')) { setSmartDialog(null); navigate('all') } } : undefined} />}
    {duplicateReview && <DuplicateReview groups={groups} collections={library.collections} busy={disabled} close={() => setDuplicateReview(false)} merge={async (ids, survivorId) => { try { return await commit(mergeDuplicates(latestLibrary.current, ids, survivorId), 'Duplicates merged; originals kept in Trash') } catch (e) { setError(String(e)); return false } }} />}
    {preview && <Dismissible modal={false} className="detail-layer" close={() => setPreviewId(null)}><aside className="detail-panel" aria-label="Bookmark details"><header><span>Bookmark details</span><button aria-label="Close details" onClick={() => setPreviewId(null)}><X size={18} /></button></header><div className="detail-body"><div className="detail-cover"><SiteIcon url={preview.url} /></div><small className="detail-domain">{new URL(preview.url).hostname}</small><h2>{preview.title}</h2><a className="detail-url" href={preview.url} onClick={e => { e.preventDefault(); void openBookmark(preview.url).catch(e => setError(String(e))) }}>{preview.url}</a><button className="primary" onClick={() => void openBookmark(preview.url).catch(e => setError(String(e)))}><ArrowUpRight size={16} />Open in browser</button><div className="detail-section"><h3>Notes</h3><p>{preview.description || 'No notes added.'}</p></div><div className="detail-section"><h3>Collections</h3><div className="row-labels">{preview.collectionIds.map(id => <button key={id} className="collection-chip" onClick={() => navigate(id)}><Folder size={12} />{collectionPath(id)}</button>)}{!preview.collectionIds.length && <span>Inbox</span>}</div></div><div className="detail-section"><h3>Tags</h3><div className="row-labels">{preview.tags.map(t => <button key={t} className="tag-chip" onClick={() => { setTag(t); setPage(0) }}># {t}</button>)}{!preview.tags.length && <span>No tags</span>}</div></div><div className="detail-section"><h3>Added</h3><p>{new Date(preview.createdAt).toLocaleDateString()}</p></div><button disabled={disabled} onClick={() => { setError(''); setEditor(preview) }}><Pencil size={15} />Edit bookmark</button></div></aside></Dismissible>}
    <input type="file" ref={fileInput} accept=".html,.htm,.json" hidden onChange={e => { const file = e.target.files?.[0]; if (file) void importFile(file); e.target.value = '' }} />
    {editor && <Dismissible close={() => setEditor(null)} busy={busy}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="bookmark-dialog"><div className="modal-heading"><h2 id="bookmark-dialog">{editor.id ? 'Edit bookmark' : 'A good link deserves a home.'}</h2><button aria-label="Close editor" disabled={busy} data-dismiss><X size={20} /></button></div><form onSubmit={saveBookmark}><label>URL<input autoFocus required name="url" type="url" placeholder="https://example.com" defaultValue={editor.url} onBlur={e => void suggestTitle(e.currentTarget)} /></label><label>Title<input name="title" placeholder="Leave blank to fetch from website" defaultValue={editor.title} /></label><small role="status">{fetchingTitle ? 'Fetching page title? You can keep editing.' : 'Paste a URL, then leave the URL field to fetch its title. Custom titles are kept.'}</small><label>Notes<textarea name="description" rows={3} placeholder="A little context for future you…" defaultValue={editor.description} /></label><label>Tags<input name="tags" placeholder="design, inspiration, reference" defaultValue={editor.tags?.join(', ')} /></label><fieldset><legend>Collections</legend><div className="collection-options">{library.collections.map(c => <label key={c.id}><input name="collections" value={c.id} type="checkbox" defaultChecked={editor.collectionIds?.includes(c.id)} />{collectionPath(c.id)}</label>)}{!library.collections.length && <small>No collections yet. This bookmark will go to Inbox.</small>}</div></fieldset>{error && <p role="alert" className="form-error">{error}</p>}<div className="modal-actions"><button type="button" disabled={busy} data-dismiss>Cancel</button><button className="primary" disabled={disabled}>Save bookmark</button></div></form></section></Dismissible>}
    {collectionDialog && <Dismissible close={() => setCollectionDialog(null)} busy={busy}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="collection-dialog">
      <div className="modal-heading"><h2 id="collection-dialog">{collectionDialog === 'new' ? 'Create collection' : 'Manage collection'}</h2><button aria-label="Close collection dialog" disabled={busy} data-dismiss><X size={20} /></button></div>
      <form onSubmit={async e => { e.preventDefault(); const data = new FormData(e.currentTarget); const name = String(data.get('name')).trim(); const parentId = String(data.get('parent')) || null; try { const id = collectionDialog === 'new' ? crypto.randomUUID() : collectionDialog; const next = collectionDialog === 'new' ? validateLibrary({ ...library, collections: [...library.collections, { id, name, parentId }] }) : updateCollection(library, id, name, parentId); if (await commit(next, 'Collection saved')) { setCollectionDialog(null); navigate(id) } } catch (e) { setError(String(e)) } }}>
        <label>Name<input name="name" autoFocus required defaultValue={library.collections.find(c => c.id === collectionDialog)?.name ?? ''} /></label>
        <label>Inside collection<select name="parent" defaultValue={collectionDialog === 'new' ? (library.collections.some(c => c.id === view) ? view : '') : library.collections.find(c => c.id === collectionDialog)?.parentId ?? ''}><option value="">Top level</option>{library.collections.filter(c => { let current: string | null = c.id; while (current) { if (current === collectionDialog) return false; current = library.collections.find(p => p.id === current)?.parentId ?? null } return true }).map(c => <option key={c.id} value={c.id}>{collectionPath(c.id)}</option>)}</select></label>
        {collectionDialog !== 'new' && <><small>Deleting keeps every bookmark, removes this membership, and moves direct children to this collection?s parent (or top level). Unfiled bookmarks go to Inbox.</small><button className="danger" type="button" disabled={disabled} onClick={() => confirmChange('Delete this collection? Bookmarks are kept; direct children move to its parent.', deleteCollection(library, collectionDialog))}>Delete collection</button></>}
        {error && <p role="alert" className="form-error">{error}</p>}<div className="modal-actions"><button type="button" disabled={busy} data-dismiss>Cancel</button><button className="primary" disabled={disabled}>Save collection</button></div>
      </form></section></Dismissible>}
    {tagDialog && <Dismissible close={() => setTagDialog(false)} busy={busy}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="tag-dialog"><div className="modal-heading"><h2 id="tag-dialog">Manage tags</h2><button aria-label="Close tag manager" disabled={busy} data-dismiss><X size={20} /></button></div><p>Rename to an existing tag to merge. Remove only removes the label. Changes also apply to Trash.</p>
      {[...new Set([...library.bookmarks, ...(library.trash ?? [])].flatMap(b => b.tags))].sort().map(t => <form className="tag-manager-row" key={t} onSubmit={async e => { e.preventDefault(); const name = String(new FormData(e.currentTarget).get('name')).trim(); if (!name) { setError('Tag name is required.'); return } if (await commit(renameTag(library, t, name), 'Tag renamed or merged')) { if (tag === t) setTag(name) } }}><span title={t}># {t}</span><input aria-label={"Rename tag " + t} name="name" defaultValue={t} required /><button disabled={disabled}>Save / merge</button><button type="button" className="danger" disabled={disabled} onClick={async () => { if (await commit(renameTag(library, t, ''), 'Tag removed; bookmarks kept')) { if (tag === t) setTag('') } }}>Remove</button></form>)}
      {error && <p role="alert" className="form-error">{error}</p>}
    </section></Dismissible>}
    {confirmation && <Dismissible className="modal-backdrop confirmation" busy={busy} close={() => setConfirmation(null)}><section className="modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog"><h2 id="confirm-dialog">Confirm deletion</h2><p>{confirmation.message}</p>{error && <p role="alert" className="form-error">{error}</p>}<div className="modal-actions"><button autoFocus disabled={busy} data-dismiss>Cancel</button><button className="danger" disabled={disabled} onClick={() => void confirmation.apply()}>Confirm delete</button></div></section></Dismissible>}

  </div>
}
