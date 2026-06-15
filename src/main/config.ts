import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

// User-entered credentials live in the OS user-data folder, so a fix on one
// machine persists across restarts and overrides the build-time defaults.
function configPath(): string {
  return join(app.getPath('userData'), 'rishabh-oil-config.json')
}

export interface StoredConfig {
  url?: string
  authToken?: string
}

export function getStoredConfig(): StoredConfig {
  try {
    const p = configPath()
    if (!existsSync(p)) return {}
    return JSON.parse(readFileSync(p, 'utf-8')) as StoredConfig
  } catch {
    return {}
  }
}

export function saveStoredConfig(url: string, authToken: string): void {
  const p = configPath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify({ url, authToken }, null, 2), 'utf-8')
}
