#!/usr/bin/env bash
set -euo pipefail
umask 077

die() { printf 'project-orchestrator install: %s\n' "$*" >&2; return 1; }
verify_release() {
  local root=$1
  (cd "$root" && sha256sum -c manifest.sha256 >/dev/null) || return 1
  node - "$root" <<'NODE'
const { lstatSync, readFileSync, readdirSync, readlinkSync } = require('node:fs');
const { dirname, relative, resolve } = require('node:path');
const root = resolve(process.argv[2]);
const expected = JSON.parse(readFileSync(resolve(root, 'symlinks.json'), 'utf8'));
const actual = {};
const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isSymbolicLink()) {
      const target = readlinkSync(path), resolved = resolve(dirname(path), target);
      if (target.startsWith('/') || (resolved !== root && !resolved.startsWith(`${root}/`)) || !lstatSync(resolved)) process.exit(1);
      actual[relative(root, path)] = target;
    }
  }
};
walk(root);
const normalize = (value) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
if (normalize(actual) !== normalize(expected)) process.exit(1);
NODE
}
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
json_has_rows() {
  node -e '
    const fs = require("node:fs");
    try {
      const value = JSON.parse(fs.readFileSync(0, "utf8"));
      const rows = Array.isArray(value) ? value : value[process.argv[1]];
      process.exit(Array.isArray(rows) ? 0 : 1);
    } catch { process.exit(1); }
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
  verify_release "$release_root" || die 'release manifest verification failed'
fi
version=$(<"$release_root/VERSION")
releases=$prefix/share/project-orchestrator/releases
target=$releases/$version
mkdir -p "$releases" "$prefix/bin"
chmod 700 "$prefix/share/project-orchestrator" "$releases"
current=$prefix/share/project-orchestrator/current
previous_target=$(readlink -f "$current" 2>/dev/null || true)
staging=$releases/.install-$version-$$
target_installed_by_transaction=0
restore_release_target() {
  rm -rf "$staging"
  if ((target_installed_by_transaction)); then
    chmod -R u+w "$target" 2>/dev/null || true
    rm -rf "$target"
  fi
}
rollback_release_copy() {
  code=$?
  trap - EXIT
  if ((code != 0)); then restore_release_target; fi
  exit "$code"
}
trap rollback_release_copy EXIT
rm -rf "$staging"
mkdir -p "$staging"
cp -a "$release_root"/. "$staging"/
if [[ ${PROJECT_ORCHESTRATOR_SKIP_MANIFEST:-0} != 1 ]]; then
  verify_release "$staging" || die 'staged release manifest verification failed'
fi
if [[ -d $target ]]; then
  target_valid=1
  if [[ ! -x $target/bin/project-orchestrator || ! -f $target/VERSION || $(<"$target/VERSION") != "$version" ]]; then target_valid=0; fi
  if [[ $target_valid = 1 && ${PROJECT_ORCHESTRATOR_SKIP_MANIFEST:-0} != 1 ]]; then
    verify_release "$target" || target_valid=0
  fi
  [[ $target_valid = 1 ]] || die "installed release $version is corrupt; publish a new version instead of replacing it in place"
  if [[ ${PROJECT_ORCHESTRATOR_SKIP_MANIFEST:-0} != 1 ]] && ! cmp -s "$target/manifest.sha256" "$staging/manifest.sha256"; then
    die "release $version already exists with different contents; increment the version before installing"
  fi
  rm -rf "$staging"
else
  mv "$staging" "$target"
  target_installed_by_transaction=1
fi

data=$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "${PROJECT_ORCHESTRATOR_DATA:-$HOME/.project-orchestrator}")
objects_existed=0
[[ -d $data/objects ]] && objects_existed=1
for directory in "$data" "$data/backups" "$data/logs" "$data/objects" "$data/runtime"; do
  mkdir -p "$directory"; chmod 700 "$directory"
done

backup=
database_existed=0
database_backup_complete=0
database_mutation_started=0
objects_backup_complete=0
objects_mutation_started=0
service_was_running=none
system_user=$(id -un)
system_group=$(id -gn)
system_prefix=project-orchestrator-$system_user
user_units=$HOME/.config/systemd/user
rollback_state=$data/runtime/install-rollback-$version-$$
rm -rf "$rollback_state"
mkdir -p "$rollback_state"
snapshot_file() {
  local source=$1 name=$2
  if [[ -e $source || -L $source ]]; then cp -a "$source" "$rollback_state/$name"; else : > "$rollback_state/$name.missing"; fi
}
restore_file() {
  local target_path=$1 name=$2
  if [[ -e $rollback_state/$name || -L $rollback_state/$name ]]; then
    mkdir -p "$(dirname "$target_path")"
    rm -f "$target_path"
    cp -a "$rollback_state/$name" "$target_path"
  elif [[ -e $rollback_state/$name.missing ]]; then
    rm -f "$target_path"
  fi
}
snapshot_file "$data/runtime/service.env" service.env
snapshot_file "$user_units/project-orchestrator-operations.service" user-operations.service
snapshot_file "$user_units/project-orchestratord.service" user-control.service
for executable in project-orchestrator project-orchestratord project-orchestrator-mcp project-orchestrator-operations; do snapshot_file "$prefix/bin/$executable" "bin-$executable"; done
system_operations_unit=/etc/systemd/system/$system_prefix-operations.service
system_control_unit=/etc/systemd/system/$system_prefix.service
system_units_snapshotted=0
user_services_were_enabled=0
system_services_were_enabled=0
systemctl --user is-enabled --quiet project-orchestratord.service 2>/dev/null && user_services_were_enabled=1
if command -v sudo >/dev/null && sudo -n true >/dev/null 2>&1 && sudo systemctl is-enabled --quiet "$system_prefix.service" 2>/dev/null; then system_services_were_enabled=1; fi
plugins_changed=0
codex_market_root_before=
codex_plugin_version_before=
claude_market_root_before=
claude_plugin_version_before=
committed=0
rollback_install() {
  code=${1:-$?}
  trap - ERR EXIT
  set +e
  rollback_failed=0
  if ((start)); then systemctl --user stop project-orchestratord.service project-orchestrator-operations.service >/dev/null 2>&1; fi
  if ((start)) && command -v sudo >/dev/null && sudo -n true >/dev/null 2>&1; then sudo systemctl stop "$system_prefix.service" "$system_prefix-operations.service" >/dev/null 2>&1; fi
  restore_release_target
  if ((database_mutation_started)); then
    rm -f "$data/orchestrator.sqlite" "$data/orchestrator.sqlite-wal" "$data/orchestrator.sqlite-shm"
    if ((database_existed && database_backup_complete)); then cp -a "$backup/orchestrator.sqlite" "$data/orchestrator.sqlite"; fi
  fi
  if ((objects_mutation_started)); then
    rm -rf "$data/objects"
    if ((objects_existed && objects_backup_complete)); then cp -a "$backup/objects" "$data/objects"; else mkdir -p "$data/objects"; chmod 700 "$data/objects"; fi
  fi
  if [[ -n $previous_target ]]; then
    ln -s "$previous_target" "$current.rollback.$$" && mv -Tf "$current.rollback.$$" "$current"
  else
    rm -f "$current"
  fi
  rm -f "$current.new.$$"
  for executable in project-orchestrator project-orchestratord project-orchestrator-mcp project-orchestrator-operations; do restore_file "$prefix/bin/$executable" "bin-$executable"; done
  restore_file "$data/runtime/service.env" service.env
  restore_file "$user_units/project-orchestrator-operations.service" user-operations.service
  restore_file "$user_units/project-orchestratord.service" user-control.service
  if systemctl --user show-environment >/dev/null 2>&1; then
    systemctl --user daemon-reload >/dev/null 2>&1
    if ((user_services_were_enabled)); then systemctl --user enable project-orchestrator-operations.service project-orchestratord.service >/dev/null 2>&1; else systemctl --user disable project-orchestrator-operations.service project-orchestratord.service >/dev/null 2>&1; fi
  fi
  if ((system_units_snapshotted)) && command -v sudo >/dev/null && sudo -n true >/dev/null 2>&1; then
    if [[ -e $rollback_state/system-operations.service ]]; then sudo install -m 0644 "$rollback_state/system-operations.service" "$system_operations_unit"; else sudo rm -f "$system_operations_unit"; fi
    if [[ -e $rollback_state/system-control.service ]]; then sudo install -m 0644 "$rollback_state/system-control.service" "$system_control_unit"; else sudo rm -f "$system_control_unit"; fi
    sudo systemctl daemon-reload >/dev/null 2>&1
    if ((system_services_were_enabled)); then sudo systemctl enable "$system_prefix-operations.service" "$system_prefix.service" >/dev/null 2>&1; else sudo systemctl disable "$system_prefix-operations.service" "$system_prefix.service" >/dev/null 2>&1; fi
  fi
  if ((plugins_changed)); then
    plugin_id=project-orchestrator@project-orchestrator-local
    if [[ $clients = codex || $clients = both ]]; then
      if ! current_codex_plugins=$(codex plugin list --json 2>/dev/null) || ! json_has_rows "$current_codex_plugins" installed; then current_codex_plugins='[]'; rollback_failed=1; fi
      if ! current_codex_markets=$(codex plugin marketplace list --json 2>/dev/null) || ! json_has_rows "$current_codex_markets" marketplaces; then current_codex_markets='[]'; rollback_failed=1; fi
      if json_has_installed_plugin "$current_codex_plugins" "$plugin_id"; then codex plugin remove "$plugin_id" >/dev/null 2>&1 || rollback_failed=1; fi
      if json_has_marketplace "$current_codex_markets" project-orchestrator-local; then codex plugin marketplace remove project-orchestrator-local >/dev/null 2>&1 || rollback_failed=1; fi
      if [[ -n $codex_market_root_before ]]; then codex plugin marketplace add "$codex_market_root_before" >/dev/null 2>&1 || rollback_failed=1; fi
      if [[ -n $codex_plugin_version_before ]]; then codex plugin add "$plugin_id" >/dev/null 2>&1 || rollback_failed=1; fi
    fi
    if [[ $clients = claude || $clients = both ]]; then
      if ! current_claude_plugins=$(claude plugin list --json 2>/dev/null) || ! json_has_rows "$current_claude_plugins" installed; then current_claude_plugins='[]'; rollback_failed=1; fi
      if ! current_claude_markets=$(claude plugin marketplace list --json 2>/dev/null) || ! json_has_rows "$current_claude_markets" marketplaces; then current_claude_markets='[]'; rollback_failed=1; fi
      if json_has_installed_plugin "$current_claude_plugins" "$plugin_id"; then claude plugin uninstall "$plugin_id" --scope user >/dev/null 2>&1 || rollback_failed=1; fi
      if json_has_marketplace "$current_claude_markets" project-orchestrator-local; then claude plugin marketplace remove project-orchestrator-local --scope user >/dev/null 2>&1 || rollback_failed=1; fi
      if [[ -n $claude_market_root_before ]]; then claude plugin marketplace add "$claude_market_root_before" --scope user >/dev/null 2>&1 || rollback_failed=1; fi
      if [[ -n $claude_plugin_version_before ]]; then claude plugin install "$plugin_id" --scope user >/dev/null 2>&1 || rollback_failed=1; fi
    fi
  fi
  if [[ $service_was_running = user ]]; then systemctl --user restart project-orchestrator-operations.service project-orchestratord.service >/dev/null 2>&1; fi
  if [[ $service_was_running = system ]]; then sudo systemctl restart "$system_prefix-operations.service" "$system_prefix.service" >/dev/null 2>&1; fi
  rm -rf "$rollback_state"
  if ((rollback_failed)); then
    printf 'project-orchestrator install: failed; rollback was incomplete and requires manual recovery\n' >&2
  else
    printf 'project-orchestrator install: failed; previous release and data were restored\n' >&2
  fi
  exit "$code"
}
trap 'code=$?; if ((code != 0 && committed == 0)); then rollback_install "$code"; fi' EXIT
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
lan_origins=${PROJECT_ORCHESTRATOR_LAN_ORIGINS:-http://127.0.0.1:$port,http://localhost:$port}
origin_hosts=()
IFS=',' read -r -a configured_origins <<< "$origins,$lan_origins"
for configured_origin in "${configured_origins[@]}"; do
  configured_origin=${configured_origin//[[:space:]]/}
  origin_host=${configured_origin#*://}; origin_host=${origin_host%%/*}; origin_host=${origin_host%%:*}
  [[ -n $origin_host ]] || die 'PROJECT_ORCHESTRATOR_ORIGINS must contain HTTP(S) origins'
  origin_hosts+=("$origin_host")
done
origin_hosts_csv=$(IFS=,; printf '%s' "${origin_hosts[*]}")
allowed_hosts=${PROJECT_ORCHESTRATOR_ALLOWED_HOSTS:-127.0.0.1,localhost,$origin_hosts_csv}
user_service_owned=0
system_service_owned=0
user_service_installed=0
system_service_installed=0
if [[ -f $user_units/project-orchestratord.service ]] && grep -Fq "EnvironmentFile=$data/runtime/service.env" "$user_units/project-orchestratord.service"; then user_service_owned=1; fi
if command -v sudo >/dev/null && sudo -n true >/dev/null 2>&1 && sudo test -f "$system_control_unit" \
  && sudo grep -Fq "EnvironmentFile=$data/runtime/service.env" "$system_control_unit"; then system_service_owned=1; fi
if ((user_service_owned)) && { systemctl --user is-active --quiet project-orchestratord.service 2>/dev/null || ((user_services_were_enabled)); }; then user_service_installed=1; fi
if ((system_service_owned)) && { sudo systemctl is-active --quiet "$system_prefix.service" 2>/dev/null || ((system_services_were_enabled)); }; then system_service_installed=1; fi
if ((user_service_installed && system_service_installed)); then die 'both user and system services are installed for this data directory; disable one service mode before upgrading'; fi
if ((user_service_owned)) && systemctl --user is-active --quiet project-orchestratord.service 2>/dev/null; then service_was_running=user; fi
if ((system_service_owned)) && sudo systemctl is-active --quiet "$system_prefix.service" 2>/dev/null; then service_was_running=system; fi
planned_service_mode=not-started
if ((start)); then
  if ((user_service_installed)); then
    planned_service_mode=systemd-user
  elif ((system_service_installed)); then
    planned_service_mode=systemd-system
    system_units_snapshotted=1
    if sudo test -e "$system_operations_unit"; then sudo cat "$system_operations_unit" > "$rollback_state/system-operations.service"; fi
    if sudo test -e "$system_control_unit"; then sudo cat "$system_control_unit" > "$rollback_state/system-control.service"; fi
  elif systemctl --user show-environment >/dev/null 2>&1; then
    planned_service_mode=systemd-user
  elif command -v sudo >/dev/null && sudo -n true >/dev/null 2>&1; then
    planned_service_mode=systemd-system
    system_units_snapshotted=1
    if sudo test -e "$system_operations_unit"; then sudo cat "$system_operations_unit" > "$rollback_state/system-operations.service"; fi
    if sudo test -e "$system_control_unit"; then sudo cat "$system_control_unit" > "$rollback_state/system-control.service"; fi
  else
    die 'no usable systemd user bus and passwordless sudo is unavailable; rerun with --no-start'
  fi
fi
if [[ ${PROJECT_ORCHESTRATOR_SKIP_PLUGINS:-0} != 1 ]]; then
  plugin_id=project-orchestrator@project-orchestrator-local
  if [[ $clients = codex || $clients = both ]]; then command -v codex >/dev/null || die 'Codex CLI is required for --codex/--both'; fi
  if [[ $clients = claude || $clients = both ]]; then command -v claude >/dev/null || die 'Claude CLI is required for --claude/--both'; fi
  if [[ $clients = codex || $clients = both ]]; then
    if ! codex_markets_before=$(codex plugin marketplace list --json 2>/dev/null) || ! json_has_rows "$codex_markets_before" marketplaces; then die 'cannot read the current Codex marketplace state'; fi
    if ! codex_plugins_before=$(codex plugin list --json 2>/dev/null) || ! json_has_rows "$codex_plugins_before" installed; then die 'cannot read the current Codex plugin state'; fi
    codex_market_root_before=$(json_marketplace_root "$codex_markets_before" project-orchestrator-local)
    codex_plugin_version_before=$(json_installed_plugin_version "$codex_plugins_before" "$plugin_id")
  fi
  if [[ $clients = claude || $clients = both ]]; then
    if ! claude_markets_before=$(claude plugin marketplace list --json 2>/dev/null) || ! json_has_rows "$claude_markets_before" marketplaces; then die 'cannot read the current Claude marketplace state'; fi
    if ! claude_plugins_before=$(claude plugin list --json 2>/dev/null) || ! json_has_rows "$claude_plugins_before" installed; then die 'cannot read the current Claude plugin state'; fi
    claude_market_root_before=$(json_marketplace_root "$claude_markets_before" project-orchestrator-local)
    claude_plugin_version_before=$(json_installed_plugin_version "$claude_plugins_before" "$plugin_id")
  fi
fi
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
PROJECT_ORCHESTRATOR_VERSION_FILE=$current/VERSION
PROJECT_ORCHESTRATOR_HOST=$web_host
PROJECT_ORCHESTRATOR_LAN_ACCESS=$lan_access
PROJECT_ORCHESTRATOR_LAN_ORIGINS=$lan_origins
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
export PROJECT_ORCHESTRATOR_VERSION_FILE="$target/VERSION"

if [[ $service_was_running = user ]]; then
  ((start)) || die 'services are running; omit --no-start so the upgrade can stop, verify, and restart them safely'
  systemctl --user stop project-orchestratord.service project-orchestrator-operations.service
elif [[ $service_was_running = system ]]; then
  ((start)) || die 'services are running; omit --no-start so the upgrade can stop, verify, and restart them safely'
  sudo systemctl stop "$system_prefix.service" "$system_prefix-operations.service"
fi
backup=$data/backups/pre-$version-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p "$backup"
chmod 700 "$backup"
cp -a "$data/objects" "$backup/objects.tmp"
mv "$backup/objects.tmp" "$backup/objects"
objects_backup_complete=1
if [[ -f $data/orchestrator.sqlite ]]; then
  database_existed=1
  "$target/bin/project-orchestrator" backup --output "$backup/orchestrator.sqlite.tmp"
  test -s "$backup/orchestrator.sqlite.tmp"
  "$target/bin/project-orchestrator" verify-database --path "$backup/orchestrator.sqlite.tmp"
  mv "$backup/orchestrator.sqlite.tmp" "$backup/orchestrator.sqlite"
  database_backup_complete=1
fi
database_mutation_started=1
objects_mutation_started=1
"$target/bin/project-orchestrator" initialize

mkdir -p "$user_units"
render_unit() {
  sed -e "s|@PREFIX@|$prefix|g" -e "s|@DATA_DIR@|$data|g" "$1" > "$2"
  chmod 600 "$2"
}
render_unit "$target/installer/linux/project-orchestrator-operations.service" "$user_units/project-orchestrator-operations.service"
render_unit "$target/installer/linux/project-orchestratord.service" "$user_units/project-orchestratord.service"

ln -s "$target" "$current.new.$$"
mv -Tf "$current.new.$$" "$current"
for executable in project-orchestrator project-orchestratord project-orchestrator-mcp project-orchestrator-operations; do
  ln -sfn "$current/bin/$executable" "$prefix/bin/$executable"
done
find "$target" -type d -exec chmod 0555 {} +
find "$target" -type f -exec chmod 0444 {} +
find "$target/bin" -type f -exec chmod 0555 {} +

service_mode=$planned_service_mode
if ((start)); then
  if [[ $planned_service_mode = systemd-user ]]; then
    systemctl --user daemon-reload
    systemctl --user enable project-orchestrator-operations.service project-orchestratord.service
    # enable --now does not restart an already-running service after an upgrade.
    systemctl --user restart project-orchestrator-operations.service project-orchestratord.service
    service_mode=systemd-user
  else
    tmp_units=$rollback_state/system-units
    mkdir -p "$tmp_units"
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
  fi
  database_id=$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$data/orchestrator.sqlite")
  for _ in {1..30}; do
    health=$(curl -fsS --max-time 1 "http://127.0.0.1:$port/health" 2>/dev/null || true)
    if node -e 'const h=JSON.parse(process.argv[1]);process.exit(h.ok===true&&h.version===process.argv[2]&&h.database_id===process.argv[3]&&h.operations_ready===true?0:1)' "$health" "$version" "$database_id" 2>/dev/null; then break; fi
    sleep 1
  done
  "$prefix/bin/project-orchestrator" doctor --json
fi

if [[ ${PROJECT_ORCHESTRATOR_SKIP_PLUGINS:-0} != 1 ]]; then
  plugin_id=project-orchestrator@project-orchestrator-local
  if [[ $clients = codex || $clients = both ]]; then
    if ! codex_markets=$(codex plugin marketplace list --json 2>/dev/null) || ! json_has_rows "$codex_markets" marketplaces; then die 'cannot refresh the Codex marketplace state'; fi
    if ! codex_plugins=$(codex plugin list --json 2>/dev/null) || ! json_has_rows "$codex_plugins" installed; then die 'cannot refresh the Codex plugin state'; fi
    codex_market_root=$(json_marketplace_root "$codex_markets" project-orchestrator-local)
    codex_plugin_version=$(json_installed_plugin_version "$codex_plugins" "$plugin_id")
    expected_market_root=$(readlink -f "$target/marketplaces/codex")
    if [[ -n $codex_market_root && $codex_market_root != "$expected_market_root" ]]; then
      plugins_changed=1
      [[ -z $codex_plugin_version ]] || codex plugin remove "$plugin_id" >/dev/null
      codex plugin marketplace remove project-orchestrator-local >/dev/null
      codex_markets='[]'
      codex_plugin_version=''
    fi
    if ! json_has_marketplace "$codex_markets" project-orchestrator-local; then plugins_changed=1; codex plugin marketplace add "$target/marketplaces/codex" >/dev/null; fi
    if [[ $codex_plugin_version != "$version" ]]; then plugins_changed=1; codex plugin add "$plugin_id" >/dev/null; fi
  fi
  if [[ $clients = claude || $clients = both ]]; then
    if ! claude_markets=$(claude plugin marketplace list --json 2>/dev/null) || ! json_has_rows "$claude_markets" marketplaces; then die 'cannot refresh the Claude marketplace state'; fi
    if ! claude_plugins=$(claude plugin list --json 2>/dev/null) || ! json_has_rows "$claude_plugins" installed; then die 'cannot refresh the Claude plugin state'; fi
    claude_market_root=$(json_marketplace_root "$claude_markets" project-orchestrator-local)
    claude_plugin_version=$(json_installed_plugin_version "$claude_plugins" "$plugin_id")
    expected_market_root=$(readlink -f "$target/marketplaces/claude")
    if [[ -n $claude_market_root && $claude_market_root != "$expected_market_root" ]]; then
      plugins_changed=1
      [[ -z $claude_plugin_version ]] || claude plugin uninstall "$plugin_id" --scope user >/dev/null
      claude plugin marketplace remove project-orchestrator-local --scope user >/dev/null
      claude_markets='[]'
      claude_plugin_version=''
    fi
    if ! json_has_marketplace "$claude_markets" project-orchestrator-local; then plugins_changed=1; claude plugin marketplace add "$target/marketplaces/claude" --scope user >/dev/null; fi
    if [[ -z $claude_plugin_version ]]; then
      plugins_changed=1
      claude plugin install "$plugin_id" --scope user >/dev/null
    elif [[ $claude_plugin_version != "$version" ]]; then
      plugins_changed=1
      claude plugin update "$plugin_id" --scope user >/dev/null
    fi
  fi
fi

committed=1
rm -rf "$rollback_state"
trap - ERR EXIT

printf 'Installed Project Orchestrator %s (%s).\n' "$version" "$service_mode"
printf 'Local listener: http://127.0.0.1:%s\n' "$port"
printf 'Browser URL: %s/bootstrap\n' "$origin"
printf 'First browser visit: create the local administrator account.\n'
