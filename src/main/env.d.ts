// Build-time environment variables embedded by electron-vite (MAIN_VITE_ prefix).
interface ImportMetaEnv {
  readonly MAIN_VITE_TURSO_DATABASE_URL?: string
  readonly MAIN_VITE_TURSO_AUTH_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
