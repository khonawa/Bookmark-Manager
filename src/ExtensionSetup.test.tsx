// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
afterEach(() => { mocks.invoke.mockReset(); document.body.innerHTML = '' })
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocks.invoke }))
import ExtensionSetup from './ExtensionSetup'
it('shows pairing state, gates malformed IDs, pairs explicitly and revokes explicitly', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  mocks.invoke.mockResolvedValue({ paired: false })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<ExtensionSetup close={() => {}} />))
  expect(mocks.invoke).toHaveBeenCalledWith('get_extension_status')
  const buttons = Array.from(container.querySelectorAll('button'))
  const pair = buttons.find(button => button.textContent === 'Pair this extension')!
  expect(pair.disabled).toBe(true)
  const input = container.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'a'.repeat(32))
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(pair.disabled).toBe(false)
  await act(async () => pair.click())
  expect(mocks.invoke).toHaveBeenCalledWith('configure_extension', { extensionId: 'a'.repeat(32) })
  await act(async () => buttons.find(button => button.textContent === 'Revoke pairing')!.click())
  expect(mocks.invoke).toHaveBeenCalledWith('disable_extension', {})
  await act(async () => root.unmount())
  container.remove()
})
it('confirms unsaved IDs, blocks busy dismissal, and updates the baseline only after successful pairing', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  let finishPair!: (value: unknown) => void
  mocks.invoke.mockImplementation((name: string) => name === 'configure_extension'
    ? new Promise(resolve => { finishPair = resolve }) : Promise.resolve({ paired: false }))
  const close = vi.fn()
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(<ExtensionSetup close={close} />))
  const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent === text)!
  const input = container.querySelector('input')!
  const edit = async (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await edit('a'.repeat(32))
  await act(async () => button('Close').click())
  expect(close).not.toHaveBeenCalled()
  expect(container.querySelector('[role="alertdialog"]')).not.toBeNull()
  await act(async () => button('Keep editing').click())
  await act(async () => button('Pair this extension').click())
  expect(input.disabled).toBe(true)
  expect(button('Close').disabled).toBe(true)
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    container.querySelector('.modal-backdrop')!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  })
  expect(close).not.toHaveBeenCalled()
  await act(async () => finishPair({ paired: true }))
  await act(async () => button('Close').click())
  expect(close).toHaveBeenCalledOnce()
  await edit('b'.repeat(32))
  mocks.invoke.mockRejectedValueOnce(new Error('Pair failed'))
  await act(async () => button('Pair this extension').click())
  await act(async () => button('Close').click())
  expect(close).toHaveBeenCalledOnce()
  expect(container.querySelector('[role="alertdialog"]')).not.toBeNull()
  await act(async () => root.unmount())
})
