import { useEffect, useState } from 'react'

// The mill's own logo, uploaded under Settings and kept in app_settings as a
// data URL. One setting feeds three places: the sidebar mark, the browser tab
// and — on the website — the installed app's icon, which the server serves
// from the same row at /brand-icon.

const KEY = 'brand_logo'

// Read once per page load and shared, so a dozen components mounting at the
// same time don't each fetch the settings table.
let cached: string | null = null
let inflight: Promise<string> | null = null

export async function loadBrandLogo(): Promise<string> {
  if (cached != null) return cached
  if (!inflight) {
    inflight = window.api.settings
      .get(KEY)
      .then((v) => {
        cached = String(v || '')
        return cached
      })
      .catch(() => {
        cached = ''
        return cached
      })
  }
  return inflight
}

// Point the tab's icon at the logo. A data URL rather than a file, so it works
// the same in the packaged desktop app (file://) as it does on the website.
export function applyBrandFavicon(dataUrl: string): void {
  if (!dataUrl) return
  let link = document.querySelector<HTMLLinkElement>("link[rel='icon']")
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }
  link.href = dataUrl
}

export function useBrandLogo(): string {
  const [logo, setLogo] = useState(cached ?? '')
  useEffect(() => {
    let alive = true
    void loadBrandLogo().then((v) => {
      if (!alive) return
      setLogo(v)
      applyBrandFavicon(v)
    })
    return () => {
      alive = false
    }
  }, [])
  return logo
}
