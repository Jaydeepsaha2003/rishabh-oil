// The write gate. Every non-read channel passes through here before it runs, so
// a permission is a control rather than a hidden button.
//
// Deliberately FAIL-OPEN for anything not listed in CHANNEL_RULES: an unmapped
// channel behaves exactly as it did before. That is what makes it safe to extend
// the map one entity at a time instead of gating everything at once and
// discovering a legitimate edit is now impossible.
import { getClient, todayISO } from './db'
import { getBooksFrom } from './openings'
import { getCurrentUser } from './currentUser'
import {
  can,
  moduleScope,
  modulePerm,
  windowStart,
  viewDays,
  entryDays,
  type Action,
  type AccessUser
} from './access-rules'
import { ACCOUNTS_SECTIONS, VOUCHER_SECTION } from '../renderer/src/lib/accessSections'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

interface Rule {
  // Permission key, matching the module keys the Users page grants.
  module: string
  label: string
  // Where to read the entry's own date from, for the read-only window. Omitted
  // for entities with no business date of their own.
  table?: string
  dateCol?: string
  // Where a NEW entry carries its date, when the values name it differently
  // from the table's column (a voucher is sent with `date`, stored as
  // `entry_date`). Used for the entry window only.
  createDateKey?: string
  // The right the call needs, when its op name does not say it (actionFor
  // reads 'create'/'delete' from the name; journal:createGroup is a create).
  action?: Action
}

// channel namespace -> what it belongs to. The namespace is the part before ':'.
const CHANNEL_RULES: Record<string, Rule> = {
  // module keys MUST match MODULES in src/renderer/src/lib/modules.ts — a key
  // that is not grantable there would read as "no access" and refuse every
  // write. Namespaces with no grantable module are left out on purpose so they
  // keep working exactly as before.
  orders: { module: 'orders', label: 'Purchases', table: 'orders', dateCol: 'order_date' },
  tankers: { module: 'orders', label: 'Purchases', table: 'purchase_tankers', dateCol: 'loaded_date' },
  bargains: { module: 'bargains', label: 'Purchase bargains', table: 'bargains', dateCol: 'bargain_date' },
  sales: { module: 'sales', label: 'Sales', table: 'sales', dateCol: 'sale_date' },
  salesBargains: {
    module: 'salesBargains',
    label: 'Sales bargains',
    table: 'sales_bargains',
    dateCol: 'bargain_date'
  },
  // The SKU rate card hangs off a sales bargain — it is opened from a bargain
  // row and prices that bargain's packs — so it answers to the same grant.
  // Without a rule here its writes were reaching the database on nothing but
  // a login, which a desk narrowed to one job made plain: the rate card was
  // off its menu and still open to it.
  skuRates: { module: 'salesBargains', label: 'SKU rate card' },
  consignment: {
    module: 'consignment',
    label: 'Consignment stock',
    table: 'consignment_stock',
    dateCol: 'deposit_date'
  },
  gate: { module: 'gateEntry', label: 'Gate entries', table: 'gate_entries', dateCol: 'entry_date' },
  // Treasury's three sections are granted separately, so each channel names
  // the section it belongs to rather than the page they share.
  //
  // `payments` used to name a module key that is not grantable anywhere, which
  // read as "no access" and refused every payment a non-admin tried to make.
  payments: { module: 'treasuryTracker', label: 'Payment Tracker', table: 'payments', dateCol: 'payment_date' },
  // Transporter bills (tbill) and debit/credit notes (notes) are Accounting
  // sections now, resolved per call in accountsRule below — a freight bill by
  // its side, a note by its type.
  lc: { module: 'treasuryLc', label: 'Letters of Credit' },
  bd: { module: 'treasuryBd', label: 'Bill Discounting' },
  billDiscounts: { module: 'treasuryBd', label: 'Bill discounts' },
  production: { module: 'production', label: 'Production', table: 'production', dateCol: 'prod_date' },
  // The day's plan, set from the Dashboard. It is the plant's own schedule, so
  // it answers to the Production grant — saving a day's plan counts as an edit.
  productionPlan: { module: 'production', label: 'Production plan' },

  trading: { module: 'trading', label: 'Trading', table: 'trading_deals', dateCol: 'deal_date' },
  stockCount: { module: 'stock', label: 'Stock' },
  skuStock: { module: 'stock', label: 'Stock' },
  stockAdj: { module: 'stock', label: 'Stock', table: 'stock_adjustments', dateCol: 'adj_date', createDateKey: 'date' },
  // The packed shelf's opening count, open to everyone for the same reason
  // stockOpening is: it is counted by the people on the floor, and until it
  // is in, every SKU that has shipped reads negative. See assertAllowed.
  skuOpening: { module: 'stock', label: 'Stock' },
  formulations: { module: 'formulation', label: 'Formulations' },
  // The recipe sub-category master. Governed by the Formulation grant, since
  // renaming or retiring one reclassifies every recipe pointing at it.
  formulationSubcategory: { module: 'formulation', label: 'Recipe sub-categories' },
  // Stock brought forward. Every balance in the register stands on these, so it
  // belongs behind the Stock grant rather than being reachable by anyone who can
  // open the page.
  stockOpening: { module: 'stock', label: 'Opening stock' }
}

// Reads are never gated here, whatever the caller passes. ipc.ts already filters
// them out, but a read channel that ever slipped past that regex must not be
// mistaken for an edit and start refusing.
const READ_OPS = new Set([
  'list', 'get', 'items', 'issuances', 'parts', 'sheet', 'outstanding', 'all', 'summary', 'transfers',
  'fyTaxable', 'needs', 'breakdown', 'nextNo', 'liveUsers', 'ips', 'logs', 'dispatchableSales',
  'mine', 'pendingCount', 'pending', 'lots', 'unmapped', 'unmappedCount', 'bargainLines',
  'consignmentDraws', 'accounts', 'statement', 'suppliers', 'transporters', 'customers',
  'returns', 'unattributedReturns',
  // The rate card's own reads: which packs a customer is priced for, and how
  // many customers a pack is priced for. Both are lookups — without them here
  // every unknown op reads as an edit, and merely OPENING the card would need
  // the right to change it.
  'parties', 'partyCounts',
  // A bargain's hand-linked vouchers, and what the link picker offers. Reading
  // them must not need the right to change them — linkVoucher/unlinkVoucher
  // still count as edits of the bargain.
  'linkedVouchers', 'voucherChoices',
  // The parts an NBFC has paid a supplier on a discounted bill, and the
  // parts it released to us on a SID.
  'partyPayments', 'receiptParts',
  // A production run's short formulation, shown on hover.
  'mix'
])

// What the operation amounts to. Anything that changes an existing row counts as
// an edit, so advancing a stage or adjusting a quantity is gated like one.
function actionFor(op: string): Action {
  if (op === 'create' || op === 'record' || op === 'issue' || op === 'transfer' || op === 'createInvoice') return 'create'
  if (op === 'delete' || op === 'remove' || op === 'removeInvoice' || op === 'deleteEntry' || op === 'deleteTransfer' ||
      // Removing a packed-stock entry is a deletion, not an edit. Without this
      // it fell through to 'edit' and anyone who could enter packing could also
      // delete somebody else's.
      op === 'deleteAdjustment' ||
      op === 'deleteIssuance' || op === 'removeIssuance' || op === 'deleteInstallment' || op === 'deletePartyPayment' || op === 'deleteReceiptPart' || op === 'undoPartRepayment') return 'delete'
  return 'edit'
}

// Taking a weight is how a gate entry gets FINISHED, not how it gets amended.
//
// A vehicle is booked in before anyone can weigh it: the entry is written at the
// barrier and sits 'pending' until the weighbridge has both figures (gross in,
// tare later — a part-weighed vehicle is still pending). Those two acts are one
// piece of work by one person, so the right to make a gate entry has to include
// the right to finish it.
//
// Reading every non-create channel as an edit meant turning OFF edit — meaning
// "do not let them go back and alter finished entries" — also stopped the
// weighbridge recording today's weights, which is the whole job.
//
// Once the entry is 'completed' a re-weigh IS an amendment, and needs edit.
const GATE_FINISH_OPS = new Set(['complete', 'weights', 'skipWeighment'])

async function gateEntryUnfinished(id: number): Promise<boolean> {
  if (!id) return false
  try {
    const res = await getClient().execute({
      sql: `SELECT COALESCE(status, '') AS s FROM gate_entries WHERE id = ? LIMIT 1`,
      args: [id]
    })
    if (!res.rows.length) return false
    return String(res.rows[0].s) !== 'completed'
  } catch {
    // Unreadable status must not quietly widen anyone's rights.
    return false
  }
}

// The signed-in user's role and permissions. Cached per user id and cleared
// whenever the Users page saves, so a permission change takes effect at once.
let cache: { id: number; user: AccessUser } | null = null
export function clearAccessCache(): void {
  cache = null
}

async function currentAccessUser(): Promise<AccessUser | null> {
  const { id } = getCurrentUser()
  if (!id) return null // not signed in through the app (harness, first run)
  if (cache && cache.id === id) return cache.user
  const res = await getClient().execute({
    sql: 'SELECT role, permissions, active FROM users WHERE id = ? LIMIT 1',
    args: [id]
  })
  if (!res.rows.length) return null
  const r = res.rows[0] as Row
  let permissions: unknown = {}
  try {
    permissions = r.permissions ? JSON.parse(String(r.permissions)) : {}
  } catch {
    permissions = {}
  }
  const user: AccessUser = { role: String(r.role || ''), permissions }
  cache = { id, user }
  return user
}

// The earliest date this user may SEE in a module, or null for no limit.
//
// Enforced HERE, in the query, and never in the page — a row filtered in the
// renderer has already crossed the wire, which is no restriction at all.
//
// This bounds a LIST, and must not be used to bound a figure. A user given a
// seven-day window still owes the full stock balance, the full outstanding, the
// full KPI; those are computed from every row and only the register they read
// is shortened. Bounding a total by the reader's window would not shorten it,
// it would make it wrong.
//
// An admin, an unknown user (harness, first run) and a module with no visible
// window set are all unlimited.
export async function visibleFrom(moduleKey: string): Promise<string | null> {
  const user = await currentAccessUser()
  if (!user) return null
  const days = viewDays(user, moduleKey)
  if (days == null) return null
  return windowStart(days, todayISO())
}

// The same window, handed to the renderer: the earliest date each module's
// forms may offer. A date picker that presents a day the save is going to
// refuse is a trap, so the pages ask once and set it as the minimum.
//
// This is a courtesy to the user, NOT the control — the control is `can()`,
// which refuses the write whatever the form sent. Keyed by module, so one call
// answers for every page instead of one call per page.
export async function entryWindows(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const user = await currentAccessUser()
  if (!user) return out
  if (String(user.role || '').toLowerCase() === 'admin') return out
  const perms = user.permissions
  if (!perms || typeof perms !== 'object' || Array.isArray(perms)) return out
  const today = todayISO()
  for (const key of Object.keys(perms as Record<string, unknown>)) {
    const days = entryDays(user, key)
    if (days != null) out[key] = windowStart(days, today)
  }
  return out
}

// The visible window for a list channel that serves more than one page.
//
// `sales:list` is read by the Sales register, but also by Accounts and Treasury,
// which reconcile money against it. Bounding those two by the SALES window would
// not shorten their pages — it would make their figures wrong, quietly, for one
// user only. So the caller names the module it is actually rendering and the
// bound comes from THAT module's window.
//
// The escape hatch cannot be used to widen anything: naming a module the user
// has no view rights on falls straight back to the owning module's window. A
// user who cannot open Treasury gains nothing by claiming to be it.
export async function visibleFromFor(ownModule: string, callerModule?: string): Promise<string | null> {
  if (!callerModule || callerModule === ownModule) return visibleFrom(ownModule)
  const user = await currentAccessUser()
  if (!user) return null
  if (!modulePerm(user, callerModule).view) return visibleFrom(ownModule)
  return visibleFrom(callerModule)
}

// The narrowed job the signed-in user holds in a module, for the readers that
// have to hand back less than the full row set. Null for an admin, for a user
// the app does not know (harness, first run), or for an unrestricted grant.
/** An inter-company desk that also books customer TDS (sales.also_tds). */
export async function salesAlsoTds(): Promise<boolean> {
  const user = await currentAccessUser()
  return !!user && moduleScope(user, 'sales') === 'intercompany' && !!(modulePerm(user, 'sales') as Row).also_tds
}

export async function currentScope(moduleKey: string): Promise<string | null> {
  const user = await currentAccessUser()
  if (!user) return null
  return moduleScope(user, moduleKey)
}

// An entry dated before the books begin would land nowhere at all — the ledger
// starts after it, and the opening balance that covers that period was entered
// by hand. So it is refused for EVERYONE, admin included: this is not a
// permission, it is a statement about which period these books cover.
async function assertOnOrAfterBooksStart(rule: Rule, op: string, args: unknown): Promise<void> {
  if (!rule.dateCol) return
  if (actionFor(op) !== 'create') return
  const a = args as Row
  const raw = a?.values?.[rule.dateCol] ?? a?.[rule.dateCol]
  const d = String(raw ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return
  const from = await getBooksFrom()
  if (!from || d >= from) return
  throw new Error(
    `These books begin on ${from}. An entry dated ${d} falls before that, where the opening balances already account for it — it would be counted twice.`
  )
}

// The unload desk may record exactly one thing: that a delivery arrived, and
// what was weighed in. Everything else on the sales channel is refused here, so
// the restriction is a control and not a hidden button.
// The readings desk: the one write it may make.
//
// Both channels arrive here — tankers:saveQuality and orders:saveQuality — and
// either is the same act, a lab result recorded against a purchase. Everything
// else on the page is refused with a sentence, not a silent no-op, so the
// person sees why the button they were not meant to have did nothing.
function assertScopedReadings(op: string): void {
  // Recording what was measured, and saying an invoice has nothing to
  // measure at all — waiveQuality is the "Reject — not needed" button next
  // to the readings themselves, opened to this desk along with everyone
  // else who reaches this page. Everything past those two is still refused.
  if (op !== 'saveQuality' && op !== 'waiveQuality') {
    throw new Error(
      'Your access to Purchases covers recording technical parameters only — nothing else on this page can be changed.'
    )
  }
}

function assertScopedSales(op: string, args: unknown): void {
  const stage = String((args as Row)?.stage || '')
  const isUnload = (op === 'setInvoiceStage' || op === 'setStage') && stage === 'unloaded'
  // Linking the credit note that settled a short delivery — no money moves.
  if (!isUnload && op !== 'shortageNotesSet') {
    throw new Error(
      'Your access to Sales covers recording received quantities on deliveries, and linking credit notes to short ones — nothing else on this page can be changed.'
    )
  }
}

// THE TOP-UP DESK.
//
// A sales bargain is a promise to deliver a quantity, and the one change this
// desk may make to it is to promise MORE. Not less — taking quantity back off
// a live bargain is what decides whether a dispatch still has cover, and that
// is a commercial decision, not a correction. Not the rate, the customer, the
// product or the date; not a new bargain and not a deleted one.
//
// So the whole grant is one channel and one sign: salesBargains:adjust with a
// positive delta. Everything else on the page, including the removal half of
// the very dialog this uses, is refused here whatever the screen shows.
function assertScopedBargainTopUp(op: string, args: unknown): void {
  if (op !== 'adjust') {
    throw new Error(
      'Your access to Sales bargains covers adding to a bargain quantity only — nothing else on this page can be changed.'
    )
  }
  if (!(Number((args as Row)?.delta) > 0)) {
    throw new Error('This login can add to a bargain quantity, but not take any back off it.')
  }
}

/* -------------------------------------------------------------------------- */
/* THE INTER-COMPANY TRANSFER DESK                                            */
/* -------------------------------------------------------------------------- */
//
// Two of our companies trade with each other, and that is ONE event kept in
// two sets of books: a sale over here raises the matching purchase over there
// (see src/main/intercompany.ts). Somebody can be put on that work and nothing
// else -- they bill what moves between the companies, and never see what the
// mill pays a third party for oil or what it sells at.
//
// Granted on BOTH pages, because the job spans both: 'intercompany' on sales
// and on orders. The two halves are not symmetrical, and deliberately so.
//
//   SALES is where the work is. A transfer is raised, amended and deleted
//   here, and the purchase in the other company follows by itself.
//
//   PURCHASES is where the result is READ. Every field on a transfer purchase
//   -- the party, the quantity, the rate, the date, even its invoice number --
//   is derived from the sale by purchasePayload() and written again by
//   syncPairedPurchase() on the next edit. A figure typed in here would either
//   be overwritten or, worse, would not be, and the same transfer would read
//   as two different events in two sets of books. So the register is readable
//   and no write is accepted.
//
// What counts as a transfer, precisely: a sale whose CUSTOMER stands for one
// of our own companies (customers.company_link_id) and is not the selling
// company itself. That is the same test raisePairedPurchase() makes before it
// raises anything, so the desk's boundary and the pairing rule cannot drift
// apart.

// Only these touch an invoice. Everything else on the sales channel -- stage
// moves, unloading, rejection, cancelling a number -- belongs to the desks
// that own those jobs.
const INTERCO_SALE_OPS = new Set([
  'create',
  'createInvoice',
  'update',
  'updateInvoice',
  'delete',
  'deleteInvoice'
])

/** Does this customer stand for one of our companies, other than the seller? */
async function customerIsOurCompany(customerId: unknown, sellerCompanyId: unknown): Promise<boolean> {
  const cid = Number(customerId) || 0
  if (!cid) return false
  const r = await getClient().execute({
    sql: 'SELECT company_link_id FROM customers WHERE id = ?',
    args: [cid]
  })
  const linked = Number((r.rows[0] as unknown as Row)?.company_link_id) || 0
  return linked > 0 && linked !== (Number(sellerCompanyId) || 0)
}

/** Is the invoice already in the books a transfer? Asked of the row, not the form. */
async function savedSaleIsTransfer(col: 'id' | 'invoice_group', value: unknown): Promise<boolean> {
  const v = col === 'id' ? Number(value) || 0 : String(value ?? '').trim()
  if (!v) return false
  const r = await getClient().execute({
    sql: `SELECT COUNT(*) AS n
            FROM sales s JOIN customers cu ON cu.id = s.customer_id
           WHERE s.${col} = ?
             AND cu.company_link_id IS NOT NULL
             AND cu.company_link_id <> s.company_id`,
    args: [v]
  })
  return (Number((r.rows[0] as unknown as Row)?.n) || 0) > 0
}

const INTERCO_SALES_REFUSAL =
  'Your access to Sales covers inter-company transfer invoices only — an invoice to an outside customer cannot be raised or changed here.'

async function assertScopedIntercompany(module: string, op: string, args: unknown): Promise<void> {
  if (module === 'orders') {
    throw new Error(
      'A transfer purchase is raised by its sale and kept in step with it — bill it from the Sales page. Nothing on Purchases can be changed from this login.'
    )
  }
  if (!INTERCO_SALE_OPS.has(op)) throw new Error(INTERCO_SALES_REFUSAL)

  const a = (args || {}) as Row
  const v = (a.values || {}) as Row

  // WHAT IT IS NOW, and what it is being turned into -- both have to be a
  // transfer. Moving an invoice off a company customer would hand this desk an
  // ordinary sale to an outside party, which is the one thing it must not
  // have; moving one ONTO a company customer would let it take a stranger's
  // invoice over. Either direction ends with the desk holding something it was
  // never given.
  const becomingTransfer = async (): Promise<boolean> =>
    customerIsOurCompany(v.customer_id, v.company_id)

  if (op === 'create' || op === 'createInvoice') {
    if (!(await becomingTransfer())) throw new Error(INTERCO_SALES_REFUSAL)
    return
  }

  const byRow = op === 'update' || op === 'delete'
  const already = byRow
    ? await savedSaleIsTransfer('id', a.id)
    : await savedSaleIsTransfer('invoice_group', a.group)
  if (!already) throw new Error(INTERCO_SALES_REFUSAL)

  // A delete carries no new customer, so what the invoice is now is the whole
  // question.
  if (op === 'delete' || op === 'deleteInvoice') return
  // An edit that names a customer must still name one of our companies.
  if (v.customer_id !== undefined && !(await becomingTransfer())) {
    throw new Error(INTERCO_SALES_REFUSAL)
  }
}

// Throws with a sentence the renderer shows verbatim. Returns quietly when the
// channel is unmapped, the user is unknown, or the action is allowed.
// For the few actions only an administrator may take — removing postings in a
// books repair, for one. Unlike the module rules this refuses when nobody is
// signed in: a repair must be traceable to the person who ran it.
export async function assertAdmin(what = 'This'): Promise<void> {
  const user = await currentAccessUser()
  if (!user || user.role !== 'admin') throw new Error(`${what} is for an administrator only`)
}

// ACCOUNTING, SECTION BY SECTION.
//
// The Accounting page's writes answer to the section they belong to (see
// accessSections.ts) rather than to one Accounting grant: a voucher to its
// type, a debit or credit note to its kind, a freight bill or shortage line to
// its side, ledgers and groups to Masters, opening figures to Openings. Worked
// out per call because the section is IN the call — a vouchers:create names
// its type in its values; an update or delete is looked up by its id.
//
// A section with no setting of its own follows Accounting (modulePerm), so an
// accountant granted Accounting keeps every one of these. Anything not listed
// returns null and stays exactly as open as it was.
const JOURNAL_MASTERS_OPS = new Set(['createAccount', 'renameLedger', 'createGroup', 'renameGroup', 'moveGroup', 'deleteGroup', 'setAccountGroup', 'setAccountsGroup', 'setAccountsHidden'])
const JOURNAL_OPENINGS_OPS = new Set(['saveOpenings', 'setBooksFrom', 'moveOpenings'])
const SECTION_LABEL: Record<string, string> = Object.fromEntries(ACCOUNTS_SECTIONS.map((s) => [s.key, s.label]))

async function accountsRule(ns: string, op: string, args: unknown): Promise<Rule | null> {
  const a = (args || {}) as Row
  const c = getClient()
  const one = async (sql: string, id: unknown): Promise<Row | null> => {
    const n = Number(id) || 0
    if (!n) return null
    const r = await c.execute({ sql, args: [n] }).catch(() => null)
    return (r?.rows[0] as unknown as Row) || null
  }
  const section = (key: string, extra: Partial<Rule> = {}): Rule => ({ module: key, label: SECTION_LABEL[key] || 'Accounting', ...extra })

  // alterOwned re-posts a document's voucher from Accounting: the same right
  // as altering a voucher of that type, judged on the voucher being altered.
  if (ns === 'vouchers' && (op === 'create' || op === 'update' || op === 'delete' || op === 'alterOwned')) {
    const stored = op === 'create' ? null : await one('SELECT vch_type FROM journal_entries WHERE id = ?', a.id)
    const type = String((op === 'create' ? a.values?.vchType : stored?.vch_type ?? a.values?.vchType) || '').toUpperCase()
    const key = VOUCHER_SECTION[type]
    return key
      ? section(key, { table: 'journal_entries', dateCol: 'entry_date', createDateKey: 'date' })
      : { module: 'accounts', label: 'Accounting', table: 'journal_entries', dateCol: 'entry_date', createDateKey: 'date' }
  }
  if (ns === 'notes' && (op === 'create' || op === 'update' || op === 'delete')) {
    const stored = op === 'create' ? null : await one('SELECT note_type FROM notes WHERE id = ?', a.id)
    const kind = String((op === 'delete' ? stored?.note_type : a.values?.note_type ?? stored?.note_type) || '').toLowerCase()
    return section(kind === 'credit' ? 'accountsCreditNote' : 'accountsDebitNote', { table: 'notes', dateCol: 'note_date' })
  }
  if (ns === 'journal') {
    if (JOURNAL_MASTERS_OPS.has(op)) {
      const action: Action = op === 'createAccount' || op === 'createGroup' ? 'create' : op === 'deleteGroup' ? 'delete' : 'edit'
      return section('accountsMasters', { action })
    }
    if (JOURNAL_OPENINGS_OPS.has(op)) return section('accountsOpenings')
    return null
  }
  // Tally File Updation: answers to its own section; creating a ledger from
  // it is also a Masters create.
  if (ns === 'tallyNotes') {
    if (op === 'createLedger') return section('accountsMasters', { action: 'create' })
    const kind = String(a.values?.kind || '').toLowerCase()
    if (op === 'post') return section(kind === 'debit' ? 'accountsDebitNote' : 'accountsCreditNote', { action: 'create' })
    // Booking a missing sale from Tally makes vouchers: a create on this screen.
    if (op === 'postSales' || op === 'postRegister' || op === 'postBank') return section('accountsTallyImport', { action: 'create' })
    // Taking a booking back deletes its vouchers.
    if (op === 'undoBatch') return section('accountsTallyImport', { action: 'delete' })
    return section('accountsTallyImport', {
      action: ['preview', 'salesCheck', 'salesPreview', 'registerCheck', 'registerPreview', 'bankSuggest', 'bankCheck', 'bankPreview', 'health', 'batches', 'companyBanks', 'drafts', 'saveDraft', 'clearDraft'].includes(op) ? 'view' : 'edit'
    })
  }
  if (ns === 'tbill' && op === 'postRcm') {
    return section('accountsRcmReg', { action: 'edit', table: 'transporter_bills', dateCol: 'bill_date' })
  }
  if (ns === 'tbill' && (op === 'create' || op === 'update' || op === 'delete')) {
    const stored = op === 'create' ? null : await one('SELECT side FROM transporter_bills WHERE id = ?', a.id)
    const side = String((op === 'delete' ? stored?.side : a.values?.side ?? stored?.side) || '').toLowerCase()
    return section(side === 'sale' ? 'accountsFrOutward' : 'accountsFrInward', { table: 'transporter_bills', dateCol: 'bill_date' })
  }
  if (ns === 'tfreight' && ['raiseNote', 'unraiseNote', 'waive', 'unwaive'].includes(op)) {
    const line = await one('SELECT sale_id FROM transporter_ledger WHERE id = ?', a.lineId)
    return section(line && Number(line.sale_id) ? 'accountsFrOutward' : 'accountsFrInward')
  }
  return null
}

export async function assertAllowed(channel: string, args: unknown): Promise<void> {
  const [ns, op] = String(channel).split(':')
  if (!op) return
  if (READ_OPS.has(op)) return
  const rule = CHANNEL_RULES[ns] ?? (await accountsRule(ns, op, args))
  if (!rule) return

  // Opening stock is open to everyone, on purpose.
  //
  // It is the one figure the whole register stands on, it is counted by the
  // people on the floor rather than by whoever holds the Stock edit right, and
  // until it is in every product reads negative. Gating it behind a permission
  // meant the person holding the count sheet could not enter it. It is also
  // exempt from the books-start window below, because it is the entry that
  // DEFINES that start date.
  if (ns === 'stockOpening' || ns === 'skuOpening') return
  await assertOnOrAfterBooksStart(rule, op, args)
  const user = await currentAccessUser()
  if (!user) return
  if (user.role === 'admin') return

  // A narrowed job answers the whole question on its own — the ordinary
  // per-action rights below would let an 'edit' grant through everything.
  if (moduleScope(user, rule.module) === 'unload' && rule.module === 'sales') {
    assertScopedSales(op, args)
    return
  }
  // The customer-TDS desk: booking the TDS a customer deducted, on an invoice
  // that has none yet, and nothing else on the page. Also held beside the
  // inter-company desk (sales.also_tds) — then only for this one act.
  const tdsToo = rule.module === 'sales' && moduleScope(user, 'sales') === 'intercompany' && !!(modulePerm(user, 'sales') as Row).also_tds && op === 'tdsPost'
  if ((moduleScope(user, rule.module) === 'tds' && rule.module === 'sales') || tdsToo) {
    if (op !== 'tdsPost') {
      throw new Error('Your access to Sales covers booking the TDS customers deducted on invoices that have none yet — nothing else on this page can be changed.')
    }
    const { saleHasTds } = await import('./saleTds')
    const saleId = Number((args as Row)?.values?.sale_id)
    if (!saleId || (await saleHasTds(saleId))) {
      throw new Error('The TDS on this invoice is already booked — only an invoice with no TDS yet can be filled in from this desk.')
    }
    return
  }
  // The same idea for Purchases: a job, not a set of ticks.
  if (moduleScope(user, rule.module) === 'readings' && rule.module === 'orders') {
    assertScopedReadings(op)
    return
  }
  // And the desk that bills what the companies move between themselves -- one
  // job across two pages, which is why it answers for both modules here.
  if (
    moduleScope(user, rule.module) === 'intercompany' &&
    (rule.module === 'sales' || rule.module === 'orders')
  ) {
    await assertScopedIntercompany(rule.module, op, args)
    return
  }
  // And for Sales bargains: one direction of one number.
  if (moduleScope(user, rule.module) === 'topup' && rule.module === 'salesBargains') {
    assertScopedBargainTopUp(op, args)
    return
  }

  let action = rule.action ?? actionFor(op)
  // Finishing an unfinished entry is part of making it — see GATE_FINISH_OPS.
  // Deliberately only when the entry is still pending, and only for the three
  // weighbridge acts; the Edit dialog (gate:update) stays an edit throughout.
  if (
    ns === 'gate' &&
    action === 'edit' &&
    GATE_FINISH_OPS.has(op) &&
    (await gateEntryUnfinished(Number((args as Row)?.id) || 0))
  ) {
    action = 'create'
  }
  // The row's own date decides the read-only window; without one, only the
  // right itself is checked.
  let entryDate: unknown
  const id = Number((args as Row)?.id) || 0
  // For a create there is no row yet, so the date being written IS the date to
  // judge. It arrives on the values object under its own column name.
  if (action === 'create' && rule.dateCol) {
    const a = args as Row
    const key = rule.createDateKey || rule.dateCol
    entryDate = a?.values?.[key] ?? a?.[key]
  }
  if ((action === 'edit' || action === 'delete') && rule.table && rule.dateCol && id) {
    try {
      const res = await getClient().execute({
        sql: `SELECT ${rule.dateCol} AS d FROM ${rule.table} WHERE id = ? LIMIT 1`,
        args: [id]
      })
      entryDate = res.rows[0]?.d
    } catch {
      // A table without that column must never block the write.
      entryDate = undefined
    }
  }
  const verdict = can(user, rule.module, action, {
    entryDate,
    today: todayISO(),
    moduleLabel: rule.label
  })
  if (!verdict.allowed) throw new Error(verdict.reason || 'You are not allowed to do that')
  // Re-dating an invoice (the Tally check's fix) moves it to a NEW date, which
  // has to sit inside the working window as well as the date it leaves.
  if ((ns === 'sales' && op === 'fixDate') || (ns === 'tallyNotes' && op === 'fixRegisterDate')) {
    const newDate = ns === 'sales' ? (args as Row)?.date : (args as Row)?.values?.date
    const moved = can(user, rule.module, 'edit', { entryDate: newDate, today: todayISO(), moduleLabel: rule.label })
    if (!moved.allowed) throw new Error(moved.reason || 'You are not allowed to do that')
  }
  // Moving a balance edits this bargain AND strikes a new one, so it needs the
  // right to create as well — dated the day the new bargain is struck.
  if (op === 'moveBalance') {
    const made = can(user, rule.module, 'create', {
      entryDate: (args as Row)?.values?.date || todayISO(),
      today: todayISO(),
      moduleLabel: rule.label
    })
    if (!made.allowed) throw new Error(made.reason || 'You are not allowed to do that')
  }
}
