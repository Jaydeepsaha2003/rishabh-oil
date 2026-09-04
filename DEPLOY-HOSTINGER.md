# Hosting the web version on Hostinger

The desktop app and the website are the same codebase, deployed by two
completely separate mechanisms. Nothing here affects the desktop app or the
update your clients receive — see **Why the desktop app is unaffected**, which
is the part worth reading twice.

---

## What runs where

| | Desktop app | Website |
|---|---|---|
| Built by | `electron-vite build` + `electron-builder` | `npm run web:build` |
| Triggered by | pushing a **`v*` tag** → GitHub Actions | a deploy on Hostinger |
| Ships to | `Jaydeepsaha2003/rishabh-oil-releases` | your Hostinger Node app |
| Database | **Turso** (cloud) | **SQLite** (`rishabh.db`, a local file) |
| Front end | Electron window | browser |

Both read the **same `src/main/*` business logic** — every rule, every query.
(Of the 46 files there, five import Electron — `index.ts`, `ipc.ts`,
`config.ts`, `updater.ts`, `backup.ts` — and all five are plumbing. No business
module does.) The only difference is how a call reaches it: Electron IPC on the
desktop, `POST /api/invoke` on the web. Nothing is forked, so nothing can drift.

> **The one thing to be clear about.** These are two separate databases, so they
> hold two separate sets of books. An entry made on a staff PC does not appear
> on the website, and an entry made on the website does not appear in the
> desktop app. See **Keeping the website fresh** for what can and cannot be done
> about that.

---

## First deploy

### 1. Create the Node.js app in hPanel

- **Application root**: the folder you clone into, e.g. `/home/<user>/rishabh-oil`
- **Application startup file**: `server.js`
- **Node version**: 20 or newer (22 preferred — `process.loadEnvFile` needs 20.6+)

### 2. Get the code

```bash
git clone https://github.com/Jaydeepsaha2003/rishabh-oil.git .
npm install
npm run web:build
```

`web:build` bundles the server (`out/server/index.cjs`) and builds the browser
front end (`out/web/`). Neither is in the repository, because build output does
not belong in version control — so **this step is required on every deploy**,
not just the first.

### 3. Put the database where a deploy cannot wipe it

This matters more than anything else on this page. Keep the file **outside** the
application root, so re-cloning or redeploying cannot delete your books:

```bash
mkdir -p /home/<user>/rishabh-data
```

### 4. Set the environment

In hPanel's Node.js app environment variables (preferred — they survive
deploys), or a `.env` file in the application root:

```
TURSO_DATABASE_URL=file:/home/<user>/rishabh-data/rishabh.db
PORT=3000
```

The variable keeps its old name because it is simply *the database URL* — a
`file:` scheme means local SQLite. Reusing the name is what let the switch
happen without touching a line of the data layer. Leave `TURSO_AUTH_TOKEN`
unset: a file needs no token.

`PORT` is usually supplied by Hostinger; the app reads it if set and falls back
to 3000.

### 5. Your data — two ways to start

**Option A — start empty and let the server build itself.** Point
`TURSO_DATABASE_URL` at a `file:` path that does not exist yet and just start
the app. `src/main/bootstrap.ts` (`runStartupTasks()`) is the exact sequence
the desktop runs from `app.whenReady()` — the schema, every `runOnce`
migration, and the same seed data (a default admin, baseline products,
formulations and packagings) — so a brand-new file ends up as a working,
loggable-into app with no manual step. It logs `[auth] seeded default admin
(admin / admin123)` the first time; change that password immediately.

**Option B — bring your existing books across.** Run this once, from a machine
that has the Turso credentials (your own PC is easiest):

```bash
npm run web:seed -- --out rishabh.db
```

It copies every table, column, index and row — 79 tables — counts both ends and
**exits non-zero on any mismatch**. Upload the result to
`/home/<user>/rishabh-data/rishabh.db`. `runStartupTasks()` runs against this
file too on every boot — every migration is already marked done, so it costs
one lookup per key and changes nothing.

Either way, the same function runs on every start, which is what makes a
redeploy safe: a database it has seen before picks up only what's new since,
and one it has never seen — including a file that was wiped or never uploaded
— comes up as a working app instead of failing to start.

### 6. Start it

Restart the app in hPanel. The log should read:

```
[web] connecting to the database…
[db] schema ready
[web] local SQLite: WAL, busy_timeout 5s, foreign keys on
[web] listening on http://localhost:3000
[web] 260 channels registered
```

`260 channels registered` proves the whole business layer came across, and the
`local SQLite` line confirms it is on the file rather than the cloud. Point any
uptime check at `/api/health`, which answers without touching the database.

The server sets four pragmas on every start, and only for a `file:` URL:

- **`journal_mode = WAL`** — readers carry on during a write. Without it one
  reader blocks every writer.
- **`busy_timeout = 5000`** — SQLite serialises writers; without a timeout the
  second one fails instantly with `SQLITE_BUSY`. With it, it waits its turn,
  which for millisecond writes is indistinguishable from never colliding.
- **`synchronous = NORMAL`** — safe under WAL. The failure mode is losing the
  last transaction on a power cut, not a corrupt file.
- **`foreign_keys = ON`** — declared throughout the schema, but SQLite ignores
  them unless asked, per connection.

---

## Every deploy after that

```bash
git pull
npm install
npm run web:build
```

…then restart the app. The database is untouched: it lives outside the
application root, and nothing in the build writes to it.

---

## Backups — now yours

Turso kept backups for you. A local file does not, and the daily dump in
`src/main/backup.ts` is triggered from Electron startup, so **the web server
never runs it**. Put this on a cron:

```bash
sqlite3 /home/<user>/rishabh-data/rishabh.db ".backup '/home/<user>/backups/rishabh-$(date +%F).db'"
```

Use `.backup`, not `cp`: under WAL a plain copy can catch a write in flight and
produce a file that opens but is subtly wrong. This is a company's accounting
system, and it should never have exactly one copy.

---

## Keeping the website fresh

The desktop writes to Turso and the website writes to its own file, so the two
drift apart from the moment both are in use. What is possible, honestly:

**A scheduled refresh — desktop changes reach the website.**

```bash
npm run web:seed -- --out /home/<user>/rishabh-data/rishabh.db --force
```

On a nightly cron this pulls everything the desktop has recorded. But `--force`
**replaces the file**, so anything entered on the website since the last refresh
is discarded. That makes this workable only if the website is treated as
read-only — a place to look at the books, not to enter them.

**True two-way sharing is not available on the installed client.** A libSQL
embedded replica — a local SQLite file that syncs with Turso — would give
exactly that, and it was tested. Turso rejects it:

```
you are using a client with a deprecated version of sync, that is not
supported in this platform. Please upgrade your client
```

Upgrading `@libsql/client` changes `package-lock.json` and therefore the desktop
installer's dependency tree, so it is a deliberate decision rather than a
detail. If two-way sharing becomes the priority, that is the path — or point the
website at Turso as well, which needs nothing but the URL.

**So decide which one is the book of record before staff use both.** Two sets of
books that each look authoritative is worse than one set that is merely
inconvenient to reach.

---

## Why the desktop app is unaffected

This is the condition the whole migration was built around, and it holds for
reasons you can check rather than take on trust:

1. **The release workflow only fires on a version tag.** `.github/workflows/build.yml`
   triggers on `push: tags: 'v*'` and manual dispatch — never on a push to
   `main`. Web code lands on `main` without building an installer, so your
   clients' auto-update sees nothing.

2. **No dependencies were added.** `package-lock.json` is untouched, so CI's
   `npm ci` resolves exactly what it did before. The web server is built on
   `node:http` with no framework, partly for this reason — a new dependency
   would also have been bundled into the installer.

3. **No existing script changed.** `dev`, `build`, `typecheck`, `release:win`
   and the rest are as they were. The six `web:*` scripts are additions.

4. **`electron.vite.config.ts` is untouched.** The web front end is built by a
   separate `vite.web.config.ts`, so the desktop build does not know the web
   build exists.

5. **The shared code stayed compatible.** `src/main/currentUser.ts` and
   `src/main/company.ts` now consult a request context when one exists — which
   only happens under the web server. On the desktop there is no context and
   they fall through to the module variable, exactly as before. This was
   necessary: those two were process-global, and on a server one person's
   company switch would have redirected everyone else's writes and
   mis-attributed the audit trail.

6. **The database switch is server-only.** `src/main/db.ts` still imports
   `@libsql/client/web`, which cannot open a `file:` URL at all — it refuses any
   scheme but `libsql:`/`https:`/`ws:`. Only `scripts/build-server.mjs` aliases
   that import to the file-capable client, and the desktop build never runs that
   script. The desktop physically cannot end up on the website's database.
