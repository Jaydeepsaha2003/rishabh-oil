export interface AppUser {
  id: number
  username: string
  full_name: string
  role: string
  permissions?: string[]
}

const KEY = 'rishabhoil.user'

export function loadUser(): AppUser | null {
  try {
    const s = localStorage.getItem(KEY)
    return s ? (JSON.parse(s) as AppUser) : null
  } catch {
    return null
  }
}

export function saveUser(u: AppUser): void {
  localStorage.setItem(KEY, JSON.stringify(u))
}

export function clearUser(): void {
  localStorage.removeItem(KEY)
}
