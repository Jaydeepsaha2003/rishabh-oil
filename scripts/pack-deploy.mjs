// Assemble everything Hostinger needs, and nothing it does not.
//
// The obvious deploy — clone the repo and npm install on the server — installs
// the devDependencies too, and `electron` is one of them: a ~100 MB binary
// download onto shared hosting that will never be run. Building here instead and
// shipping the result means the server installs exactly two packages, because
// that is all the bundled server actually requires at runtime:
// @libsql/client and exceljs. Everything else is already inside index.cjs.
//
//   npm run web:pack        ->  deploy/  (upload this folder)
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'deploy')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

for (const required of ['out/server/index.cjs', 'out/web/index.html']) {
  if (!existsSync(join(root, required))) {
    console.error(`Missing ${required}. Run: npm run web:build`)
    process.exit(1)
  }
}

rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'out'), { recursive: true })

cpSync(join(root, 'out/server'), join(out, 'out/server'), { recursive: true })
cpSync(join(root, 'out/web'), join(out, 'out/web'), { recursive: true })
cpSync(join(root, 'server.js'), join(out, 'server.js'))

// The instant-deploy workflow. Lives here (not just pasted onto the
// web-deploy branch once) so it survives every future rebuild — this whole
// folder gets deleted and rewritten from scratch each time (see rmSync
// above), so anything not generated here would quietly disappear on the
// next `npm run web:pack`.
//
// Triggers on a push to web-deploy — the branch this script's own output
// gets committed to — not on push to main, so it fires exactly when a new
// build is actually ready, never on ordinary desktop-side commits.
mkdirSync(join(out, '.github/workflows'), { recursive: true })
writeFileSync(
  join(out, '.github/workflows/deploy-web.yml'),
  `name: Deploy web to Hostinger

on:
  push:
    branches: [web-deploy]
  # Lets a run be re-triggered by hand (gh workflow run / the Actions tab)
  # without needing a new commit — the whole point being to test the deploy
  # itself, not to manufacture a change just to have something to push.
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Pull and install on the server
        env:
          SSH_KEY: \${{ secrets.HOSTINGER_SSH_KEY }}
        run: |
          mkdir -p ~/.ssh
          printf '%s\\n' "$SSH_KEY" > ~/.ssh/deploy_key
          chmod 600 ~/.ssh/deploy_key
          ssh -i ~/.ssh/deploy_key -p 65002 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
            u526752913@217.21.91.205 '
              export PATH="/opt/alt/alt-nodejs22/root/usr/bin:$PATH"
              cd /home/u526752913/domains/rrbridge.in/rishabh-web &&
              git fetch origin web-deploy &&
              git reset --hard origin/web-deploy &&
              npm ci --no-audit --no-fund &&
              (mkdir -p tmp && touch tmp/restart.txt || true)
            '
`
)

// The two packages the bundle leaves external, at the versions this build was
// tested against. Nothing else: no react, no vite, no electron.
const runtime = ['@libsql/client', 'exceljs']
const deps = {}
for (const name of runtime) {
  const v = pkg.dependencies?.[name]
  if (!v) {
    console.error(`${name} is not in dependencies — cannot pin it`)
    process.exit(1)
  }
  deps[name] = v
}

writeFileSync(
  join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'rishabh-oil-web',
      version: pkg.version,
      private: true,
      // Hostinger's panel runs this; `node server.js` is the same thing.
      scripts: { start: 'node server.js' },
      dependencies: deps,
      engines: { node: '>=20.6' }
    },
    null,
    2
  ) + '\n'
)

// A lockfile turns the server's install into `npm ci`, which installs
// straight from it rather than re-resolving the dependency tree — the
// resolution step is what makes a first `npm install` slow on shared hosting,
// where every registry round trip is throttled. --package-lock-only writes
// the lockfile without touching this folder's own node_modules.
execFileSync('npm install --package-lock-only --no-audit --no-fund', {
  cwd: out,
  stdio: 'inherit',
  shell: true
})

writeFileSync(
  join(out, 'README.txt'),
  [
    'Rishabh Oil — web deployment bundle',
    '',
    'Upload the CONTENTS of this folder to the Hostinger application root, then:',
    '',
    '  npm ci --no-audit --no-fund   (installs 2 packages — no build, no Electron)',
    '',
    'npm ci rather than npm install: this folder ships package-lock.json, so ci',
    'installs straight from it instead of re-resolving the dependency tree —',
    'the slow part on shared hosting, where every registry round trip is',
    'throttled. --no-audit/--no-fund skip two more network calls that can hang',
    'for a long time if outbound access to those specific endpoints is',
    'restricted.',
    '',
    'Set these environment variables in hPanel:',
    '',
    '  TURSO_DATABASE_URL=file:/home/<user>/rishabh-data/rishabh.db',
    '  PORT=3000',
    '',
    'Leave TURSO_AUTH_TOKEN unset — a local SQLite file needs no token.',
    'Keep rishabh.db OUTSIDE this folder so a redeploy cannot delete it.',
    '',
    'Application startup file: server.js',
    '',
    'A healthy start logs "260 channels registered".',
    ''
  ].join('\n')
)

// What actually went in, so the size is a fact rather than a surprise.
const sizeOf = (dir) => {
  let total = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    total += e.isDirectory() ? sizeOf(p) : statSync(p).size
  }
  return total
}
const mb = (b) => (b / 1048576).toFixed(2) + ' MB'
console.log('deploy/')
console.log(`  out/server   ${mb(sizeOf(join(out, 'out/server')))}`)
console.log(`  out/web      ${mb(sizeOf(join(out, 'out/web')))}`)
console.log(`  server.js + package.json + README.txt`)
console.log(`  ---------------------------------`)
console.log(`  total        ${mb(sizeOf(out))}`)
console.log(`\n  npm ci on the server pulls: ${runtime.join(', ')}`)
