Rishabh Oil — web deployment bundle

Upload the CONTENTS of this folder to the Hostinger application root, then:

  npm install          (installs 2 packages — no build, no Electron)

Set these environment variables in hPanel:

  TURSO_DATABASE_URL=file:/home/<user>/rishabh-data/rishabh.db
  PORT=3000

Leave TURSO_AUTH_TOKEN unset — a local SQLite file needs no token.
Keep rishabh.db OUTSIDE this folder so a redeploy cannot delete it.

Application startup file: server.js

A healthy start logs "260 channels registered".
