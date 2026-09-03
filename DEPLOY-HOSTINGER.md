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
| Database | Turso (cloud) | `data/rishabh.db` (local SQLite) |
| Front end | Electron window | browser |

Both read the **same `src/main/*` business logic** — 38 modules, every rule,
every query. The only difference is how a call reaches it: Electron IPC on the
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

### 3. Put the database somewhere a deploy cannot wipe

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

`PORT` is usually supplied by Hostinger; the app reads it if set and falls back
to 3000. Note the variable is still named `TURSO_DATABASE_URL` — it is simply
the database URL, and a `file:` scheme means local SQLite. Reusing the existing
name is what let the switch happen without touching a line of the data layer.

### 5. Load your data

Run this **once**, from a machine that has the Turso credentials (your own PC is
easiest):

```bash
npm run web:seed -- --out /path/to/rishabh.db
```

It copies every table, column, index and row — 79 tables — counts both ends and
**fails loudly on any mismatch**. Then upload that file to
`/home/<user>/rishabh-data/rishabh.db`.

Copying the schema from Turso also brings across the tables and columns created
by the `runOnce` migrations in `src/main/index.ts` (`stock_openings`,
`sku_openings`, `gate_entry_sales`, `bd_payment_ins`, `bd_linked_orders`,
`products.uom`). Those run at Electron startup, which the server does not
execute — so a database built from nothing would be missing them. Seeding from
Turso is therefore the supported way to create the website's database.

### 6. Start it

Restart the app in hPanel. The log should read:

```
[web] connecting to the database…
[db] schema ready
[web] local SQLite: WAL, busy_timeout 5s, foreign keys on
[web] listening on http://localhost:3000
[web] 260 channels registered
```

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

## Backups — your responsibility now

Turso kept backups for you. A local SQLite file does not.

The desktop app writes a full SQL dump daily (`src/main/backup.ts`), but that is
triggered from Electron startup, so **the web server does not run it**. Until
that is wired up, back the file up on a schedule:

```bash
# WAL mode means the file must be copied consistently — .backup does that safely,
# where cp can catch a write in progress.
sqlite3 /home/<user>/rishabh-data/rishabh.db ".backup '/home/<user>/backups/rishabh-$(date +%F).db'"
```

This is a company's accounting system. A cron job for that line is not optional.

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

6. **The two run on different databases.** The desktop stays on Turso; the
   website uses its own SQLite file. They cannot interfere with each other.

That last point is also the trade-off to keep in mind: **the two are not the
same data.** Entries made in the desktop app do not appear on the website, and
re-seeding the website discards whatever it has recorded since. Decide which one
is the book of record before staff use both.
