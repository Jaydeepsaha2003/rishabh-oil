import { getClient, todayISO } from './db'
import { getActiveCompanyId } from './company'
import { stockLevels } from './stock'
import {
  type Audience,
  type Candidate,
  type RuleCtx,
  type RuleDef,
  type Severity,
  MODULE_PERM,
  daysBetween,
  renderTemplate,
  ddmmyyyy,
  inr,
  n,
  num3,
  plain
} from './notifyRules'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// The notification engine.
//
// Three parts and no more: a CATALOGUE of what can be said (below), a RUN that
// asks each enabled rule what is true right now, and a STORE that keeps one row
// per real-world fact so a rule can be evaluated as often as you like without
// the bell filling up with the same sentence.
//
// The dedupe key is what makes that work. It names the FACT, not the moment —
// "lc:41:expiring" rather than "lc:41:expiring:2026-09-09" — so a credit that
// is still expiring tomorrow does not raise a second notification tomorrow. A
// rule whose fact genuinely changes each day puts the day in its own key.
//
// In-app only, deliberately. Nothing here sends anything anywhere; a
// notification is a row this app shows on its own bell.

// --------------------------------------------------------------- catalogue --

export const RULES: RuleDef[] = [
  {
    key: 'approvals.pending',
    vars: [{ key: 'kind', label: 'What kind of master' }, { key: 'name', label: 'Its name' }, { key: 'by', label: 'Who raised it' }],
    module: 'approvals',
    label: 'Master waiting for approval',
    desc: 'Somebody has added a supplier, customer, product or other master and it is waiting for an admin to accept it.',
    severity: 'normal',
    enabled: true,
    audience: 'admins',
    page: 'approvals',
    // The approvals queue is not company-scoped — a master belongs to the
    // whole book — so this one takes no company filter.
    evaluate: async () => {
      const res = await getClient().execute({
        sql: `SELECT id, table_name, label, requested_by_name, requested_at
                FROM approval_requests
               WHERE status = 'pending'
               ORDER BY requested_at DESC
               LIMIT 200`,
        args: []
      })
      const LABEL: Record<string, string> = {
        oil_types: 'Oil type', products: 'Product', suppliers: 'Supplier',
        transporters: 'Transporter', customers: 'Customer', sources: 'Port',
        uoms: 'UOM', brokers: 'Broker', packagings: 'Packed SKU'
      }
      return plain(res).map((r) => ({
        dedupe: `approval:${r.id}`,
        title: `New ${LABEL[String(r.table_name)] || String(r.table_name)} to approve`,
        body: `${r.label || '—'} · raised by ${r.requested_by_name || 'a user'}`,
        vars: {
          kind: LABEL[String(r.table_name)] || String(r.table_name),
          name: String(r.label || '—'),
          by: String(r.requested_by_name || 'a user')
        }
      }))
    }
  },
  {
    key: 'approvals.decided',
    vars: [{ key: 'kind', label: 'What kind of master' }, { key: 'name', label: 'Its name' }, { key: 'decision', label: 'approved or rejected' }, { key: 'reason', label: 'Why, if turned down' }],
    module: 'approvals',
    label: 'Your submission was decided',
    desc: 'Something you added has been accepted or turned down by an admin. Only the person who raised it is told.',
    severity: 'normal',
    enabled: true,
    audience: 'everyone',
    page: 'approvals',
    evaluate: async () => {
      const res = await getClient().execute(
        `SELECT id, table_name, label, status, reason, requested_by, decided_at
           FROM approval_requests
          WHERE status IN ('approved','rejected') AND requested_by IS NOT NULL
            AND decided_at >= datetime('now', '-14 days')
          ORDER BY decided_at DESC
          LIMIT 200`
      )
      const LABEL: Record<string, string> = {
        oil_types: 'Oil type', products: 'Product', suppliers: 'Supplier',
        transporters: 'Transporter', customers: 'Customer', sources: 'Port',
        uoms: 'UOM', brokers: 'Broker', packagings: 'Packed SKU'
      }
      return plain(res).map((r) => ({
        dedupe: `decided:${r.id}:${r.status}`,
        // Only the person who asked. Everyone else has no interest in it.
        recipients: [n(r.requested_by)],
        severity: (String(r.status) === 'rejected' ? 'warning' : 'normal') as Severity,
        title: `${LABEL[String(r.table_name)] || String(r.table_name)} ${r.status}`,
        body:
          String(r.status) === 'rejected'
            ? `${r.label || '—'} — ${r.reason || 'no reason given'}`
            : String(r.label || '—'),
        vars: {
          kind: LABEL[String(r.table_name)] || String(r.table_name),
          name: String(r.label || '—'),
          decision: String(r.status),
          reason: String(r.reason || 'no reason given')
        }
      }))
    }
  },
  {
    key: 'treasury.lc_expiring',
    vars: [{ key: 'lc_no', label: 'LC number' }, { key: 'bank', label: 'Bank' }, { key: 'party', label: 'Supplier' }, { key: 'amount', label: 'Amount open' }, { key: 'days', label: 'Days away' }, { key: 'expires_on', label: 'Expiry date' }],
    module: 'treasury',
    label: 'Letter of credit expiring',
    desc: 'An open letter of credit is coming up to its expiry with documents still unpresented.',
    severity: 'critical',
    enabled: true,
    audience: 'admins',
    page: 'treasury',
    threshold: { label: 'Lead', question: 'Tell me this many days early', unit: 'days', def: 7, min: 1, max: 90 },
    evaluate: async ({ threshold, companyId, today }) => {
      const res = await getClient().execute({
        sql: `SELECT l.id, l.lc_no, l.bank, l.expiry_date, l.amount, s.name AS supplier_name
                FROM letters_of_credit l
                LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
               WHERE l.company_id = ? AND l.status != 'closed'
                 AND l.preclosed_date IS NULL AND l.expiry_date IS NOT NULL`,
        args: [companyId]
      })
      return plain(res)
        .map((l): Row => ({ ...l, left: daysBetween(today, String(l.expiry_date)) }))
        .filter((l) => l.left <= threshold)
        .map((l) => ({
          dedupe: `lc:${l.id}:expiring`,
          severity: (l.left < 0 ? 'critical' : 'warning') as Severity,
          title:
            l.left < 0
              ? `LC ${l.lc_no || l.id} expired ${Math.abs(l.left)} day${Math.abs(l.left) === 1 ? '' : 's'} ago`
              : l.left === 0
                ? `LC ${l.lc_no || l.id} expires today`
                : `LC ${l.lc_no || l.id} expires in ${l.left} day${l.left === 1 ? '' : 's'}`,
          body: `${l.bank || 'bank'} · ${l.supplier_name || 'party'} · ${inr(l.amount)} still open.`,
          vars: {
            lc_no: String(l.lc_no || l.id),
            bank: String(l.bank || 'bank'),
            party: String(l.supplier_name || 'party'),
            amount: inr(l.amount),
            days: Math.abs(l.left),
            expires_on: ddmmyyyy(l.expiry_date)
          }
        }))
    }
  },
  {
    key: 'treasury.bd_maturing',
    vars: [{ key: 'bd_no', label: 'BD number' }, { key: 'party', label: 'Party' }, { key: 'nbfc', label: 'NBFC' }, { key: 'amount', label: 'Amount' }, { key: 'days', label: 'Days away' }, { key: 'matures_on', label: 'Maturity date' }],
    module: 'treasury',
    label: 'Discounted bill maturing',
    desc: 'A discounted bill is reaching maturity with nothing received from the party against it.',
    severity: 'critical',
    enabled: true,
    audience: 'admins',
    page: 'treasury',
    threshold: { label: 'Lead', question: 'Tell me this many days early', unit: 'days', def: 3, min: 1, max: 60 },
    evaluate: async ({ threshold, companyId, today }) => {
      const res = await getClient().execute({
        sql: `SELECT bd.id, bd.bd_no, bd.maturity_date, bd.amount,
                     nb.name AS nbfc_name,
                     COALESCE(s.name, cu.name) AS party_name
                FROM bill_discountings bd
                LEFT JOIN nbfcs nb ON nb.id = bd.nbfc_id
                LEFT JOIN suppliers s ON bd.party_type = 'supplier' AND s.id = bd.party_id
                LEFT JOIN customers cu ON bd.party_type = 'customer' AND cu.id = bd.party_id
               WHERE bd.company_id = ? AND bd.status = 'open' AND bd.maturity_date IS NOT NULL`,
        args: [companyId]
      })
      return plain(res)
        .map((b): Row => ({ ...b, left: daysBetween(today, String(b.maturity_date)) }))
        .filter((b) => b.left <= threshold)
        .map((b) => ({
          dedupe: `bd:${b.id}:maturing`,
          severity: (b.left < 0 ? 'critical' : 'warning') as Severity,
          title:
            b.left < 0
              ? `BD ${b.bd_no || b.id} overdue by ${Math.abs(b.left)} day${Math.abs(b.left) === 1 ? '' : 's'}`
              : b.left === 0
                ? `BD ${b.bd_no || b.id} matures today`
                : `BD ${b.bd_no || b.id} matures in ${b.left} day${b.left === 1 ? '' : 's'}`,
          body: `${b.party_name || 'party'} · ${b.nbfc_name || 'NBFC'} · ${inr(b.amount)}.`,
          vars: {
            bd_no: String(b.bd_no || b.id),
            party: String(b.party_name || 'party'),
            nbfc: String(b.nbfc_name || 'NBFC'),
            amount: inr(b.amount),
            days: Math.abs(b.left),
            matures_on: ddmmyyyy(b.maturity_date)
          }
        }))
    }
  },
  {
    key: 'purchase.unmapped',
    vars: [{ key: 'count', label: 'How many' }, { key: 'invoices', label: 'The first few numbers' }, { key: 'days', label: 'The limit you set' }],
    module: 'purchase',
    label: 'Purchase invoice left unmapped',
    desc: 'A purchase invoice has sat with no tanker or bargain against it for longer than you allow.',
    severity: 'warning',
    enabled: true,
    audience: 'everyone',
    page: 'orders',
    threshold: { label: 'After', question: 'Only once it has sat this long', unit: 'days', def: 2, min: 0, max: 90 },
    evaluate: async ({ threshold, companyId, today }) => {
      const res = await getClient().execute({
        sql: `SELECT o.id, o.invoice_no, o.order_date, s.name AS supplier_name
                FROM orders o
                LEFT JOIN suppliers s ON s.id = o.supplier_id
               WHERE o.company_id = ? AND o.bargain_id IS NULL
                 AND COALESCE(o.is_trading, 0) = 0
               ORDER BY o.order_date DESC
               LIMIT 200`,
        args: [companyId]
      })
      const old = plain(res).filter((o) => daysBetween(String(o.order_date), today) >= threshold)
      if (!old.length) return []
      // One notification for the pile, not one per invoice: this is a chase-up,
      // and twelve identical rows on the bell is not twelve times as useful.
      // The day is in the key so it re-raises once a day while it stands.
      return [
        {
          dedupe: `unmapped:${today}`,
          title: `${old.length} purchase invoice${old.length === 1 ? '' : 's'} still unmapped`,
          body:
            old.slice(0, 3).map((o) => String(o.invoice_no || o.id)).join(', ') +
            (old.length > 3 ? ` and ${old.length - 3} more` : '') +
            ' — no bargain against them.',
          vars: {
            count: old.length,
            invoices: old.slice(0, 3).map((o) => String(o.invoice_no || o.id)).join(', '),
            days: threshold
          }
        }
      ]
    }
  },
  {
    key: 'purchase.shortage',
    vars: [{ key: 'tanker', label: 'Tanker number' }, { key: 'supplier', label: 'Supplier' }, { key: 'short', label: 'How much short' }, { key: 'allowed', label: 'What was allowed' }, { key: 'uom', label: 'Unit' }],
    module: 'purchase',
    label: 'Shortage beyond the allowance',
    desc: 'A received tanker came in short by more than its allowed tolerance, so a deduction is due from the transporter.',
    severity: 'critical',
    enabled: true,
    audience: 'admins',
    page: 'orders',
    threshold: { label: 'Over', question: 'Only when it is over the allowance by', unit: '%', def: 0, min: 0, max: 100, step: 0.01 },
    evaluate: async ({ threshold, companyId }) => {
      const res = await getClient().execute({
        sql: `SELECT pt.id, pt.tanker_no, pt.loaded_qty, pt.received_qty, pt.uom,
                     COALESCE(o.allowed_shortage_pct, b.allowed_shortage_pct, 0.2) AS allowed_pct,
                     s.name AS supplier_name
                FROM purchase_tankers pt
                LEFT JOIN orders o ON o.id = pt.order_id
                LEFT JOIN bargains b ON b.id = pt.bargain_id
                LEFT JOIN suppliers s ON s.id = pt.supplier_id
               WHERE pt.status = 'empty' AND pt.received_qty IS NOT NULL
                 AND (pt.company_id = ? OR pt.company_id IS NULL)
               ORDER BY pt.id DESC
               LIMIT 300`,
        args: [companyId]
      })
      return plain(res)
        .map((t): Row => {
          const loaded = n(t.loaded_qty)
          const short = loaded - n(t.received_qty)
          const allowed = (loaded * n(t.allowed_pct)) / 100
          return { ...t, short, allowed, over: short - allowed }
        })
        .filter((t) => t.short > 0 && t.over > 1e-6 && (t.allowed <= 0 || t.over / Math.max(t.allowed, 1e-9) * 100 >= threshold))
        .map((t) => ({
          dedupe: `shortage:${t.id}`,
          title: `${t.tanker_no || 'Tanker'} short beyond tolerance`,
          body: `${num3(t.short)} ${t.uom || 'MT'} short against ${num3(t.allowed)} allowed · ${t.supplier_name || 'supplier'}.`,
          vars: {
            tanker: String(t.tanker_no || 'Tanker'),
            supplier: String(t.supplier_name || 'supplier'),
            short: num3(t.short),
            allowed: num3(t.allowed),
            uom: String(t.uom || 'MT')
          }
        }))
    }
  },
  {
    key: 'stock.negative',
    vars: [{ key: 'product', label: 'Product' }, { key: 'closing', label: 'Closing figure' }],
    module: 'stock',
    label: 'Stock closes negative',
    desc: 'A product closes below nil, so more has gone out than was ever booked in.',
    severity: 'critical',
    enabled: true,
    audience: 'admins',
    page: 'stock',
    // Off stockLevels(), the same function the Stock register draws, rather
    // than a SUM of my own over a movements table — that would be a second
    // definition of "closing" free to disagree with the one on screen. There
    // is no stock_moves table at all: closing is derived, so this asks the
    // thing that derives it.
    evaluate: async ({ today }) => {
      const rows = await stockLevels().catch(() => [] as Row[])
      return rows
        .filter((p) => n(p.closing) < -1e-6)
        .map((p) => ({
          dedupe: `negstock:${p.product_id ?? p.id}:${today}`,
          title: `${p.product_code || p.product_name || 'A product'} closed at ${num3(p.closing)}`,
          body: 'More has gone out than was ever booked in. Check the opening figure and the movements behind it.',
          vars: {
            product: String(p.product_code || p.product_name || 'A product'),
            closing: num3(p.closing)
          }
        }))
    }
  },
  {
    key: 'treasury.lc_bill_due',
    vars: [{ key: 'invoice', label: 'Invoice number' }, { key: 'lc_no', label: 'LC number' }, { key: 'bank', label: 'Bank' }, { key: 'party', label: 'Supplier' }, { key: 'amount', label: 'Amount' }, { key: 'days', label: 'Days away' }, { key: 'due_on', label: 'Due date' }],
    module: 'treasury',
    label: 'LC bill reaching its due date',
    desc: 'A bill drawn under a letter of credit is coming up to its due date with nothing settled against it.',
    severity: 'warning',
    enabled: true,
    audience: 'admins',
    page: 'treasury',
    threshold: { label: 'Lead', question: 'Tell me this many days early', unit: 'days', def: 7, min: 1, max: 90 },
    evaluate: async ({ threshold, companyId, today }) => {
      const res = await getClient().execute({
        sql: `SELECT i.id, i.due_date, i.amount, l.lc_no, l.bank,
                     s.name AS supplier_name, o.invoice_no
                FROM lc_issuances i
                JOIN letters_of_credit l ON l.id = i.lc_id
                LEFT JOIN suppliers s ON l.party_type = 'supplier' AND s.id = l.party_id
                LEFT JOIN orders o ON o.id = i.order_id
               WHERE l.company_id = ?
                 AND COALESCE(i.status, 'outstanding') = 'outstanding'
                 AND i.due_date IS NOT NULL`,
        args: [companyId]
      })
      return plain(res)
        .map((b): Row => ({ ...b, left: daysBetween(today, String(b.due_date)) }))
        .filter((b) => b.left <= threshold)
        .map((b) => ({
          dedupe: `lcbill:${b.id}:due`,
          severity: (b.left < 0 ? 'critical' : 'warning') as Severity,
          title:
            b.left < 0
              ? `LC bill ${b.invoice_no || b.id} overdue by ${Math.abs(b.left)} day${Math.abs(b.left) === 1 ? '' : 's'}`
              : `LC bill ${b.invoice_no || b.id} due in ${b.left} day${b.left === 1 ? '' : 's'}`,
          body: `${b.lc_no || 'LC'} · ${b.bank || 'bank'} · ${b.supplier_name || 'party'} · ${inr(b.amount)}.`,
          vars: {
            invoice: String(b.invoice_no || b.id),
            lc_no: String(b.lc_no || 'LC'),
            bank: String(b.bank || 'bank'),
            party: String(b.supplier_name || 'party'),
            amount: inr(b.amount),
            days: Math.abs(b.left),
            due_on: ddmmyyyy(b.due_date)
          }
        }))
    }
  }
]

const RULE_BY_KEY = new Map(RULES.map((r) => [r.key, r]))

// ------------------------------------------------------------------ store --

export type StoredRule = {
  key: string
  enabled: boolean
  severity: Severity
  audience: Audience
  threshold: number | null
  recipients: number[] | null
  window_from: string | null
  window_to: string | null
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

const parseIds = (v: unknown): number[] | null => {
  if (v == null || v === '') return null
  try {
    const a = JSON.parse(String(v)) as unknown[]
    const ids = a.map((x) => n(x)).filter((x) => x > 0)
    return ids.length ? ids : null
  } catch {
    return null
  }
}

/** The catalogue merged with whatever has been saved over it. */
export async function listNotificationRules(): Promise<Row[]> {
  const res = await getClient().execute('SELECT * FROM notification_rules')
  const saved = new Map(plain(res).map((r) => [String(r.rule_key), r]))
  return RULES.map((d) => {
    const s = saved.get(d.key)
    return {
      key: d.key,
      module: d.module,
      label: d.label,
      desc: d.desc,
      page: d.page ?? null,
      enabled: s ? Number(s.enabled) === 1 : d.enabled,
      severity: (s?.severity as Severity) || d.severity,
      audience: (s?.audience as Audience) || d.audience,
      threshold: d.threshold ? (s?.threshold != null ? n(s.threshold) : d.threshold.def) : null,
      threshold_spec: d.threshold ?? null,
      recipients: parseIds(s?.recipients),
      window_from: (s?.window_from as string) || null,
      window_to: (s?.window_to as string) || null,
      // Blank means "whatever the rule writes itself".
      title_tpl: (s?.title_tpl as string) || '',
      body_tpl: (s?.body_tpl as string) || '',
      vars: d.vars ?? [],
      default_enabled: d.enabled,
      default_severity: d.severity,
      default_audience: d.audience,
      default_threshold: d.threshold?.def ?? null
    }
  })
}

export async function saveNotificationRule(v: Row): Promise<{ key: string }> {
  const key = String(v.key || '')
  const def = RULE_BY_KEY.get(key)
  if (!def) throw new Error('Unknown notification')
  const sev = String(v.severity || def.severity) as Severity
  if (!['critical', 'warning', 'normal'].includes(sev)) throw new Error('Unknown severity')
  const aud = String(v.audience || def.audience) as Audience
  if (!['admins', 'everyone', 'access'].includes(aud)) throw new Error('Unknown audience')
  let th: number | null = null
  if (def.threshold) {
    th = v.threshold == null || v.threshold === '' ? def.threshold.def : n(v.threshold)
    const { min, max } = def.threshold
    if (min != null && th < min) throw new Error(`${def.threshold.label} cannot be below ${min}`)
    if (max != null && th > max) throw new Error(`${def.threshold.label} cannot be above ${max}`)
  }
  // A named list overrides the audience entirely: pick three people and those
  // three are told, admin or not.
  const ids = Array.isArray(v.recipients) ? (v.recipients as unknown[]).map((x) => n(x)).filter((x) => x > 0) : null
  const from = String(v.window_from || '').trim()
  const to = String(v.window_to || '').trim()
  if (from && !HHMM.test(from)) throw new Error('Delivery window start must be a time like 08:00')
  if (to && !HHMM.test(to)) throw new Error('Delivery window end must be a time like 20:00')
  if (!!from !== !!to) throw new Error('Give both ends of the delivery window, or neither')

  // A rewritten message. Length-capped because it has to fit a bell row, and
  // checked for placeholders this rule cannot fill — a message that renders as
  // "{tanker} is short" on every notification is worse than the default, and
  // the moment to say so is now, not once it is on somebody's screen.
  const titleTpl = String(v.title_tpl || '').trim()
  const bodyTpl = String(v.body_tpl || '').trim()
  if (titleTpl.length > 160) throw new Error('Keep the heading under 160 characters — it has a bell row to fit in')
  if (bodyTpl.length > 400) throw new Error('Keep the message under 400 characters')
  const known = new Set((def.vars || []).map((x) => x.key))
  for (const tpl of [titleTpl, bodyTpl]) {
    for (const hit of tpl.matchAll(/\{([a-z0-9_]+)\}/gi)) {
      if (!known.has(hit[1])) {
        throw new Error(
          `This notification has nothing called {${hit[1]}}. It can use: ${
            [...known].map((k) => `{${k}}`).join(', ') || 'no placeholders at all'
          }`
        )
      }
    }
  }

  await getClient().execute({
    sql: `INSERT INTO notification_rules
            (rule_key, enabled, severity, audience, threshold, recipients, window_from, window_to,
             title_tpl, body_tpl, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(rule_key) DO UPDATE SET
            enabled = excluded.enabled, severity = excluded.severity,
            audience = excluded.audience, threshold = excluded.threshold,
            recipients = excluded.recipients,
            window_from = excluded.window_from, window_to = excluded.window_to,
            title_tpl = excluded.title_tpl, body_tpl = excluded.body_tpl,
            updated_at = excluded.updated_at`,
    args: [
      key, v.enabled ? 1 : 0, sev, aud, th,
      ids && ids.length ? JSON.stringify(ids) : null,
      from || null, to || null, titleTpl || null, bodyTpl || null
    ]
  })
  return { key }
}

export async function resetNotificationRule(key: string): Promise<{ key: string }> {
  await getClient().execute({ sql: 'DELETE FROM notification_rules WHERE rule_key = ?', args: [String(key)] })
  return { key: String(key) }
}

/** Who can be picked as a recipient. */
export async function notificationRecipients(): Promise<Row[]> {
  const res = await getClient().execute(
    "SELECT id, username, full_name, role FROM users WHERE active = 1 ORDER BY role = 'admin' DESC, username"
  )
  return plain(res)
}

/** One person silencing one notification for themselves. */
export async function muteNotificationRule(userId: number, key: string, muted: boolean): Promise<{ key: string }> {
  const c = getClient()
  if (muted) {
    await c.execute({
      sql: `INSERT INTO notification_mutes (user_id, rule_key) VALUES (?, ?)
            ON CONFLICT(user_id, rule_key) DO NOTHING`,
      args: [n(userId), String(key)]
    })
  } else {
    await c.execute({
      sql: 'DELETE FROM notification_mutes WHERE user_id = ? AND rule_key = ?',
      args: [n(userId), String(key)]
    })
  }
  return { key: String(key) }
}

export async function listNotificationMutes(userId: number): Promise<string[]> {
  const res = await getClient().execute({
    sql: 'SELECT rule_key FROM notification_mutes WHERE user_id = ?',
    args: [n(userId)]
  })
  return plain(res).map((r) => String(r.rule_key))
}

// ------------------------------------------------------------------- run ----

/** Inside the rule's delivery window, if it has one. */
function inWindow(rule: Row, now: Date): boolean {
  const from = String(rule.window_from || '')
  const to = String(rule.window_to || '')
  if (!from || !to) return true
  const mins = now.getHours() * 60 + now.getMinutes()
  const a = n(from.slice(0, 2)) * 60 + n(from.slice(3, 5))
  const b = n(to.slice(0, 2)) * 60 + n(to.slice(3, 5))
  // A window that wraps midnight (22:00 to 06:00) is two ranges, not one.
  return a <= b ? mins >= a && mins <= b : mins >= a || mins <= b
}

/**
 * Asks every enabled rule what is true, files anything new, and RETIRES
 * anything that has stopped being true.
 *
 * The retire half is what makes the bell trustworthy: a rule reports the world
 * as it is now, so a notification whose fact has gone — the credit was
 * extended, the shortage was written off, the invoice was finally mapped —
 * is resolved and drops off, and because the unique index only covers live
 * rows, the same fact becoming true again later raises a fresh one.
 *
 * Safe to run concurrently and as often as you like. A rule that throws is
 * skipped, and skipped means skipped ENTIRELY — its existing notifications are
 * left alone rather than resolved, because a failed query is not evidence that
 * anything stopped being true.
 */
export async function runNotificationRules(): Promise<{ raised: number; resolved: number; held: number; failed: string[] }> {
  const c = getClient()
  const companyId = getActiveCompanyId()
  const today = todayISO()
  const now = new Date()
  const rules = await listNotificationRules()
  let raised = 0
  let resolved = 0
  let held = 0
  const failed: string[] = []

  for (const r of rules) {
    const def = RULE_BY_KEY.get(String(r.key))
    if (!def?.evaluate) continue

    // A rule switched OFF retires what it already said. Leaving it on the bell
    // after somebody turned it off is the one thing the switch must not do.
    if (!r.enabled) {
      const res = await c.execute({
        sql: `UPDATE notifications SET resolved_at = datetime('now')
               WHERE company_id = ? AND rule_key = ? AND resolved_at IS NULL`,
        args: [companyId, r.key]
      })
      resolved += Number(res.rowsAffected || 0)
      continue
    }

    const ctx: RuleCtx = { threshold: n(r.threshold), companyId, today }
    let found: Candidate[] = []
    try {
      found = await def.evaluate(ctx)
    } catch (e) {
      failed.push(`${r.key}: ${(e as Error).message}`)
      continue
    }

    const live = new Set(found.map((f) => `${companyId}:${f.dedupe}`))

    // Retire first, so a fact that has gone leaves before anything new arrives.
    const stale = await c.execute({
      sql: `SELECT id, dedupe_key FROM notifications
             WHERE company_id = ? AND rule_key = ? AND resolved_at IS NULL`,
      args: [companyId, r.key]
    })
    for (const row of plain(stale)) {
      if (live.has(String(row.dedupe_key))) continue
      await c.execute({
        sql: "UPDATE notifications SET resolved_at = datetime('now') WHERE id = ?",
        args: [n(row.id)]
      })
      resolved += 1
    }

    // Outside its delivery window a rule still evaluates — so it can retire
    // what has gone — but nothing NEW is raised until the window opens. The
    // fact does not disappear; it waits.
    if (!inWindow(r, now)) {
      held += found.length
      continue
    }

    const ruleRecipients = Array.isArray(r.recipients) && r.recipients.length ? r.recipients : null
    for (const cand of found) {
      // The desk's own wording where there is one, the rule's otherwise. The
      // facts are the same either way — a custom message is a different
      // sentence about the same query, never a different query.
      const title = r.title_tpl ? renderTemplate(String(r.title_tpl), cand.vars) : cand.title
      const body = r.body_tpl ? renderTemplate(String(r.body_tpl), cand.vars) : cand.body
      // The fact's own people win over the rule's, which win over the audience.
      const who = cand.recipients?.length ? cand.recipients : ruleRecipients
      const recipients = who ? JSON.stringify(who) : null
      const res = await c.execute({
        sql: `INSERT INTO notifications
                (company_id, rule_key, severity, audience, recipients, title, body, page, dedupe_key, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
              ON CONFLICT(dedupe_key) WHERE resolved_at IS NULL DO NOTHING`,
        args: [
          companyId,
          r.key,
          cand.severity || r.severity,
          r.audience,
          recipients,
          title,
          body,
          cand.page || def.page || null,
          `${companyId}:${cand.dedupe}`
        ]
      })
      if (Number(res.rowsAffected || 0) > 0) raised += 1
    }
  }
  return { raised, resolved, held, failed }
}

/** What a rule WOULD raise right now, without filing any of it. */
export async function previewNotificationRule(key: string): Promise<Row[]> {
  const def = RULE_BY_KEY.get(String(key))
  if (!def?.evaluate) return []
  const rules = await listNotificationRules()
  const r = rules.find((x) => x.key === key)
  const found = await def.evaluate({
    threshold: n(r?.threshold),
    companyId: getActiveCompanyId(),
    today: todayISO()
  })
  return found.map((f) => ({
    title: r?.title_tpl ? renderTemplate(String(r.title_tpl), f.vars) : f.title,
    body: r?.body_tpl ? renderTemplate(String(r.body_tpl), f.vars) : f.body,
    severity: f.severity || r?.severity || def.severity,
    // The default, so the editor can show what it is replacing.
    default_title: f.title,
    default_body: f.body,
    vars: f.vars || {}
  }))
}

let watcher: ReturnType<typeof setInterval> | null = null

/** Checks on the way up, then every quarter hour. Idempotent. */
export function startNotificationWatcher(intervalMs = 15 * 60 * 1000): void {
  if (watcher) return
  const tick = (): void => {
    runNotificationRules().catch((e) => console.error('[notify] run failed:', e))
  }
  setTimeout(tick, 4000)
  watcher = setInterval(tick, intervalMs)
  if (typeof watcher.unref === 'function') watcher.unref()
}

/** Resolved notifications older than this are of no use to anyone. */
export async function pruneNotifications(days = 60): Promise<{ removed: number }> {
  const c = getClient()
  const res = await c.execute({
    sql: `DELETE FROM notifications
           WHERE resolved_at IS NOT NULL AND resolved_at < datetime('now', ?)`,
    args: [`-${Math.max(1, n(days) || 60)} days`]
  })
  await c.execute(
    'DELETE FROM notification_reads WHERE notification_id NOT IN (SELECT id FROM notifications)'
  )
  return { removed: Number(res.rowsAffected || 0) }
}

// ------------------------------------------------------------------ feed ----

/**
 * Can this person reach that module?
 *
 * The same question the sidebar asks, answered from the same column. An admin
 * has everything; Approvals is open to all because a user has to be able to
 * follow their own submissions; otherwise it is whatever their permissions
 * grant, in either of the two shapes the column holds — a bare 'write'/'read',
 * or the per-action object the newer screens write.
 */
function hasModuleAccess(user: Row | undefined, moduleKey: string): boolean {
  if (!user) return false
  if (String(user.role) === 'admin') return true
  if (moduleKey === 'approvals') return true
  let perms: Record<string, unknown> = {}
  try {
    const raw = user.permissions
    perms = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw as Record<string, unknown>) || {}
  } catch {
    return false
  }
  if (Array.isArray(perms)) return (perms as unknown[]).map(String).includes(moduleKey)
  const v = perms[moduleKey]
  if (v === 'write' || v === 'read') return true
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return !!(o.view || o.create || o.edit || o.delete)
  }
  return false
}

/** The bell's list for one user, newest first, with their own read state. */
export async function listNotifications(userId: number, isAdmin: boolean, limit = 50): Promise<Row[]> {
  const uid = n(userId)
  // Read the user rather than trusting what the caller said about them: the
  // permissions are needed here anyway, and a renderer is not the right place
  // to be deciding who counts as an admin.
  const who = plain(
    await getClient().execute({ sql: 'SELECT id, role, permissions FROM users WHERE id = ?', args: [uid] })
  )[0]
  const admin = who ? String(who.role) === 'admin' : isAdmin
  const res = await getClient().execute({
    sql: `SELECT nt.*, (rd.notification_id IS NOT NULL) AS is_read
            FROM notifications nt
            LEFT JOIN notification_reads rd ON rd.notification_id = nt.id AND rd.user_id = ?
           WHERE nt.company_id = ? AND nt.resolved_at IS NULL
             AND nt.rule_key NOT IN (SELECT rule_key FROM notification_mutes WHERE user_id = ?)
           ORDER BY nt.created_at DESC, nt.id DESC
           LIMIT ?`,
    args: [uid, getActiveCompanyId(), uid, Math.max(1, Math.min(200, n(limit) || 50))]
  })
  // Who hears it is read from the rule AS IT STANDS, not from the copy taken
  // when the notification was raised.
  //
  // It was the snapshot first, on the reasoning that editing a rule should not
  // rewrite who was told. That reasoning is right for history and wrong here:
  // everything in this list is a fact that is still TRUE, and who should hear
  // about a live fact is a current setting. Testing it against the real users
  // showed what the snapshot actually buys you — an admin changes "who hears
  // it", nothing on anyone's bell moves, and the setting looks broken. The
  // snapshot columns stay on the row as a record of what was decided at the
  // time; they simply no longer gate the feed.
  const rules = new Map((await listNotificationRules()).map((x) => [String(x.key), x]))
  return plain(res)
    .filter((r) => {
      const rule = rules.get(String(r.rule_key))
      const named = (rule ? rule.recipients : parseIds(r.recipients)) as number[] | null
      if (named && named.length) return named.includes(uid)
      const aud = String(rule ? rule.audience : r.audience)
      if (aud === 'everyone') return true
      if (aud === 'access') {
        const def = RULE_BY_KEY.get(String(r.rule_key))
        return def ? hasModuleAccess(who, MODULE_PERM[def.module]) : admin
      }
      return admin
    })
    .map((r) => ({ ...r, is_read: Number(r.is_read) === 1 }))
}

export async function markNotificationsRead(userId: number, ids: number[]): Promise<{ read: number }> {
  const c = getClient()
  let read = 0
  for (const id of ids) {
    const res = await c.execute({
      sql: `INSERT INTO notification_reads (user_id, notification_id, read_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(user_id, notification_id) DO NOTHING`,
      args: [n(userId), n(id)]
    })
    if (Number(res.rowsAffected || 0) > 0) read += 1
  }
  return { read }
}

/** Put one back as unread — the thing the old localStorage list could never do. */
export async function markNotificationUnread(userId: number, id: number): Promise<{ id: number }> {
  await getClient().execute({
    sql: 'DELETE FROM notification_reads WHERE user_id = ? AND notification_id = ?',
    args: [n(userId), n(id)]
  })
  return { id: n(id) }
}

export async function clearNotifications(userId: number, isAdmin: boolean): Promise<{ read: number }> {
  const rows = await listNotifications(userId, isAdmin, 200)
  return markNotificationsRead(userId, rows.filter((r) => !r.is_read).map((r) => Number(r.id)))
}
