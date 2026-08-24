#!/usr/bin/env bash
set -euo pipefail
umask 077

die() { printf 'project-orchestrator install: %s\n' "$*" >&2; exit 1; }
json_has_marketplace() {
  node -e '
    const fs = require("node:fs");
    try {
      const value = JSON.parse(fs.readFileSync(0, "utf8"));
      const rows = Array.isArray(value) ? value : value.marketplaces;
      process.exit(Array.isArray(rows) && rows.some((row) => row && row.name === process.argv[1]) ? 0 : 1);
    } catch { process.exit(1); }
  ' "$2" <<<"$1"
}
json_has_installed_plugin() {
  node -e '
    const fs = require("node:fs");
    try {
      const value = JSON.parse(fs.readFileSync(0, "utf8"));
      const rows = Array.isArray(value) ? value : value.installed;
      process.exit(Array.isArray(rows) && rows.some((row) => row && (row.pluginId === process.argv[1] || row.id === process.argv[1])) ? 0 : 1);
    } catch { process.exit(1); }
  ' "$2" <<<"$1"
}
json_installed_plugin_version() {
  node -e '
    const fs = require("node:fs");
    try {
      const value = JSON.parse(fs.readFileSync(0, "utf8"));
      const rows = Array.isArray(value) ? value : value.installed;
      const row = Array.isArray(rows) ? rows.find((candidate) => candidate && (candidate.pluginId === process.argv[1] || candidate.id === process.argv[1])) : undefined;
      if (typeof row?.version === "string") process.stdout.write(row.version);
    } catch { }
  ' "$2" <<<"$1"
}
json_marketplace_root() {
  node -e '
    const fs = require("node:fs");
    try {
      const value = JSON.parse(fs.readFileSync(0, "utf8"));
      const rows = Array.isArray(value) ? value : value.marketplaces;
      const row = Array.isArray(rows) ? rows.find((candidate) => candidate && candidate.name === process.argv[1]) : undefined;
      if (typeof row?.root === "string") process.stdout.write(row.root);
    } catch { }
  ' "$2" <<<"$1"
}

clients=both
start=1
prefix=${HOME:-}/.local
while (($#)); do
  case "$1" in
    --codex) clients=codex ;;
    --claude) clients=claude ;;
    --both) clients=both ;;
    --no-start) start=0 ;;
    --prefix)
      shift; (($#)) || die '--prefix requires an absolute path'
      prefix=$1 ;;
    *) die "unknown flag: $1" ;;
  esac
  shift
done
[[ $prefix = /* ]] || die '--prefix must be absolute'
[[ $(uname -s) = Linux ]] || die 'this release slice currently supports Linux only'
command -v node >/dev/null || die 'Node.js 22 or newer is required'
node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
((node_major >= 22)) || die 'Node.js 22 or newer is required'
node_dir=$(dirname "$(command -v node)")

release_root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
[[ -f $release_root/VERSION && -x $release_root/bin/project-orchestrator ]] || die 'run this installer from a built release directory'
if [[ ${PROJECT_ORCHESTRATOR_SKIP_MANIFEST:-0} != 1 ]]; then
  [[ -s $release_root/manifest.sha256 ]] || die 'release manifest is missing'
  (cd "$release_root" && sha256sum -c manifest.sha256 >/dev/null) || die 'release manifest verification failed'
fi
version=$(<"$release_root/VERSION")
releases=$prefix/share/project-orchestrator/releases
target=$releases/$version
mkdir -p "$releases" "$prefix/bin"
chmod 700 "$prefix/share/project-orchestrator" "$releases"
if [[ ! -d $target ]]; then
  staging=$releases/.install-$version-$$
  mkdir -p "$staging"
  cp -a "$release_root"/. "$staging"/
  mv "$staging" "$target"
fi
current=$prefix/share/project-orchestrator/current
ln -s "$target" "$current.new.$$"
mv -Tf "$current.new.$$" "$current"
for executable in project-orchestrator project-orchestratord project-orchestrator-mcp project-orchestrator-operations; do
  ln -sfn "$current/bin/$executable" "$prefix/bin/$executable"
done

data=${PROJECT_ORCHESTRATOR_DATA:-$HOME/.project-orchestrator}
for directory in "$data" "$data/backups" "$data/logs" "$data/objects" "$data/runtime"; do
  mkdir -p "$directory"; chmod 700 "$directory"
done
new_secret() { node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url")+"\n")'; }
for secret_file in web-session-secret adapter-codex-credential adapter-claude-credential; do
  path=$data/runtime/$secret_file
  if [[ ! -s $path ]]; then new_secret > "$path"; fi
  chmod 600 "$path"
done
[[ $(<"$data/runtime/adapter-codex-credential") != $(<"$data/runtime/adapter-claude-credential") ]] || die 'client credentials must differ'

port=${PROJECT_ORCHESTRATOR_PORT:-3847}
lan_access=${PROJECT_ORCHESTRATOR_LAN_ACCESS:-1}
[[ $lan_access = 0 || $lan_access = 1 ]] || die 'PROJECT_ORCHESTRATOR_LAN_ACCESS must be 0 or 1'
web_host=127.0.0.1
[[ $lan_access = 1 ]] && web_host=0.0.0.0
default_origin=${PROJECT_ORCHESTRATOR_ORIGIN:-http://127.0.0.1:$port}
if [[ -n ${VSCODE_PROXY_URI:-} && $default_origin = http://127.0.0.1:$port ]]; then
  default_origin=${VSCODE_PROXY_URI//\{\{port\}\}/$port}
fi
origins=${PROJECT_ORCHESTRATOR_ORIGINS:-$default_origin}
origin=${origins%%,*}
origin_hosts=()
IFS=',' read -r -a configured_origins <<< "$origins"
for configured_origin in "${configured_origins[@]}"; do
  configured_origin=${configured_origin//[[:space:]]/}
  origin_host=${configured_origin#*://}; origin_host=${origin_host%%/*}; origin_host=${origin_host%%:*}
  [[ -n $origin_host ]] || die 'PROJECT_ORCHESTRATOR_ORIGINS must contain HTTP(S) origins'
  origin_hosts+=("$origin_host")
done
origin_hosts_csv=$(IFS=,; printf '%s' "${origin_hosts[*]}")
allowed_hosts=${PROJECT_ORCHESTRATOR_ALLOWED_HOSTS:-127.0.0.1,localhost,$origin_hosts_csv}
cat > "$data/runtime/service.env" <<EOF
HOME=$HOME
PATH=$prefix/bin:$node_dir:/usr/local/bin:/usr/bin:/bin
PROJECT_ORCHESTRATOR_DATA=$data
PROJECT_ORCHESTRATOR_DB=$data/orchestrator.sqlite
PROJECT_ORCHESTRATOR_OBJECTS=$data/objects
PROJECT_ORCHESTRATOR_SOCKET=$data/runtime/control.sock
PROJECT_ORCHESTRATOR_OPERATION_SOCKET=$data/runtime/operations.sock
PROJECT_ORCHESTRATOR_WEB_SESSION_SECRET_FILE=$data/runtime/web-session-secret
PROJECT_ORCHESTRATOR_CODEX_CREDENTIAL_FILE=$data/runtime/adapter-codex-credential
PROJECT_ORCHESTRATOR_CLAUDE_CREDENTIAL_FILE=$data/runtime/adapter-claude-credential
PROJECT_ORCHESTRATOR_HOST=$web_host
PROJECT_ORCHESTRATOR_LAN_ACCESS=$lan_access
PROJECT_ORCHESTRATOR_PORT=$port
PROJECT_ORCHESTRATOR_ORIGINS=$origins
PROJECT_ORCHESTRATOR_ALLOWED_HOSTS=$allowed_hosts
EOF
chmod 600 "$data/runtime/service.env"
export PROJECT_ORCHESTRATOR_DATA="$data"
export PROJECT_ORCHESTRATOR_DB="$data/orchestrator.sqlite"
export PROJECT_ORCHESTRATOR_OBJECTS="$data/objects"
export PROJECT_ORCHESTRATOR_CODEX_CREDENTIAL_FILE="$data/runtime/adapter-codex-credential"
export PROJECT_ORCHESTRATOR_CLAUDE_CREDENTIAL_FILE="$data/runtime/adapter-claude-credential"
"$prefix/bin/project-orchestrator" initialize

user_units=$HOME/.config/systemd/user
mkdir -p "$user_units"
render_unit() {
  sed -e "s|@PREFIX@|$prefix|g" -e "s|@DATA_DIR@|$data|g" "$1" > "$2"
  chmod 600 "$2"
}
render_unit "$current/installer/linux/project-orchestrator-operations.service" "$user_units/project-orchestrator-operations.service"
render_unit "$current/installer/linux/project-orchestratord.service" "$user_units/project-orchestratord.service"

if [[ ${PROJECT_ORCHESTRATOR_SKIP_PLUGINS:-0} != 1 ]]; then
  plugin_id=project-orchestrator@project-orchestrator-local
  if [[ $clients = codex || $clients = both ]]; then
    command -v codex >/dev/null || die 'Codex CLI is required for --codex/--both'
    codex_markets=$(codex plugin marketplace list --json 2>/dev/null || printf '[]')
    codex_plugins=$(codex plugin list --json 2>/dev/null || printf '[]')
    codex_market_root=$(json_marketplace_root "$codex_markets" project-orchestrator-local)
    codex_plugin_version=$(json_installed_plugin_version "$codex_plugins" "$plugin_id")
    expected_market_root=$(readlink -f "$current/marketplaces/codex")
    if [[ -n $codex_market_root && $codex_market_root != "$expected_market_root" ]]; then
      [[ -z $codex_plugin_version ]] || codex plugin remove "$plugin_id" >/dev/null
      codex plugin marketplace remove project-orchestrator-local >/dev/null
      codex_markets='[]'
      codex_plugin_version=''
    fi
    json_has_marketplace "$codex_markets" project-orchestrator-local || codex plugin marketplace add "$current/marketplaces/codex" >/dev/null
    [[ $codex_plugin_version = "$version" ]] || codex plugin add "$plugin_id" >/dev/null
  fi
  if [[ $clients = claude || $clients = both ]]; then
    command -v claude >/dev/null || die 'Claude CLI is required for --claude/--both'
    claude_markets=$(claude plugin marketplace list --json 2>/dev/null || printf '[]')
    json_has_marketplace "$claude_markets" project-orchestrator-local \
      || claude plugin marketplace add "$current/marketplaces/claude" --scope user >/dev/null
    claude_plugins=$(claude plugin list --json 2>/dev/null || printf '[]')
    claude_plugin_version=$(json_installed_plugin_version "$claude_plugins" "$plugin_id")
    if [[ -z $claude_plugin_version ]]; then
      claude plugin install "$plugin_id" --scope user >/dev/null
    elif [[ $claude_plugin_version != "$version" ]]; then
      claude plugin update "$plugin_id" --scope user >/dev/null
    fi
  fi
fi

service_mode=not-started
if ((start)); then
  if systemctl --user show-environment >/dev/null 2>&1; then
    systemctl --user daemon-reload
    systemctl --user enable project-orchestrator-operations.service project-orchestratord.service
    # enable --now does not restart an already-running service after an upgrade.
    systemctl --user restart project-orchestrator-operations.service project-orchestratord.service
    service_mode=systemd-user
  elif command -v sudo >/dev/null && sudo -n true >/dev/null 2>&1; then
    system_user=$(id -un); system_group=$(id -gn)
    system_prefix=project-orchestrator-$system_user
    tmp_units=$(mktemp -d)
    trap 'rm -rf "$tmp_units"' EXIT
    for name in operations daemon; do
      if [[ $name = operations ]]; then source_unit=$user_units/project-orchestrator-operations.service; output=$tmp_units/$system_prefix-operations.service
      else source_unit=$user_units/project-orchestratord.service; output=$tmp_units/$system_prefix.service; fi
      awk -v user="$system_user" -v group="$system_group" '{ print; if ($0 == "[Service]") { print "User=" user; print "Group=" group } }' "$source_unit" \
        | sed -e "s/project-orchestrator-operations\.service/$system_prefix-operations.service/g" > "$output"
    done
    sudo install -m 0644 "$tmp_units/$system_prefix-operations.service" "/etc/systemd/system/$system_prefix-operations.service"
    sudo install -m 0644 "$tmp_units/$system_prefix.service" "/etc/systemd/system/$system_prefix.service"
    sudo systemctl daemon-reload
    sudo systemctl enable "$system_prefix-operations.service" "$system_prefix.service"
    # enable --now does not restart an already-running service after an upgrade.
    sudo systemctl restart "$system_prefix-operations.service" "$system_prefix.service"
    service_mode=systemd-system
  else
    die 'no usable systemd user bus and passwordless sudo is unavailable; rerun with --no-start'
  fi
  for _ in {1..30}; do
    if curl -fsS --max-time 1 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  "$prefix/bin/project-orchestrator" doctor --json
fi

printf 'Installed Project Orchestrator %s (%s).\n' "$version" "$service_mode"
printf 'Local listener: http://127.0.0.1:%s\n' "$port"
printf 'Browser URL: %s/bootstrap\n' "$origin"
printf 'First browser visit: create the local administrator account.\n'
