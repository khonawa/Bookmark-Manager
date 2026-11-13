import { useEffect, useState } from 'react'
import { backupApi, type BackupEntry, type BackupStatus } from './backups'
import { desktop } from './storage'
import type { Library } from './library'
import Dismissible from './Dismissible'

export default function BackupSettings({ close, restore }: { close: () => void; restore: (incoming: Library) => Promise<boolean> }) {
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [entries, setEntries] = useState<BackupEntry[]>([])
  const [preview, setPreview] = useState<{ name: string; library: Library } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    if (!desktop) return
    let active = true
    async function refresh() {
      try { const [status, entries] = await Promise.all([backupApi.status(), backupApi.list()]); if (active) { setStatus(status); setEntries(entries) } }
      catch (e) { if (active) setError(String(e)) }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 10000)
    return () => { active = false; clearInterval(timer) }
  }, [])
  async function action(run: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await run() } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  return <Dismissible close={close} busy={busy}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="backups-heading"><h2 id="backups-heading">Backups & restore</h2>
    <p>Automatic backups run only while the desktop app is running. No scheduling while closed.</p>
    {!desktop ? <p>Native filesystem backups are unavailable in browser preview. Use Export → Full JSON backup and Import for manual safe merging.</p> : <>
      {status && <><p className="backup-status">Last success: {status.lastSuccess ?? 'Never'}<br />Last error: {status.lastError ?? 'None'}<br />Location: {status.config.location}</p>
        <form key={JSON.stringify(status.config)} onSubmit={e => {
          e.preventDefault(); const data = new FormData(e.currentTarget)
          void action(async () => {
            setStatus(await backupApi.configure({ enabled: data.has('enabled'), intervalMinutes: Number(data.get('interval')), retention: Number(data.get('retention')), location: String(data.get('location')).trim() }))
            setEntries(await backupApi.list()); setPreview(null); setNotice('Backup settings saved.')
          })
        }}><label><input type="checkbox" name="enabled" defaultChecked={status.config.enabled} disabled={busy} />Enable automatic local backups</label>
          <label>Interval (minutes)<input name="interval" type="number" min="1" max="10080" required defaultValue={status.config.intervalMinutes} disabled={busy} /></label>
          <label>Versions to keep<input name="retention" type="number" min="1" max="100" required defaultValue={status.config.retention} disabled={busy} /></label>
          <label>Backup folder (absolute local path)<input name="location" required defaultValue={status.config.location} disabled={busy} /></label>
          <button disabled={busy}>Save backup settings</button></form></>}
      <button disabled={busy || !status} onClick={() => void action(async () => { setStatus(await backupApi.create()); setEntries(await backupApi.list()); setNotice('Backup created.') })}>Back up now</button>
      <h3>Restore a version</h3><p>Restore is a safe merge, never replacement: existing links/titles/notes stay; missing links and combined tags/collections are added. Trash stays separate. Undo available after merge.</p>
      <div className="backup-list">{entries.map(entry => <button disabled={busy} key={entry.name} onClick={() => void action(async () => { setPreview(null); setPreview({ name: entry.name, library: await backupApi.read(entry.name) }) })}>Preview {entry.name}</button>)}{!entries.length && <p>No local snapshots in this folder.</p>}</div>
      {preview && <div className="backup-preview"><strong>{preview.name}</strong><p>Snapshot: {preview.library.bookmarks.length} active bookmarks, {preview.library.collections.length} collections, {preview.library.smartCollections?.length ?? 0} smart collections, {preview.library.trash?.length ?? 0} trash entries. Duplicate URLs merge without replacing existing titles or notes.</p><button disabled={busy} onClick={() => void action(async () => { if (await restore(preview.library)) { setPreview(null); setNotice('Backup merged. Use Undo in the library to reverse this merge.') } else setError('Merge was not saved. Library unchanged; review the library error before retrying.') })}>Confirm safe merge</button><button disabled={busy} onClick={() => setPreview(null)}>Cancel restore</button></div>}
    </>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <footer><button disabled={busy} data-dismiss>Close</button></footer>
      </section></Dismissible>
}
