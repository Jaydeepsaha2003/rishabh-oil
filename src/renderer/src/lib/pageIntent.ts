// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// WHAT A PAGE SHOULD OPEN ON, HANDED OVER BY THE SCREEN THAT OPENED IT.
//
// A dashboard tile that says "yesterday's dispatch: 3" has to land on those
// three, not on the whole register. The tile leaves the filter here, the page
// takes it once on the way in (so a later visit opens as normal), and it works
// the same on the website and the desktop — no URL needed.
const intents = new Map<string, Row>()

export function setPageIntent(page: string, intent: Row): void {
  intents.set(page, intent)
}

export function takePageIntent(page: string): Row | null {
  const it = intents.get(page) ?? null
  intents.delete(page)
  return it
}
