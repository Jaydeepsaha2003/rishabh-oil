import { createHash } from 'crypto'
import { getRevision } from './db'

// A TALLY FILE IS READ ONCE, NOT ON EVERY CLICK.
//
// The check reads the uploaded workbook, and Book from Tally, the preview and
// the posting each read it again — the same bytes, parsed by ExcelJS each time,
// which on the website's server is most of the seconds a click took. So the
// parsed file is kept by a hash of its bytes (a file never changes under its
// own hash), and the books side by the database revision as well (any write
// moves it, so a booking or an edit is never answered from before it).
//
// Each hit is handed out as a copy: callers may annotate what they get, and
// that must not leak into the next caller's answer.

const LIMIT = 8
const store = new Map<string, unknown>()

function remember(key: string, value: unknown): void {
  store.delete(key)
  store.set(key, value)
  while (store.size > LIMIT) store.delete(store.keys().next().value as string)
}

async function cached<T>(key: string, make: () => Promise<T>): Promise<T> {
  if (store.has(key)) {
    const hit = store.get(key) as T
    // Most recently used goes to the back.
    remember(key, hit)
    return structuredClone(hit)
  }
  const value = await make()
  remember(key, value)
  return structuredClone(value)
}

const hashOf = (b64: string): string => createHash('sha1').update(b64).digest('hex')

/** The parsed form of an uploaded file — keyed by what kind of parse and the file's bytes. */
export function parsedFile<T>(tag: string, b64: string, make: () => Promise<T>): Promise<T> {
  return cached(`file:${tag}:${hashOf(String(b64 || ''))}`, make)
}

/** A read of the books — keyed by what was asked and the database revision. */
export function booksRead<T>(key: string, make: () => Promise<T>): Promise<T> {
  return cached(`books:${getRevision()}:${key}`, make)
}
