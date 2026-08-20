#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

release="$tmp/project-orchestrator-0.1.0"
mkdir -p "$release/bin" "$release/app/control/dist" "$release/installer/linux" "$release/marketplaces/codex" "$release/marketplaces/claude"
printf '0.1.0\n' > "$release/VERSION"
printf '#!/bin/sh\nexit 0\n' > "$release/bin/project-orchestrator"
chmod +x "$release/bin/project-orchestrator"
cp "$root/scripts/install.sh" "$release/install.sh"
cp "$root/installer/linux/"*.service "$release/installer/linux/"
: > "$release/manifest.sha256"

home="$tmp/home"
mkdir -p "$home"
HOME="$home" PROJECT_ORCHESTRATOR_SKIP_MANIFEST=1 PROJECT_ORCHESTRATOR_SKIP_PLUGINS=1 bash "$release/install.sh" --both --no-start --prefix "$home/.local"
first_web=$(cat "$home/.project-orchestrator/runtime/web-token")
first_codex=$(cat "$home/.project-orchestrator/runtime/adapter-codex-credential")
HOME="$home" PROJECT_ORCHESTRATOR_SKIP_MANIFEST=1 PROJECT_ORCHESTRATOR_SKIP_PLUGINS=1 bash "$release/install.sh" --both --no-start --prefix "$home/.local"

test "$(cat "$home/.project-orchestrator/runtime/web-token")" = "$first_web"
test "$(cat "$home/.project-orchestrator/runtime/adapter-codex-credential")" = "$first_codex"
test -L "$home/.local/share/project-orchestrator/current"
test "$(stat -c %a "$home/.project-orchestrator")" = 700
test "$(stat -c %a "$home/.project-orchestrator/runtime/web-token")" = 600
grep -q '127.0.0.1' "$home/.project-orchestrator/runtime/service.env"
grep -q 'UMask=0077' "$home/.config/systemd/user/project-orchestratord.service"
grep -q 'project-orchestrator-operations.service' "$home/.config/systemd/user/project-orchestratord.service"
test "$(find "$home/.local/share/project-orchestrator/releases" -mindepth 1 -maxdepth 1 -type d | wc -l)" = 1

if HOME="$home" bash "$release/install.sh" --prefix relative --no-start 2>/dev/null; then
  echo 'relative prefix unexpectedly accepted' >&2
  exit 1
fi

echo 'linux install smoke passed'
