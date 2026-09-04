Rishabh Oil — web deployment bundle

Upload the CONTENTS of this folder to the Hostinger application root, then:

  npm ci --no-audit --no-fund   (installs 2 packages — no build, no Electron)

npm ci rather than npm install: this folder ships package-lock.json, so ci
installs straight from it instead of re-resolving the dependency tree —
the slow part on shared hosting, where every registry round trip is
throttled. --no-audit/--no-fund skip two more network calls that can hang
for a long time if outbound access to those specific endpoints is
restricted.

Set these environment variables in hPanel:

  TURSO_DATABASE_URL=file:/home/<user>/rishabh-data/rishabh.db
  PORT=3000

Leave TURSO_AUTH_TOKEN unset — a local SQLite file needs no token.
Keep rishabh.db OUTSIDE this folder so a redeploy cannot delete it.

Application startup file: server.js

A healthy start logs "260 channels registered".
