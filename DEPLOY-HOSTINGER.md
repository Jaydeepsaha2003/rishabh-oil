# Hosting the web version on Hostinger

The desktop app and the website are the same codebase and are deployed by two
completely separate mechanisms. Nothing here affects the desktop app or the
update your clients receive — see **Why the desktop app is unaffected** at the
end, which is the part worth reading twice.

---

## What runs where

| | Desktop app | Website |
|---|---|---|
| Built by | `electron-vite build` + `electron-builder` | `npm run web:build` |
| Triggered by | pushing a **`v*` tag** → GitHub Actions | a deploy on Hostinger |
| Ships to | `Jaydeepsaha2003/rishabh-oil-releases` | your Hostinger Node app |
| Database | Turso (cloud) | **Turso (cloud) — the same one** |
| Front end | Electron window | browser |

Both read the **same `src/main/*` business logic** — every rule, every query.
(Of the 46 files there, five do import Electron — `index.ts`, `ipc.ts`,
`config.ts`, `updater.ts`, `backup.ts` — and all five are plumbing. No business
module does.) The only difference is how a call reaches it: Electron IPC on the
desktop, `POST /api/invoke` on the web. Nothing is forked, so nothing can drift.

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

`web:build` does two things: bundles the server (`out/server/index.cjs`) and
builds the browser front end (`out/web/`). Neither is in the repository, because
build output does not belong in version control — so **this step is required on
every deploy**, not just the first.

### 3. Set the environment — the same database the desktop uses

In hPanel's Node.js app environment variables (preferred — they survive
deploys), or a `.env` file in the application root. Use the **same two values**
already in your desktop `.env`:

```
TURSO_DATABASE_URL=libsql://rishabh-oil-<your-org>.turso.io
TURSO_AUTH_TOKEN=<your token>
PORT=3000
```

`PORT` is usually supplied by Hostinger; the app reads it if set and falls back
to 3000.

**One database, both front ends.** An entry made on a staff PC appears on the
website, and an entry made on the website appears in the desktop app. There is
nothing to sync and nothing to reconcile, because there is only one copy.

That is not an accident of configuration — it is the only arrangement that can
work. The desktop app is *itself* a database client: `src/main/db.ts` connects
each staff PC straight to the database over HTTPS, with no server in between. A
SQLite file on Hostinger's disk is on Hostinger's disk, and those PCs cannot
reach it. Sharing therefore requires a database reachable over the network, and
Turso already is one.

A local SQLite file remains supported and is genuinely faster — but only for a
website whose data stands alone. See **The SQLite alternative** below.

### 4. Start it

Restart the app in hPanel. The log should read:

```
[web] connecting to the database…
[db] schema ready
[web] listening on http://localhost:3000
[web] 260 channels registered
```

(A `file:` URL adds one more line: `[web] local SQLite: WAL, busy_timeout 5s,
foreign keys on`.)

`260 channels registered` is the line that proves the whole business layer came
across. `/api/health` returns JSON without touching the database, which is what
to point an uptime check at.

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

## Backups

Turso keeps its own backups and supports point-in-time restore, which is one of
the reasons it wins for shared data. Two caveats worth knowing:

- **Restore is command-line only.** There is no phpMyAdmin equivalent. If
  something goes badly wrong, recovering needs a developer — the mill owner
  cannot do it self-serve from a control panel.
- **Turso is a vendor outside Hostinger.** A lapsed account or a billing problem
  takes down the desktop app *and* the website together, and it is not something
  Hostinger support can help with.

So keep a copy you own. This is now a one-command full export:

```bash
npm run web:seed -- --out backups/rishabh-2026-09-04.db
```

That produces a complete, openable SQLite file — every table, column, index and
row, with both ends counted and a non-zero exit on any mismatch. Run it on a
schedule from any machine with the credentials. A company's accounting system
should not have exactly one copy.

---

## The SQLite alternative

If you ever want the website to stand on its own — no vendor, no network hop,
faster queries — point it at a file instead:

```
TURSO_DATABASE_URL=file:/home/<user>/rishabh-data/rishabh.db
```

Keep that path **outside** the application root so a redeploy cannot delete it,
and seed it with `npm run web:seed -- --out <path>`. The server then sets WAL, a
5-second busy timeout and foreign keys on every start.

Two things to accept if you do:

1. **The data is the website's alone.** The desktop app cannot open a `file:`
   URL at all — `src/main/db.ts` imports `@libsql/client/web`, which refuses any
   scheme but `libsql:`/`https:`/`ws:`. So desktop and website would be two
   separate sets of books.
2. **Backups become entirely yours**, with `sqlite3 <db> ".backup '<dest>'"` on a cron —
   `cp` can catch a write mid-flight, `.backup` cannot.

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
   company switch would have redirected everyone else's writes.

6. **The desktop reaches the database exactly as it always did.** Sharing one
   Turso database changes nothing about how the desktop app connects — it was
   already a direct client of it. The website simply becomes a second front end
   on the same data.

One honest cost of sharing: every statement is an HTTP round trip, and the code
issues 867 individual `.execute()` calls with no batching — `journal.ts` inserts
one row per journal line. So the website is slower against Turso than against a
local file, most noticeably on screens that loop over rows. At this size (79
tables, ~7,900 rows) it is comfortable; worth revisiting if the books grow by an
order of magnitude, and batching those loops is the fix rather than changing
database.
