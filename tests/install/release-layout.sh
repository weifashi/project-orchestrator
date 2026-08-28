#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"
pnpm release
version=$(node -p 'require("./package.json").version')
release="$root/release/project-orchestrator-$version"
for path in \
  app/control/dist/main.js app/mcp/dist/main.js app/operations/dist/main.js \
  bin/project-orchestratord bin/project-orchestrator-mcp bin/project-orchestrator-operations \
  web/index.html migrations/001_foundation.sql \
  marketplaces/codex/.agents/plugins/marketplace.json \
  marketplaces/claude/.claude-plugin/marketplace.json symlinks.json manifest.sha256; do
  test -e "$release/$path" || { echo "missing release path: $path" >&2; exit 1; }
done
test -z "$(find "$release" -name '*.map' -o -name '.env' -o -name '.git')"
test -z "$(find "$release/app" -name '.modules.yaml' -o -type d -name '.bin')"
if grep -r -I -q '\.project-orchestrator-.*-staging-' "$release/app"; then
  echo 'release contains a build-machine staging path' >&2
  exit 1
fi
while IFS= read -r -d '' link; do
  [[ $(readlink "$link") != /* ]] || { echo "absolute release symlink: $link" >&2; exit 1; }
done < <(find "$release" -type l -print0)
(cd "$release" && sha256sum -c manifest.sha256 >/dev/null)
cmp scripts/install.sh "$release/install.sh"

# Exercise a real compiled CLI through an older-version install, persistent data,
# online backup, upgrade, and backup integrity check.
upgrade_home=$(mktemp -d)
previous_source="$upgrade_home/source-0.1.36"
previous_commit=
mapfile -t package_commits < <(git log --format=%H -- package.json)
for candidate in "${package_commits[@]}"; do
  candidate_version=$(git show "$candidate:package.json" | node -e 'let value="";process.stdin.on("data",chunk=>value+=chunk).on("end",()=>process.stdout.write(JSON.parse(value).version))')
  if [[ $candidate_version = 0.1.36 ]]; then previous_commit=$candidate; break; fi
done
test -n "$previous_commit" || { echo 'cannot locate the real 0.1.36 source revision' >&2; exit 1; }
cleanup_upgrade() {
  git worktree remove --force "$previous_source" >/dev/null 2>&1 || true
  chmod -R u+w "$upgrade_home" 2>/dev/null || true
  rm -rf "$upgrade_home"
}
trap cleanup_upgrade EXIT
git worktree add --detach "$previous_source" "$previous_commit" >/dev/null
(cd "$previous_source" && pnpm install --frozen-lockfile >/dev/null && pnpm release >/dev/null)
previous_release="$previous_source/release/project-orchestrator-0.1.36"
(cd "$previous_release" && sha256sum -c manifest.sha256 >/dev/null)
previous_tree=$(find "$previous_release" -type f -printf '%m %P\n' -exec sha256sum {} \; | sha256sum | cut -d' ' -f1)
HOME="$upgrade_home" PROJECT_ORCHESTRATOR_SKIP_PLUGINS=1 bash "$previous_release/install.sh" --both --no-start --prefix "$upgrade_home/.local" >/dev/null
PROJECT_ORCHESTRATOR_DB="$upgrade_home/.project-orchestrator/orchestrator.sqlite" RELEASE_ROOT="$release" node --input-type=module <<'EOF'
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.RELEASE_ROOT}/app/control/package.json`);
const { openDatabase } = await import(require.resolve('@project-orchestrator/sqlite-store'));
const db = openDatabase(process.env.PROJECT_ORCHESTRATOR_DB);
const now = new Date().toISOString();
db.prepare('INSERT INTO web_users(id,username,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)').run(randomUUID(), 'upgrade-marker', 'marker', now, now);
db.close();
EOF
HOME="$upgrade_home" PROJECT_ORCHESTRATOR_SKIP_PLUGINS=1 bash "$release/install.sh" --both --no-start --prefix "$upgrade_home/.local" >/dev/null
test "$(readlink -f "$upgrade_home/.local/share/project-orchestrator/current")" = "$upgrade_home/.local/share/project-orchestrator/releases/$version"
upgrade_backup=$(find "$upgrade_home/.project-orchestrator/backups" -maxdepth 1 -type d -name "pre-$version-*" | sort | tail -1)
test -s "$upgrade_backup/orchestrator.sqlite"
for database in "$upgrade_home/.project-orchestrator/orchestrator.sqlite" "$upgrade_backup/orchestrator.sqlite"; do
  PROJECT_ORCHESTRATOR_DB="$database" RELEASE_ROOT="$release" node --input-type=module <<'EOF'
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.RELEASE_ROOT}/app/control/package.json`);
const { openDatabase } = await import(require.resolve('@project-orchestrator/sqlite-store'));
const db = openDatabase(process.env.PROJECT_ORCHESTRATOR_DB);
if (db.pragma('integrity_check', { simple: true }) !== 'ok') process.exit(1);
if (db.prepare("SELECT COUNT(*) AS count FROM web_users WHERE username='upgrade-marker'").get().count !== 1) process.exit(1);
db.close();
EOF
done
test "$(find "$previous_release" -type f -printf '%m %P\n' -exec sha256sum {} \; | sha256sum | cut -d' ' -f1)" = "$previous_tree"
OLD_RELEASE="$previous_release" NEW_RELEASE="$release" node --input-type=module <<'EOF'
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
async function inodes(root) {
  const result = new Set();
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) { const value = await stat(path); result.add(`${value.dev}:${value.ino}`); }
    }
  }
  await walk(root);
  return result;
}
const oldInodes = await inodes(process.env.OLD_RELEASE), newInodes = await inodes(process.env.NEW_RELEASE);
if ([...oldInodes].some((value) => newInodes.has(value))) throw new Error('old and new releases share writable file inodes');
EOF
cleanup_upgrade
trap - EXIT

tmp_home=$(mktemp -d)
port=$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
HOME="$tmp_home" PROJECT_ORCHESTRATOR_PORT="$port" PROJECT_ORCHESTRATOR_ORIGIN="http://127.0.0.1:$port" PROJECT_ORCHESTRATOR_SKIP_PLUGINS=1 bash "$release/install.sh" --both --no-start --prefix "$tmp_home/.local" >/dev/null
test "$(HOME="$tmp_home" "$tmp_home/.local/bin/project-orchestrator" version)" = "$version"
test -s "$tmp_home/.project-orchestrator/orchestrator.sqlite"
set -a
source "$tmp_home/.project-orchestrator/runtime/service.env"
set +a
node -e 'const net=require("node:net"),s=net.createServer();s.listen(process.argv[1],()=>setInterval(()=>{},1000))' "$PROJECT_ORCHESTRATOR_OPERATION_SOCKET" & stale_pid=$!
for _ in {1..50}; do [[ -S $PROJECT_ORCHESTRATOR_OPERATION_SOCKET ]] && break; sleep .1; done
kill -9 "$stale_pid" 2>/dev/null || true
wait "$stale_pid" 2>/dev/null || true
test -S "$PROJECT_ORCHESTRATOR_OPERATION_SOCKET"
if "$tmp_home/.local/bin/project-orchestrator" operations-ready >/dev/null 2>&1; then echo 'stale operation socket reported ready' >&2; exit 1; fi
"$tmp_home/.local/bin/project-orchestrator-operations" >"$tmp_home/operations.log" 2>&1 & operation_pid=$!
"$tmp_home/.local/bin/project-orchestratord" >"$tmp_home/control.log" 2>&1 & control_pid=$!
trap 'kill "$control_pid" "$operation_pid" 2>/dev/null || true; chmod -R u+w "$tmp_home" 2>/dev/null || true; rm -rf "$tmp_home"' EXIT
for _ in {1..50}; do curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1 && break; sleep .1; done
health=$(curl -fsS "http://127.0.0.1:$port/health")
database_id=$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$tmp_home/.project-orchestrator/orchestrator.sqlite")
node -e 'const h=JSON.parse(process.argv[1]);if(h.ok!==true||h.version!==process.argv[2]||h.database_id!==process.argv[3]||h.operations_ready!==true||"database_path" in h)process.exit(1)' "$health" "$version" "$database_id"
backup="$tmp_home/manual-backup.sqlite"
"$tmp_home/.local/bin/project-orchestrator" backup --output "$backup"
test -s "$backup"
PROJECT_ORCHESTRATOR_DB="$backup" RELEASE_ROOT="$release" node --input-type=module <<'EOF'
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.RELEASE_ROOT}/app/control/package.json`);
const { openDatabase } = await import(require.resolve('@project-orchestrator/sqlite-store'));
const db = openDatabase(process.env.PROJECT_ORCHESTRATOR_DB);
if (db.pragma('integrity_check', { simple: true }) !== 'ok') process.exit(1);
db.close();
EOF
unset PROJECT_ORCHESTRATOR_SOCKET PROJECT_ORCHESTRATOR_ADAPTER_CREDENTIAL_FILE
MCP_COMMAND="$tmp_home/.local/bin/project-orchestrator-mcp" node --input-type=module <<'EOF'
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
for (const clientType of ['codex', 'claude']) {
  const transport = new StdioClientTransport({ command: process.env.MCP_COMMAND, args: ['--client', clientType], stderr: 'pipe', env: process.env });
  const client = new Client({ name: 'release-smoke', version: '1' });
  await client.connect(transport);
  const tools = await client.listTools();
  if (!tools.tools.some((tool) => tool.name === 'create_run')) throw new Error(`${clientType} adapter did not connect`);
  await client.close();
}
EOF
echo 'release layout smoke passed'
