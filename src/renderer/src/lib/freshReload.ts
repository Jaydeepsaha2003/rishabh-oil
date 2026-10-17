// RELOADING ONTO THE BUILD THAT IS ACTUALLY LIVE.
//
// After a deploy the site offers "Reload", and a plain location.reload() kept
// landing on the page it already had — only Ctrl+Shift+R got the new build.
// A plain reload asks for the SAME address again, and anything holding a copy
// of that address (the browser, or a cache between it and the server) may hand
// the old page back. The version check itself never had the problem, because
// it asks for `/?_v=<now>` — an address nothing can have seen before.
//
// So the Reload does the same: it goes to the page it is on with a fresh `_v`
// stamp, which no cache can answer. dropReloadStamp() takes the stamp back off
// the address bar once the new page has started, so the address reads as it
// did and a bookmark made afterwards is clean.

const STAMP = '_v'

export function freshReload(): void {
  try {
    const u = new URL(window.location.href)
    u.searchParams.set(STAMP, String(Date.now()))
    window.location.replace(u.toString())
  } catch {
    window.location.reload()
  }
}

export function dropReloadStamp(): void {
  try {
    const u = new URL(window.location.href)
    if (!u.searchParams.has(STAMP)) return
    u.searchParams.delete(STAMP)
    window.history.replaceState(window.history.state, '', `${u.pathname}${u.search}${u.hash}`)
  } catch {
    // An address that cannot be parsed has no stamp worth removing.
  }
}
