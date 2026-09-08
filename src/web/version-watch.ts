// Notices when the deployed build has moved on, and offers a reload.
//
// This exists because of a failure mode with no symptom. The site is a single
// page app: clicking from Sales to Stock never re-fetches index.html, it just
// swaps the view using the JavaScript already in memory. A tab left open
// across a deploy therefore keeps running the old bundle indefinitely — and
// because every build's assets stay on the server under their own hashed
// names, nothing 404s and nothing errors. The tab simply shows last week's
// app, confidently, until someone happens to do a full reload.
//
// So the page asks. It compares the bundle it is running against the one
// index.html currently points at, and if they differ it says so.
//
// It PROMPTS rather than reloading. This app has screens you can spend twenty
// minutes in — the opening stock sheet is forty-odd products of typed
// quantities held in component state — and reloading under someone mid-sheet
// would throw that away to fix a cosmetic staleness. The choice is theirs.
//
// The notice is built by hand out of DOM rather than raised as a toast. The
// first cut used sonner, which was wrong for a reason worth recording: this
// module runs from the web entry point, outside React, and sonner only renders
// where a <Toaster /> is mounted. There is none on the login screen, so the
// call succeeded, rendered nowhere, and the watcher — having marked itself
// done — never spoke again. A plain element cannot be swallowed by where it
// was called from.

const CHECK_EVERY_MS = 15 * 60 * 1000
// A tab coming back to the foreground is the moment staleness matters, but a
// user alt-tabbing between windows generates a lot of those, so they are
// rate-limited rather than answered one for one.
const MIN_GAP_MS = 60 * 1000

const BUNDLE_RE = /\/assets\/index-[A-Za-z0-9_-]+\.js/
const HOST_ID = 'app-version-notice'

function runningBundle(): string | null {
  for (const el of document.querySelectorAll<HTMLScriptElement>('script[src]')) {
    const m = BUNDLE_RE.exec(el.getAttribute('src') || '')
    if (m) return m[0]
  }
  return null
}

function show(onDismiss: () => void): void {
  if (document.getElementById(HOST_ID)) return

  const card = document.createElement('div')
  card.id = HOST_ID
  card.setAttribute('role', 'status')
  card.style.cssText = [
    'position:fixed',
    'right:16px',
    'bottom:16px',
    'z-index:2147483000',
    'max-width:340px',
    'padding:13px 14px',
    'background:#fff',
    'border:1px solid #D6E2D6',
    'border-left:4px solid #0B3D2E',
    'border-radius:4px',
    'box-shadow:0 6px 24px rgba(10,31,23,.16)',
    'font-family:Inter,system-ui,sans-serif',
    'color:#0A1F17'
  ].join(';')

  const title = document.createElement('div')
  title.textContent = 'A newer version is available'
  title.style.cssText = 'font-size:12.5px;font-weight:800;letter-spacing:-0.01em'

  const body = document.createElement('div')
  body.textContent =
    'This tab is still running the build it was opened with. Reload to pick up the latest.'
  body.style.cssText =
    'font-size:11.5px;font-weight:600;line-height:1.5;color:#5A6B62;margin-top:4px'

  const row = document.createElement('div')
  row.style.cssText = 'display:flex;gap:8px;margin-top:11px'

  const reload = document.createElement('button')
  reload.type = 'button'
  reload.textContent = 'Reload'
  reload.style.cssText =
    'height:32px;padding:0 14px;border:0;border-radius:4px;background:#C7F03F;color:#0B3D2E;font-size:12px;font-weight:800;cursor:pointer'
  reload.onclick = () => window.location.reload()

  const later = document.createElement('button')
  later.type = 'button'
  later.textContent = 'Not now'
  later.style.cssText =
    'height:32px;padding:0 12px;border:1px solid #C3D2C6;border-radius:4px;background:#fff;color:#33473E;font-size:12px;font-weight:700;cursor:pointer'
  later.onclick = () => {
    card.remove()
    onDismiss()
  }

  row.append(reload, later)
  card.append(title, body, row)
  document.body.appendChild(card)
}

export function watchForNewVersion(): void {
  const running = runningBundle()
  // No hashed bundle means the dev server, where the module graph is live and
  // there is nothing to be stale about.
  if (!running) return

  let last = 0
  // The build already announced. Dismissing clears the notice but not this, so
  // the same deploy does not nag — while a LATER deploy still gets through.
  let announced = ''

  async function check(): Promise<void> {
    const now = Date.now()
    if (now - last < MIN_GAP_MS) return
    last = now

    let deployed: string | null = null
    try {
      // no-store, and a cache-buster, because the whole point is to defeat
      // every cache between here and the origin. index.html is served
      // no-cache, so this is a cheap conditional request in the normal case.
      const res = await fetch(`/?_v=${now}`, { cache: 'no-store', credentials: 'same-origin' })
      if (!res.ok) return
      deployed = BUNDLE_RE.exec(await res.text())?.[0] ?? null
    } catch {
      // Offline, or the server is mid-restart. Staleness is not urgent enough
      // to be worth reporting a failed check over.
      return
    }

    if (!deployed || deployed === running || deployed === announced) return
    announced = deployed
    show(() => undefined)
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check()
  })
  window.setInterval(() => void check(), CHECK_EVERY_MS)
}
