# Desktop ERP Blueprint — reusable playbook

A step-by-step guide to the architecture, tech stack, design system, and release
pipeline used to build this app (a multi-company Electron + React + cloud-SQLite
desktop ERP). Follow it to spin up **another** software with the same foundation.

---

## 1. What you get with this stack

- A **Windows desktop app** (Electron) that talks to a **cloud SQLite** database
  (Turso / libSQL) — so multiple machines share one live database, no server to run.
- **Auto-updating installers** published from a GitHub Actions pipeline.
- A clean **React + TypeScript + Tailwind + shadcn/ui** front end.
- Multi-user with **roles/permissions**, an **audit trail**, **live refresh**
  across machines, and an **approval workflow** for sensitive actions.

---

## 2. Tech stack (exact)

| Layer | Choice | Version | Why |
|-------|--------|---------|-----|
| Desktop shell | **Electron** | ^33 | Cross-platform desktop, Node in main process |
| Build/bundler | **electron-vite** | ^2.3 | Vite for main/preload/renderer, fast HMR |
| UI framework | **React** | ^18.3 | Component model |
| Language | **TypeScript** | ^5.6 | Type safety end-to-end |
| Styling | **Tailwind CSS** | ^3.4 | Utility-first, tokenized theme |
| Components | **shadcn/ui** style (Radix primitives) | — | Accessible, copy-in components you own |
| Primitives | **@radix-ui/react-\*** | dialog, select, switch, tabs, tooltip, popover, label, slot | Headless a11y |
| Icons | **lucide-react** | ^0.454 | Consistent line icons |
| Toasts | **sonner** | ^2.0 | Notifications (bottom-right) |
| Dates | **date-fns** + **react-day-picker** | ^3.6 / ^8.10 | Formatting + calendar |
| Class utils | **clsx** + **tailwind-merge** (`cn()`), **class-variance-authority** | — | Variant styling |
| Font | **@fontsource-variable/inter** | — | Inter Variable |
| Database client | **@libsql/client/web** | ^0.14 | Turso/libSQL over HTTP (fetch-based — import the `/web` entry, never the default, so no native `.node` addon ships) |
| Auto-update | **electron-updater** | ^6.8 | Background download + install |
| Packaging | **electron-builder** | ^26 | NSIS installer, publish to GitHub |
| CI | **GitHub Actions** | — | Build + release on tag push |

**Database:** [Turso](https://turso.tech) (hosted libSQL/SQLite). One DB, many
clients. Free tier is generous. Auth via a database URL + token.

---

## 3. Repository layout

```
project/
├─ src/
│  ├─ main/                 # Electron MAIN process (Node) — all DB access lives here
│  │  ├─ index.ts           # app bootstrap: init DB, backfills, seeds, IPC, updater, window
│  │  ├─ db.ts              # libSQL client, SCHEMA_SQL runner, MIGRATIONS, revision cache
│  │  ├─ schema.ts          # CREATE TABLE statements (base schema)
│  │  ├─ ipc.ts             # ALL ipcMain handlers, behind a `handle()` wrapper
│  │  ├─ config.ts          # stored DB credentials (userData)
│  │  ├─ currentUser.ts     # who is acting on this device (for audit)
│  │  ├─ company.ts         # active company id (multi-tenant scoping)
│  │  ├─ repos.ts           # generic master-table CRUD (whitelisted columns)
│  │  ├─ <domain>.ts        # one module per domain (orders, sales, stock, journal…)
│  │  └─ updater.ts         # electron-updater wiring
│  ├─ preload/
│  │  ├─ index.ts           # contextBridge: the ONLY surface the UI can call (window.api)
│  │  └─ index.d.ts         # types for window.api
│  └─ renderer/
│     ├─ index.html
│     └─ src/
│        ├─ App.tsx         # routing (state-based), page switch, notification bell
│        ├─ assets/main.css # Tailwind + CSS color variables (design tokens)
│        ├─ components/      # Sidebar, PageHeader, EntityManager, ui/* (shadcn)
│        ├─ pages/           # one file per screen
│        └─ lib/            # format.ts, session.ts, modules.ts, useLiveRefresh.ts, utils.ts
├─ .github/workflows/build.yml
├─ electron.vite.config.ts
├─ electron-builder config (in package.json "build")
├─ tailwind.config.js
└─ package.json
```

**Golden rule:** the renderer NEVER touches the database or Node APIs. It calls
`window.api.*` (defined in preload) → `ipcMain` handler (in `ipc.ts`) → a domain
function (in `src/main/*`). The DB token never leaves the main process.

---

## 4. The design system (colouring, spacing, components)

### 4.1 Color tokens (HSL CSS variables)

Defined in `src/renderer/src/assets/main.css`, consumed by Tailwind via
`hsl(var(--token))`. This is the shadcn "slate" base. **Light theme:**

```css
:root {
  --background: 0 0% 100%;         /* white page */
  --foreground: 222.2 84% 4.9%;    /* near-black text */
  --card: 0 0% 100%;
  --popover: 0 0% 100%;
  --primary: 222.2 47.4% 11.2%;    /* dark slate — primary buttons */
  --primary-foreground: 210 40% 98%;
  --secondary: 210 40% 96.1%;      /* light grey chips */
  --muted: 210 40% 96.1%;
  --muted-foreground: 215.4 16.3% 46.9%;  /* secondary text */
  --accent: 210 40% 96.1%;
  --destructive: 0 84.2% 60.2%;    /* red */
  --border: 214.3 31.8% 91.4%;
  --input: 214.3 31.8% 91.4%;
  --ring: 222.2 84% 4.9%;
  --radius: 0.65rem;               /* rounded-lg */
}
.dark { /* same tokens, inverted — see main.css */ }
```

**Brand accent:** a warm **amber** (`bg-amber-500` / `text-amber-500`) for the
logo mark, the active company chip, and grouping bands (`bg-amber-100`,
`text-amber-900`). Swap amber for your brand hue in one place (the Sidebar logo +
a couple of grouping bands) to rebrand.

**Semantic status colours (used directly as Tailwind classes):**

| Meaning | Classes |
|---------|---------|
| Success / in-stock | `text-emerald-600`, `bg-emerald-100 text-emerald-700` |
| Warning / pending | `text-amber-700`, `bg-amber-100 text-amber-700` |
| Danger / negative | `text-red-600`, `text-destructive` |
| Info / neutral | `bg-sky-50 text-sky-800` (DLD/FOR), `bg-violet-50` (packaging) |
| Muted text | `text-muted-foreground` |

### 4.2 Badge variants

A single `Badge` component with `cva` variants: `default` (dark), `secondary`
(grey), `success` (green), `warning` (amber), `destructive` (red), `muted`,
`outline`. Use them for statuses so colour is consistent app-wide.

### 4.3 Typography & radius

- Font: **Inter Variable** (imported once), `font-feature-settings: 'rlig' 1,'calt' 1`.
- Base radius `0.65rem` → `rounded-lg` everywhere; cards `rounded-xl`.
- Numbers: always `tabular-nums` in tables for aligned digits.

### 4.4 Spacing / density conventions (keep it tight)

- Page content wrapper: `p-5` (not p-8). Sections: `space-y-4`/`space-y-5`.
- Cards: `rounded-xl border bg-card p-4 shadow-sm`.
- Dense tables: `text-[13px] [&_td]:py-2 [&_th]:h-9`.
- Forms: `grid gap-3 sm:grid-cols-2 lg:grid-cols-3`; label + control in a
  `grid gap-1.5` cell.
- Long tables scroll horizontally inside `overflow-x-auto` with a sensible
  `min-w-[Npx]` (sum of fixed columns + room for flexible ones — don't starve
  flex columns or cells collide).

### 4.5 Reusable layout components

- **`PageHeader`** — sticky title bar: `title`, `subtitle`, `hint` (ℹ tooltip),
  `actions` (right-aligned buttons). Reserves right padding (`pr-20`) so a
  fixed top-right widget (e.g. notification bell) never overlaps the actions.
- **`Sidebar`** — collapsed rail that expands on hover; grouped nav
  (`GROUPS` → `ITEMS` icon map), company switcher, user footer. Add a page by
  adding it to `Page` union + `ITEMS` + a `GROUPS` entry.
- **`EntityManager`** — generic master CRUD screen driven by a `fields` +
  `columns` config (types: text/number/switch/select/date, with
  `onFieldChange` for derived fields). Most master pages are ~15 lines.
- **`ui/select.tsx`** — a NON-portaled searchable combobox with the same API as
  Radix Select (so it works inside dialogs/focus traps). Auto-hides the search
  box for short lists (`searchable` prop / `items.length > 8`).
- **Full-page form pattern** — instead of a modal for complex forms, toggle a
  `formPage` boolean and render a full-width form with a "← Back" bar; hide the
  page header's action buttons while it's open.
- **Grouped register table pattern** — group rows by a key, render a clickable
  group band (collapsible) with per-group totals, a grand-total band, per-row
  serial numbers, and an optional per-row expandable detail row (chevron).

---

## 5. The main-process architecture (the important part)

### 5.1 Database client + schema + migrations (`db.ts`)

- `getClient()` lazily builds the libSQL client from **stored config OR env**:
  `import.meta.env.MAIN_VITE_TURSO_*` → `process.env.*`. Token stays in main.
- `initDb()` runs `SCHEMA_SQL` (idempotent `CREATE TABLE IF NOT EXISTS`) then a
  `MIGRATIONS` array of `ALTER`/`CREATE`/one-off `UPDATE` statements, each wrapped
  in try/catch so re-runs are safe (duplicate-column errors ignored).
- **Migration gotchas:** never put a `;` inside a SQL comment (it splits
  statements); string literals use **single quotes** (`'pending'`) — double
  quotes are read as identifiers by libSQL and throw `no such column`.

```ts
// MIGRATIONS is just an array of strings executed once each, guarded:
const MIGRATIONS = [
  'ALTER TABLE sales ADD COLUMN dispatch_stage TEXT',
  "UPDATE sales SET dispatch_stage = 'unloaded' WHERE status = 'done'",
  `CREATE TABLE IF NOT EXISTS approval_requests ( ... )`,
]
```

### 5.2 Live multi-user refresh (revision cache)

- A single `db_revision` integer row is **bumped on every write**.
- The main process caches it and a **single background watcher** polls the DB
  every ~4s; every renderer poll (`window.api.revision()`) is answered from
  memory. (Don't let every page poll the DB directly — on a slow link the
  round-trips pile up and freeze the UI.)
- Renderer hook **`useLiveRefresh(reload)`** compares the number and re-fetches
  when it changes; it skips while `document.hidden` or a reload is in flight.

### 5.3 The IPC wrapper (audit + revision + read/write split) (`ipc.ts`)

Every handler goes through one `handle(channel, fn)` wrapper that, for
non-read-only channels, bumps the revision and records an audit row:

```ts
const READONLY = /:list$|:get$|:needs$|:breakdown$|:mine$|^app:revision$|.../
const handle = (channel, fn) => ipcMain.handle(channel, async (e, args) => {
  const result = await fn(e, args)
  if (!READONLY.test(channel)) {
    await bumpRevision().catch(() => {})
    if (!AUDIT_SKIP.has(channel)) await recordAudit(channel, args, result)
  }
  return result
})
```

Name read channels `domain:list` / `domain:get` so they auto-skip the revision
bump. `session:setUser` sets the acting user (`currentUser.ts`) for the audit.

### 5.4 Multi-tenant scoping (`company.ts`)

- An "active company" id lives in main; business tables carry `company_id` and
  every scoped query filters by `getActiveCompanyId()`.
- Decide per table whether it is **company-scoped** (sales, purchases, stock) or
  **global/shared** (masters, bargains/contracts). Document the choice.

### 5.5 Generic master CRUD (`repos.ts`)

- A `TABLES` map whitelists writable columns per master table. All table/column
  names come from this map (never the renderer), so the dynamic SQL is safe;
  values are always bound parameters. One `create/update/remove/list` serves
  every master, paired with `EntityManager` on the front end.

### 5.6 Domain modules

One file per domain (e.g. `sales.ts`, `orders.ts`, `stock.ts`, `journal.ts`).
Keep **all validation and business rules here** (not the renderer): stock
sufficiency, balance checks, unit conversion, double-entry posting, etc. The
renderer only formats and calls.

### 5.7 Double-entry ledger (if you need accounting)

`journal.ts` posts balanced Dr/Cr entries (`postJournal` enforces Dr=Cr),
auto-creates accounts, and has helpers per document type (purchase/sale/payment).
A "Daybook" / "Ledger" screen is then just a query over `journal_entries`.

### 5.8 Approval workflow (optional but reusable)

Non-admin creates of sensitive rows are parked in an `approval_requests` queue
(payload as JSON) instead of the real table; an admin approves (inserts via the
generic repo) or rejects with a reason. Role is checked **server-side from the
DB**, never trusted from the client.

---

## 6. Preload = the API contract

`preload/index.ts` exposes a single `window.api` object grouped by domain:

```ts
const api = {
  revision: () => ipcRenderer.invoke('app:revision'),
  data: {
    list: (table) => ipcRenderer.invoke('data:list', { table }),
    create: (table, values) => ipcRenderer.invoke('data:create', { table, values }),
    // update/remove...
  },
  sales: { list: (from, to) => ipcRenderer.invoke('sales:list', { from, to }), /* ... */ },
  // one key per domain
}
contextBridge.exposeInMainWorld('api', api)
```

Keep `preload/index.d.ts` in sync (typed `Api` interface) so the renderer gets
full IntelliSense. Adding a feature = add the domain fn → ipc handler → preload
method + type → call it in a page. (Four small edits, always the same shape.)

---

## 7. Front-end conventions

- **Routing** is state-based in `App.tsx` (`page` state + a big switch), gated by
  `canAccess(user, key)` permissions. No router library needed for an internal
  tool.
- **`lib/format.ts`**: `formatINR`, `formatNum` (tabular), `formatDate`,
  `todayISO`, `convertQty` (unit-aware KG↔MT etc.), and `errText` (strips the
  `Error invoking remote method '…':` wrapper Electron adds to IPC rejections —
  always run IPC errors through this before showing a toast).
- **`lib/session.ts`**: current user in `localStorage`.
- **`lib/modules.ts`**: module list + `permLevel/canAccess/canWrite`.
- **Notification bell**: a fixed top-right widget with an unread badge and a Web
  Audio chime (no asset) — drive it off whatever data source (e.g. approvals).

---

## 8. Build, release & auto-update

### 8.1 electron-builder (in `package.json` "build")

- `productName`, `appId`, NSIS target (`oneClick:false`,
  `allowToChangeInstallationDirectory:true`), and a `publish` block pointing at a
  **public "releases" repo** (separate from the private source repo) so
  electron-updater can read `latest.yml`.
- `asarUnpack` native deps (`@libsql/**`).

### 8.2 GitHub Actions (`.github/workflows/build.yml`)

Triggered on `push` of a `v*` tag. Steps: checkout → node 22 → `npm ci` →
typecheck → pre-create the GitHub release in the releases repo → `npm run
release:win` (electron-vite build + electron-builder `--publish always`).

**Baked credentials:** pass DB creds as build env so a fresh install skips the
setup screen (only shows it if the connection is actually invalid):

```yaml
- run: npm run release:win
  env:
    MAIN_VITE_TURSO_DATABASE_URL: ${{ secrets.MAIN_VITE_TURSO_DATABASE_URL }}
    MAIN_VITE_TURSO_AUTH_TOKEN: ${{ secrets.MAIN_VITE_TURSO_AUTH_TOKEN }}
    GH_TOKEN: ${{ secrets.RELEASES_TOKEN }}   # PAT with contents:write on releases repo
```

electron-vite inlines `MAIN_VITE_*` into `import.meta.env` at build time.
⚠️ This bakes a DB token into the installer — fine for your own controlled
devices; use a scoped token if you distribute widely.

### 8.3 Release flow (per version)

```bash
# bump "version" in package.json, then:
git add -A && git commit -m "…" && git push origin main
git tag v0.3.31 && git push origin v0.3.31   # tag push triggers CI
```

Auto-update: `electron-updater` checks the releases repo, downloads in the
background, and a floating "Update" pill restarts into the new version.

---

## 9. Testing pattern (DB harness)

No heavy test framework — for backend logic, bundle a throwaway script with
esbuild and run it against a **temporary company + uniquely-named rows**, then
clean up:

```bash
npx esbuild _test.ts --bundle --platform=node --format=cjs \
  --define:import.meta.env=process.env \
  --external:electron --external:@libsql/* --external:libsql --outfile=_test.cjs
node --env-file=.env _test.cjs      # asserts, then deletes its temp rows
rm -f _test.ts _test.cjs
```

Use this to verify money math, stock rules, period registers, etc. before
shipping. Always run `npm run typecheck` too.

---

## 10. Local dev workflow

- `.env` holds `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` (git-ignored). Node 22
  reads it via `--env-file`; electron-vite also picks up `MAIN_VITE_*`.
- `npm run dev` starts electron-vite (renderer HMR + electron). Wait for
  `[db] schema ready` in the logs.
- **Renderer** edits hot-reload instantly. **Main-process** edits (anything in
  `src/main`, incl. new migrations) require killing electron and re-running
  `npm run dev`.
- Windows: `Get-Process electron | Stop-Process -Force` to restart.

---

## 11. Bootstrap a NEW app from zero (checklist)

1. `npm create @quick-start/electron@latest` (electron-vite, React+TS template).
2. Add Tailwind + `tailwind.config.js` (copy the `theme.extend.colors` token
   map above) + `assets/main.css` (copy the `:root`/`.dark` variables).
3. Drop in `lib/utils.ts` (`cn()`), the `ui/*` shadcn components you need
   (button, input, label, select, table, dialog, badge, tabs, tooltip,
   date-picker, switch).
4. Create the main-process skeleton: `db.ts` (client + `SCHEMA_SQL` +
   `MIGRATIONS` + revision cache), `ipc.ts` (`handle` wrapper + READONLY regex +
   audit), `config.ts`, `currentUser.ts`, `repos.ts`.
5. Define your `schema.ts` tables + a `users` table with `role`/`permissions`.
6. Build the preload `window.api` + `index.d.ts` contract.
7. Renderer shell: `App.tsx` (state routing + permission gate), `Sidebar`,
   `PageHeader`, `EntityManager`, `useLiveRefresh`, `format.ts`, `session.ts`,
   `modules.ts`.
8. Add pages one domain at a time (domain module → ipc → preload → page).
9. Configure electron-builder `build` block + a public releases repo +
   `.github/workflows/build.yml`; add the two `MAIN_VITE_TURSO_*` repo secrets
   and `RELEASES_TOKEN`.
10. Tag `v0.0.1` and let CI publish the first installer.

---

## 12. Conventions & gotchas cheat-sheet

- DB access only in **main**; renderer only via `window.api`.
- Read channels end in `:list`/`:get`/`:needs`/`:breakdown` → auto skip revision
  bump; everything else bumps + audits.
- SQL strings: **single quotes**; no `;` inside SQL comments; migrations are
  try/catch-guarded and idempotent.
- Money/qty math lives in main; convert units to a canonical base (e.g. MT)
  before comparing/pricing.
- Always run IPC errors through `errText()`; show toasts bottom-right.
- Keep `tabular-nums` on all numeric table cells; dense tables via
  `text-[13px] [&_td]:py-2 [&_th]:h-9`.
- Main-process change ⇒ restart electron; renderer change ⇒ HMR.
- Bump `package.json` version + push a `vX.Y.Z` tag to release.

---

*Generated as a reusable blueprint of this project's architecture, design tokens,
and pipeline. Copy the patterns, swap the domain, keep the foundation.*
