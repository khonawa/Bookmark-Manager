import { useEffect, useRef, type ReactNode } from 'react'
import { Download } from 'lucide-react'

export default function ExportMenu({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    function outside(event: PointerEvent) { if (!ref.current?.contains(event.target as Node)) ref.current?.removeAttribute('open') }
    function key(event: KeyboardEvent) {
      if (event.key !== 'Escape' || !ref.current?.open) return
      event.preventDefault(); event.stopPropagation(); ref.current.open = false; ref.current.querySelector('summary')?.focus()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key, true) }
  }, [])
  return <details ref={ref} className="export-menu"><summary><Download size={16} />Export</summary><div>{children}</div></details>
}
