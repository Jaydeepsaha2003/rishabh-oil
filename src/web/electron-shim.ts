// A stand-in for the `electron` module, for the BROWSER.
// -----------------------------------------------------------------------------
// src/preload/index.ts already builds the entire surface the UI is allowed to
// call — 263 channels, each with its own argument shape — out of exactly two
// things: `ipcRenderer.invoke` and `contextBridge.exposeInMainWorld`.
//
// So the web build aliases `electron` to this file and imports that same
// preload. Every channel, every argument mapping, comes across verbatim. The
// alternative was hand-writing a second copy of those 263 mappings, which would
// be wrong somewhere within a week and wrong everywhere within a month.
//
// The renderer is not modified at all. It calls window.api exactly as it does on
// the desktop and cannot tell the difference.

type Row = Record<string, unknown>

// One POST per call, to the one endpoint the server exposes. `credentials` is
// same-origin so the session cookie rides along.
async function invoke(channel: string, args?: unknown): Promise<unknown> {
  let res: Response
  try {
    res = await fetch('/api/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ channel, args: args ?? {} })
    })
  } catch {
    // Offline, or the server is down. The renderer already handles a rejected
    // invoke everywhere, and db.ts's own ping reports the same way.
    throw new Error('Cannot reach the server — check your connection')
  }
  if (!res.ok) {
    // 404 means the channel does not exist on this build; anything else is the
    // server itself failing. Neither is a business error, so say which.
    const text = await res.text().catch(() => '')
    throw new Error(text || `Server error ${res.status}`)
  }
  const body = (await res.json()) as Row
  // A handler that threw comes back as ok:false with its message intact, so a
  // rejected promise here carries the same text the desktop app would show.
  if (body && body.ok === false) throw new Error(String(body.error || 'Request failed'))
  return body?.result ?? null
}

export const ipcRenderer = {
  invoke,
  // Push channels. The desktop uses one — update:status — and there is nothing
  // to push on the web, where updating means reloading the page. Registering
  // still has to return an unsubscribe, because the renderer calls it in a
  // useEffect and would crash on undefined.
  on(): void {},
  once(): void {},
  removeListener(): void {},
  send(): void {}
}

export const contextBridge = {
  exposeInMainWorld(key: string, value: unknown): void {
    // No isolated world in a browser tab: assigning to window is what
    // exposeInMainWorld amounts to here.
    ;(window as unknown as Row)[key] = value
  }
}

export default { ipcRenderer, contextBridge }
