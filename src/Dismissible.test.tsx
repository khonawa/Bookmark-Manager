// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import Dismissible from './Dismissible'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = '' })
async function render(busy = false) {
  const opener = document.createElement('button'); document.body.append(opener); opener.focus()
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  const close = vi.fn()
  await act(async () => root.render(<Dismissible busy={busy} close={close}><section role="dialog"><input name="name" defaultValue="original" /><select><option>A</option><option>B</option></select><button data-dismiss>Cancel</button></section></Dismissible>))
  return { root, container, close, opener }
}
async function escape(target: EventTarget = document) { await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))) }
async function outside(target: EventTarget = document.body) { await act(async () => target.dispatchEvent(new Event('pointerdown', { bubbles: true }))) }
it('closes clean dialogs on outside or Escape, never inside, and returns focus', async () => {
  const { container, close, root, opener } = await render()
  await outside(container.querySelector('input')!); expect(close).not.toHaveBeenCalled()
  await outside(); expect(close).toHaveBeenCalledTimes(1)
  await escape(); expect(close).toHaveBeenCalledTimes(2)
  await act(async () => root.unmount()); roots.splice(roots.indexOf(root), 1)
  expect(document.activeElement).toBe(opener)
})
it('confirms dirty close, keeps edits on nested Escape, discards only explicitly', async () => {
  const { container, close } = await render()
  container.querySelector('input')!.value = 'edited'
  await escape()
  expect(container.querySelector('[role="alertdialog"]')).not.toBeNull(); expect(close).not.toHaveBeenCalled()
  await escape(); expect(container.querySelector('[role="alertdialog"]')).toBeNull()
  expect(container.querySelector('input')!.value).toBe('edited')
  await act(async () => container.querySelector<HTMLButtonElement>('[data-dismiss]')!.click())
  await outside(); expect(close).not.toHaveBeenCalled()
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Discard changes')!.click())
  expect(close).toHaveBeenCalledOnce()
})
it('compares current values rather than sticky dirty state', async () => {
  const { container, close } = await render()
  container.querySelector('input')!.value = 'edited'; container.querySelector('input')!.value = 'original'
  await escape(); expect(close).toHaveBeenCalledOnce()
})
it('blocks all dismissal while saving', async () => {
  const { container, close } = await render(true)
  await outside(); await escape(); await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
  expect(close).not.toHaveBeenCalled(); expect(container.querySelector('[role="alertdialog"]')).toBeNull()
})
it('gives a focused native dropdown Escape precedence', async () => {
  const { container, close } = await render()
  const select = container.querySelector('select')!; select.focus()
  await escape(select); expect(close).not.toHaveBeenCalled()
  await escape(); expect(close).toHaveBeenCalledOnce()
})
it('dismisses only the top nested layer', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  const outer = vi.fn(), inner = vi.fn()
  await act(async () => root.render(<Dismissible close={outer}><section><Dismissible close={inner}><section><button>Nested</button></section></Dismissible></section></Dismissible>))
  await escape(); expect(inner).toHaveBeenCalledOnce(); expect(outer).not.toHaveBeenCalled()
})
