// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), desktop: { value: true } }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('./storage', () => ({ get desktop() { return mocks.desktop.value } }))
import BackupSettings from './BackupSettings'
const config = { enabled: true, intervalMinutes: 60, retention: 10, location: 'C:\\Backups' }
afterEach(() => { mocks.invoke.mockReset(); mocks.desktop.value = true; document.body.innerHTML = '' })
it('previews and explicitly confirms a validated safe merge, never invokes a native replacement', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const library = { bookmarks: [], collections: [] }
  mocks.invoke.mockImplementation((name: string) => Promise.resolve(name === 'backup_status' ? { config, lastSuccess: null, lastError: null } : name === 'list_backups' ? [{ name: 'snapshot.json' }] : { version: 1, library }))
  const restore = vi.fn().mockResolvedValue(true)
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(<BackupSettings close={() => {}} restore={restore} />))
  const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent === text)!
  await act(async () => button('Preview snapshot.json').click())
  expect(restore).not.toHaveBeenCalled()
  expect(container.textContent).toContain('0 active bookmarks')
  await act(async () => button('Confirm safe merge').click())
  expect(restore).toHaveBeenCalledExactlyOnceWith(library)
  expect(mocks.invoke.mock.calls.map(c => c[0])).toEqual(['backup_status', 'list_backups', 'read_backup'])
  await act(async () => root.unmount())
})
it('rejects malformed backup before offering confirmation and reports read failures', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  mocks.invoke.mockImplementation((name: string) => Promise.resolve(name === 'backup_status' ? { config, lastSuccess: null, lastError: 'Disk full' } : name === 'list_backups' ? [{ name: 'bad.json' }] : { version: 1, library: {} }))
  const restore = vi.fn(); const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(<BackupSettings close={() => {}} restore={restore} />))
  await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Preview bad.json')!.click())
  expect(container.textContent).toContain('Disk full')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Invalid backup format')
  expect(container.textContent).not.toContain('Confirm safe merge')
  expect(restore).not.toHaveBeenCalled()
  await act(async () => root.unmount())
})
it('guards dirty dismissal and busy saves, then resets the saved form baseline', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  let finishSave!: (value: unknown) => void
  mocks.invoke.mockImplementation((name: string) => name === 'configure_backups'
    ? new Promise(resolve => { finishSave = resolve })
    : Promise.resolve(name === 'backup_status' ? { config, lastSuccess: null, lastError: null } : []))
  const close = vi.fn()
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(<BackupSettings close={close} restore={vi.fn()} />))
  const button = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent === text)!
  const input = container.querySelector<HTMLInputElement>('[name="retention"]')!
  input.value = '12'
  await act(async () => button('Close').click())
  expect(close).not.toHaveBeenCalled()
  expect(container.querySelector('[role="alertdialog"]')).not.toBeNull()
  await act(async () => button('Keep editing').click())
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(button('Close').disabled).toBe(true)
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    container.querySelector('.modal-backdrop')!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  })
  expect(close).not.toHaveBeenCalled()
  await act(async () => finishSave({ config: { ...config, retention: 12 }, lastSuccess: null, lastError: null }))
  expect(container.textContent).toContain('Backup settings saved.')
  expect(container.querySelector('[name="retention"]')).not.toBe(input)
  await act(async () => button('Close').click())
  expect(close).toHaveBeenCalledOnce()
  expect(container.querySelector('[role="alertdialog"]')).toBeNull()
  await act(async () => root.unmount())
})
it('honestly disables native filesystem features in browser preview', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); mocks.desktop.value = false
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(<BackupSettings close={() => {}} restore={vi.fn()} />))
  expect(container.textContent).toContain('Native filesystem backups are unavailable')
  expect(container.textContent).toContain('No scheduling while closed')
  expect(mocks.invoke).not.toHaveBeenCalled()
  await act(async () => root.unmount())
})
