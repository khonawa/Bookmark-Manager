import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { desktop } from './storage'
import Dismissible from './Dismissible'

export default function ExtensionSetup({ close }: { close: () => void }) {
  const [extensionId, setExtensionId] = useState('')
  const [savedExtensionId, setSavedExtensionId] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!desktop) return
    let active = true
    void invoke('get_extension_status').then(value => { if (active) setStatus(JSON.stringify(value, null, 2)) }).catch(error => { if (active) setStatus(String(error)) })
    return () => { active = false }
  }, [])
  async function configure(disable = false) {
    if (busy) return
    setBusy(true)
    try {
      const result = await invoke(disable ? 'disable_extension' : 'configure_extension', disable ? {} : { extensionId })
      if (!disable) setSavedExtensionId(extensionId)
      setStatus(disable ? 'Pairing revoked. Connector saves are disabled.' : JSON.stringify(result, null, 2))
    } catch (error) { setStatus(String(error)) }
    finally { setBusy(false) }
  }
  return <Dismissible close={close} busy={busy} dirty={extensionId !== savedExtensionId}><section className="modal" role="dialog" aria-modal="true" aria-label="Browser extension setup"><h2>Browser extension</h2><p>Install the unpacked extension folder in Chrome or Edge using Developer mode → Load unpacked. Open its Setup page and copy its extension ID here.</p><p>The native connector only accepts the explicitly paired extension. No unauthenticated HTTP endpoint is opened. Desktop must remain running; offline saves stay queued in the browser.</p>{!desktop ? <p>Browser preview cannot pair or access desktop SQLite. Start the Tauri app using npm run tauri -- dev. npm run dev remains available for UI preview.</p> : <><label>Extension ID<input aria-label="Extension ID" disabled={busy} value={extensionId} onChange={e => setExtensionId(e.target.value.trim())} maxLength={32} placeholder="32 lowercase letters a–p" /></label><button disabled={busy || !/^[a-p]{32}$/.test(extensionId)} onClick={() => void configure()}>Pair this extension</button><button disabled={busy} onClick={() => void configure(true)}>Revoke pairing</button><p>Pairing does not alter the Windows registry. Build the debug connector and explicitly run the per-user setup-native-host.ps1 script in src-tauri (see README). Register the same extension ID, then enable and test it in the extension Setup page. Re-pairing replaces the previous browser ID.</p><pre style={{ whiteSpace: 'pre-wrap' }}>cargo build --manifest-path src-tauri\Cargo.toml --bin bookmark-desk-connector</pre></>}<pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }} role="status">{status}</pre><button disabled={busy} data-dismiss>Close</button></section></Dismissible>
}
