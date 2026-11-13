import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
it('ships an MV3 native-only extension without broad browsing or host access', () => {
  const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'))
  expect(manifest.manifest_version).toBe(3)
  expect(manifest.permissions.sort()).toEqual(['activeTab', 'alarms', 'contextMenus', 'nativeMessaging', 'storage'].sort())
  expect(manifest.host_permissions).toBeUndefined()
  expect(manifest.content_scripts).toBeUndefined()
  expect(manifest.background.type).toBe('module')
  for (const path of [manifest.background.service_worker, manifest.action.default_popup, manifest.options_page]) expect(readFileSync(new URL(path, import.meta.url), 'utf8')).toBeTruthy()
})
