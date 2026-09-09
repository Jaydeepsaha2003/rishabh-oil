// Which view a page was on, kept across a refresh.
//
// App.tsx already puts the PAGE in the URL, so F5 on /treasury comes back on
// Treasury — but which of its tabs, and which sub-view under that, is ordinary
// component state, so a reload always landed on the first one. Someone working
// through Bill discounting lost their place every time they refreshed, and so
// did someone on Stock's Actual tab.
//
// sessionStorage rather than the query string, deliberately. App.tsx owns the
// path and rewrites the whole URL whenever `page` changes; a child writing
// search params into that same URL races the parent's effect and loses — and
// child effects run first, so on the render that navigates to a page it would
// write the view onto the PREVIOUS page's URL. Storage has no such ordering
// problem.
//
// Per tab and per session on purpose: two browser tabs can sit on different
// views, and tomorrow starts at the top rather than wherever last week ended.

export function readView<T extends string>(
  key: string,
  field: string,
  allowed: readonly T[],
  fallback: T
): T {
  if (!__WEB__) return fallback
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return fallback
    const v = (JSON.parse(raw) as Record<string, unknown>)[field]
    return (allowed as readonly string[]).includes(String(v)) ? (v as T) : fallback
  } catch {
    // Private windows, and browsers set to block site data, throw on the
    // accessor itself. Losing the place on refresh is the old behaviour, so
    // falling back to it costs nothing.
    return fallback
  }
}

export function writeView(key: string, view: Record<string, string>): void {
  if (!__WEB__) return
  try {
    sessionStorage.setItem(key, JSON.stringify(view))
  } catch {
    /* see above */
  }
}
