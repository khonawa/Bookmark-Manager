import { invoke } from '@tauri-apps/api/core'
import { validateLibrary, type Library } from './library'
export interface BackupConfig { enabled: boolean; intervalMinutes: number; retention: number; location: string }
export interface BackupStatus { config: BackupConfig; lastSuccess: string | null; lastError: string | null }
export interface BackupEntry { name: string }
export const backupApi = {
  status: () => invoke<BackupStatus>('backup_status'),
  configure: (config: BackupConfig) => invoke<BackupStatus>('configure_backups', { config }),
  create: () => invoke<BackupStatus>('create_backup'),
  list: () => invoke<BackupEntry[]>('list_backups'),
  read: async (name: string): Promise<Library> => {
    const value = await invoke<{ version: number; library: unknown }>('read_backup', { name })
    if (value.version !== 1) throw new Error('Unsupported backup version.')
    return validateLibrary(value.library)
  },
}
