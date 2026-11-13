import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

const layers: { id: symbol; element: HTMLElement; modal: boolean }[] = []
function value(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) {
  if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) return String(element.checked)
  if (element instanceof HTMLSelectElement) return JSON.stringify([...element.selectedOptions].map(option => option.value))
  return element.value
}

/** One topmost dismissal layer; nested native controls get first refusal. */
export default function Dismissible({ children, close, busy = false, dirty, className = 'modal-backdrop', modal = true }: { children: ReactNode; close: () => void; busy?: boolean; dirty?: boolean; className?: string; modal?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const openerRef = useRef(document.activeElement as HTMLElement | null)
  const state = useRef({ close, busy, dirty })
  useLayoutEffect(() => { state.current = { close, busy, dirty } })
  const baseline = useRef(new Map<Element, string>())
  const [confirm, setConfirm] = useState(false)
  const confirming = useRef(false)
  const returnFocus = useRef<HTMLElement | null>(null)
  function changed() {
    if (state.current.dirty !== undefined) return state.current.dirty
    return [...(host.current?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input:not([type=file]), select, textarea') ?? [])].some(element => baseline.current.has(element) && baseline.current.get(element) !== value(element))
  }
  function request() {
    if (state.current.busy) return
    if (changed()) { returnFocus.current = document.activeElement as HTMLElement; confirming.current = true; setConfirm(true) }
    else state.current.close()
  }
  useLayoutEffect(() => {
    host.current?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input:not([type=file]), select, textarea').forEach(element => {
      if (!baseline.current.has(element)) baseline.current.set(element, value(element))
    })
  })
  useLayoutEffect(() => {
    const id = Symbol(); layers.push({ id, element: host.current!, modal })
    const opener = openerRef.current
    if (modal && !host.current?.contains(document.activeElement)) host.current?.querySelector<HTMLElement>('input, button, select, textarea, [tabindex]')?.focus()
    const top = () => (modal || !layers.some(layer => layer.modal)) && !layers.some(layer => layer.id !== id && host.current?.contains(layer.element)) && layers.filter(layer => layer.id === id || !layer.element.contains(host.current)).at(-1)?.id === id
    function key(event: KeyboardEvent) {
      if (!top() || event.defaultPrevented) return
      if (event.key === 'Escape') {
        // A native select/datalist consumes Escape before the surrounding dialog.
        const target = event.target as HTMLElement
        if (!confirming.current && (target instanceof HTMLSelectElement || target instanceof HTMLInputElement && target.hasAttribute('list'))) { target.blur(); event.preventDefault(); event.stopPropagation(); return }
        const details = host.current?.querySelector('details[open]')
        if (details) { details.removeAttribute('open'); event.preventDefault(); event.stopPropagation(); return }
        event.preventDefault(); event.stopPropagation()
        if (confirming.current) { confirming.current = false; setConfirm(false); returnFocus.current?.focus() }
        else request()
      }
      if (event.key === 'Tab' && modal) {
        const container = confirming.current ? host.current?.querySelector('[role="alertdialog"]') : host.current
        const controls = [...(container?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') ?? [])]
        const first = controls[0], last = controls.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    function outside(event: PointerEvent) {
      if (!top() || confirming.current) return
      const target = event.target as Node
      const panel = host.current?.firstElementChild
      if (panel?.contains(target)) return
      request()
    }
    document.addEventListener('keydown', key)
    document.addEventListener('pointerdown', outside)
    return () => {
      layers.splice(layers.findIndex(layer => layer.id === id), 1)
      document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside)
      if (opener?.isConnected) opener.focus()
    }
  }, [modal])
  return <div ref={host} data-dismiss-layer className={className} onClickCapture={event => {
      if ((event.target as Element).closest('[data-dismiss-layer]') === host.current && (event.target as Element).closest('[data-dismiss]')) { event.preventDefault(); event.stopPropagation(); request() }
  }}>{children}{confirm && <div className="modal-backdrop confirmation"><section className="modal" role="alertdialog" aria-modal="true" aria-labelledby="discard-heading"><h2 id="discard-heading">Discard unsaved changes?</h2><p>Your edits have not been saved.</p><div className="modal-actions"><button autoFocus onClick={() => { confirming.current = false; setConfirm(false); returnFocus.current?.focus() }}>Keep editing</button><button className="danger" disabled={busy} onClick={() => { if (!state.current.busy) state.current.close() }}>Discard changes</button></div></section></div>}</div>
}
