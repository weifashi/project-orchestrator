#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"
pnpm release
release="$root/release/project-orchestrator-0.1.0"
for path in \
  app/control/dist/main.js app/mcp/dist/main.js app/operations/dist/main.js \
  bin/project-orchestratord bin/project-orchestrator-mcp bin/project-orchestrator-operations \
  web/index.html migrations/001_foundation.sql \
  marketplaces/codex/.agents/plugins/marketplace.json \
  marketplaces/claude/.claude-plugin/marketplace.json manifest.sha256; do
  test -e "$release/$path" || { echo "missing release path: $path" >&2; exit 1; }
done
test -z "$(find "$release" -name '*.map' -o -name '.env' -o -name '.git')"
(cd "$release" && sha256sum -c manifest.sha256 >/dev/null)
tmp_home=$(mktemp -d)
HOME="$tmp_home" PROJECT_ORCHESTRATOR_SKIP_PLUGINS=1 bash "$release/install.sh" --both --no-start --prefix "$tmp_home/.local" >/dev/null
test "$(HOME="$tmp_home" "$tmp_home/.local/bin/project-orchestrator" version)" = 0.1.0
test -s "$tmp_home/.project-orchestrator/orchestrator.sqlite"
set -a
source "$tmp_home/.project-orchestrator/runtime/service.env"
set +a
"$tmp_home/.local/bin/project-orchestrator-operations" >"$tmp_home/operations.log" 2>&1 & operation_pid=$!
"$tmp_home/.local/bin/project-orchestratord" >"$tmp_home/control.log" 2>&1 & control_pid=$!
trap 'kill "$control_pid" "$operation_pid" 2>/dev/null || true; rm -rf "$tmp_home"' EXIT
for _ in {1..50}; do curl -fsS http://127.0.0.1:3847/health >/dev/null 2>&1 && break; sleep .1; done
curl -fsS http://127.0.0.1:3847/health >/dev/null
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
