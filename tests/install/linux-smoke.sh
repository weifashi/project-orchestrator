#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

release="$tmp/project-orchestrator-0.1.1"
mkdir -p "$release/bin" "$release/app/control/dist" "$release/installer/linux" "$release/marketplaces/codex" "$release/marketplaces/claude"
printf '0.1.1\n' > "$release/VERSION"
printf '#!/bin/sh\nexit 0\n' > "$release/bin/project-orchestrator"
chmod +x "$release/bin/project-orchestrator"
cp "$root/scripts/install.sh" "$release/install.sh"
cp "$root/installer/linux/"*.service "$release/installer/linux/"
: > "$release/manifest.sha256"

home="$tmp/home"
mkdir -p "$home"
HOME="$home" PROJECT_ORCHESTRATOR_SKIP_MANIFEST=1 PROJECT_ORCHESTRATOR_SKIP_PLUGINS=1 bash "$release/install.sh" --both --no-start --prefix "$home/.local"
first_session_secret=$(cat "$home/.project-orchestrator/runtime/web-session-secret")
first_codex=$(cat "$home/.project-orchestrator/runtime/adapter-codex-credential")
HOME="$home" PROJECT_ORCHESTRATOR_SKIP_MANIFEST=1 PROJECT_ORCHESTRATOR_SKIP_PLUGINS=1 bash "$release/install.sh" --both --no-start --prefix "$home/.local"

test "$(cat "$home/.project-orchestrator/runtime/web-session-secret")" = "$first_session_secret"
test "$(cat "$home/.project-orchestrator/runtime/adapter-codex-credential")" = "$first_codex"
test -L "$home/.local/share/project-orchestrator/current"
test "$(stat -c %a "$home/.project-orchestrator")" = 700
test "$(stat -c %a "$home/.project-orchestrator/runtime/web-session-secret")" = 600
grep -q '127.0.0.1' "$home/.project-orchestrator/runtime/service.env"
grep -q 'UMask=0077' "$home/.config/systemd/user/project-orchestratord.service"
grep -q 'project-orchestrator-operations.service' "$home/.config/systemd/user/project-orchestratord.service"
service_line=$(grep -n '^\[Service\]$' "$home/.config/systemd/user/project-orchestratord.service" | cut -d: -f1)
limit_line=$(grep -n '^StartLimitIntervalSec=' "$home/.config/systemd/user/project-orchestratord.service" | cut -d: -f1)
((limit_line < service_line))
test "$(find "$home/.local/share/project-orchestrator/releases" -mindepth 1 -maxdepth 1 -type d | wc -l)" = 1

# The installer must keep the caller's PATH while registering clients. In Coder,
# Codex and Claude commonly live in ~/.npm-global/bin rather than /usr/bin.
client_bin="$tmp/client-bin"
client_log="$tmp/client-calls.log"
mkdir -p "$client_bin"
for client in codex claude; do
  cat > "$client_bin/$client" <<EOF
#!/usr/bin/env bash
printf '%s %s\n' '$client' "\$*" >> '$client_log'
case "\$*" in
  'plugin marketplace list --json')
    if [[ '$client' = codex ]]; then printf '{"marketplaces":[]}\n'; else printf '[]\n'; fi ;;
  'plugin list --json')
    if [[ '$client' = codex ]]; then
      printf '{"installed":[],"available":[{"pluginId":"project-orchestrator@project-orchestrator-local"}]}\n'
    else
      printf '[]\n'
    fi ;;
esac
EOF
  chmod +x "$client_bin/$client"
done
plugin_home="$tmp/plugin-home"
mkdir -p "$plugin_home"
HOME="$plugin_home" PATH="$client_bin:$PATH" PROJECT_ORCHESTRATOR_SKIP_MANIFEST=1 \
  bash "$release/install.sh" --both --no-start --prefix "$plugin_home/.local" >/dev/null
grep -q '^codex plugin marketplace list --json$' "$client_log"
grep -q '^codex plugin add project-orchestrator@project-orchestrator-local$' "$client_log"
grep -q '^claude plugin marketplace list --json$' "$client_log"
grep -q '^claude plugin install project-orchestrator@project-orchestrator-local --scope user$' "$client_log"

# An upgraded release must replace a Codex plugin and marketplace that point at an
# immutable old release, while Claude refreshes its cached plugin by version.
upgrade_log="$tmp/upgrade-client-calls.log"
upgrade_bin="$tmp/upgrade-client-bin"
mkdir -p "$upgrade_bin"
for client in codex claude; do
  cat > "$upgrade_bin/$client" <<EOF
#!/usr/bin/env bash
printf '%s %s\n' '$client' "\$*" >> '$upgrade_log'
case "\$*" in
  'plugin marketplace list --json')
    if [[ '$client' = codex ]]; then
      printf '{"marketplaces":[{"name":"project-orchestrator-local","root":"/old/project-orchestrator-0.1.0/marketplaces/codex"}]}\n'
    else
      printf '[]\n'
    fi ;;
  'plugin list --json')
    if [[ '$client' = codex ]]; then
      printf '{"installed":[{"pluginId":"project-orchestrator@project-orchestrator-local","version":"0.1.0"}]}\n'
    else
      printf '[{"id":"project-orchestrator@project-orchestrator-local","version":"0.1.0"}]\n'
    fi ;;
esac
EOF
  chmod +x "$upgrade_bin/$client"
done
upgrade_home="$tmp/upgrade-home"
mkdir -p "$upgrade_home"
HOME="$upgrade_home" PATH="$upgrade_bin:$PATH" PROJECT_ORCHESTRATOR_SKIP_MANIFEST=1 \
  bash "$release/install.sh" --both --no-start --prefix "$upgrade_home/.local" >/dev/null
grep -q '^codex plugin remove project-orchestrator@project-orchestrator-local$' "$upgrade_log"
grep -q '^codex plugin marketplace remove project-orchestrator-local$' "$upgrade_log"
grep -q '^codex plugin marketplace add ' "$upgrade_log"
grep -q '^codex plugin add project-orchestrator@project-orchestrator-local$' "$upgrade_log"
grep -q '^claude plugin update project-orchestrator@project-orchestrator-local --scope user$' "$upgrade_log"

if HOME="$home" bash "$release/install.sh" --prefix relative --no-start 2>/dev/null; then
  echo 'relative prefix unexpectedly accepted' >&2
  exit 1
fi

echo 'linux install smoke passed'
