import { useEffect, useState } from 'react'
import { getMetadata } from './metadata'
import { invoke } from '@tauri-apps/api/core'
import { desktop } from './storage'

export default function SiteIcon({ url }: { url: string }) {
  const [result, setResult] = useState<{ url: string; icon: string | null } | null>(null)
  const icon = result?.url === url ? result.icon : null
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const captured = desktop ? await invoke<string | null>('get_extension_icon', { url }).catch(() => null) : null
      const icon = captured || (await getMetadata(url)).icon
      if (!cancelled) setResult({ url, icon })
    })().catch(() => {})
    return () => { cancelled = true }
  }, [url])
  return <div className="site-icon">{icon ? <img src={icon} alt="" width="24" height="24" onError={() => setResult({ url, icon: null })} /> : new URL(url).hostname.replace(/^www\./, '').slice(0, 1).toUpperCase()}</div>
}
