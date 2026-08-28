#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
tmp=$(mktemp -d)
trap 'chmod -R u+w "$tmp" 2>/dev/null || true; rm -rf "$tmp"' EXIT

release="$tmp/project-orchestrator-0.1.1"
mkdir -p "$release/bin" "$release/app/control/dist" "$release/installer/linux" "$release/marketplaces/codex" "$release/marketplaces/claude"
printf '0.1.1\n' > "$release/VERSION"
cat > "$release/bin/project-orchestrator" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  backup)
    shift
    [[ ${1:-} = --output && -n ${2:-} ]]
    if [[ ${PROJECT_ORCHESTRATOR_TEST_BACKUP_EXIT:-0} = 1 ]]; then exit 42; fi
    if [[ ${PROJECT_ORCHESTRATOR_TEST_BACKUP_CORRUPT:-0} = 1 ]]; then printf 'corrupt\n' > "$2"; else cp "$PROJECT_ORCHESTRATOR_DB" "$2"; fi ;;
  verify-database)
    shift
    [[ ${1:-} = --path && -s ${2:-} ]]
    ! grep -qx corrupt "$2" ;;
  initialize)
    if [[ ${PROJECT_ORCHESTRATOR_TEST_MUTATE:-0} = 1 ]]; then printf 'mutated\n' > "$PROJECT_ORCHESTRATOR_DB"; fi ;;
esac
EOF
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
grep -q 'PROJECT_ORCHESTRATOR_VERSION_FILE=.*/current/VERSION' "$home/.project-orchestrator/runtime/service.env"
grep -q 'UMask=0077' "$home/.config/systemd/user/project-orchestratord.service"
grep -q 'project-orchestrator-operations.service' "$home/.config/systemd/user/project-orchestratord.service"
grep -q 'project-orchestrator operations-ready' "$home/.config/systemd/user/project-orchestratord.service"
service_line=$(grep -n '^\[Service\]$' "$home/.config/systemd/user/project-orchestratord.service" | cut -d: -f1)
limit_line=$(grep -n '^StartLimitIntervalSec=' "$home/.config/systemd/user/project-orchestratord.service" | cut -d: -f1)
((limit_line < service_line))
test "$(find "$home/.local/share/project-orchestrator/releases" -mindepth 1 -maxdepth 1 -type d | wc -l)" = 1

# An installed release directory is immutable. A corrupt same-version target must
# be rejected instead of being replaced while current may still point at it.
installed="$home/.local/share/project-orchestrator/releases/0.1.1"
chmod u+w "$installed/bin"
rm "$installed/bin/project-orchestrator"
if HOME="$home" PROJECT_ORCHESTRATOR_SKIP_MANIFEST=1 PROJECT_ORCHESTRATOR_SKIP_PLUGINS=1 \
  bash "$release/install.sh" --both --no-start --prefix "$home/.local" >/dev/null 2>&1; then
  echo 'corrupt same-version release was replaced in place' >&2; exit 1
fi
cp "$release/bin/project-orchestrator" "$installed/bin/project-orchestrator"
chmod +x "$installed/bin/project-orchestrator"

# Two self-consistent artifacts may not publish different contents under the
# same version. The existing immutable target and current link must stay intact.
write_manifest() {
  local directory=$1
  printf '{}\n' > "$directory/symlinks.json"
  (cd "$directory" && find . -type f ! -name manifest.sha256 -print0 | sort -z | xargs -0 sha256sum > manifest.sha256)
}
versioned_release="$tmp/versioned-project-orchestrator-0.1.9"
cp -a "$release" "$versioned_release"
chmod -R u+w "$versioned_release"
printf '0.1.9\n' > "$versioned_release/VERSION"
write_manifest "$versioned_release"
versioned_home="$tmp/versioned-home"
mkdir -p "$versioned_home"
HOME="$versioned_home" PROJECT_ORCHESTRATOR_SKIP_PLUGINS=1 \
  bash "$versioned_release/install.sh" --both --no-start --prefix "$versioned_home/.local" >/dev/null
versioned_target="$versioned_home/.local/share/project-orchestrator/releases/0.1.9"
versioned_before=$(sha256sum "$versioned_target/bin/project-orchestrator" | cut -d' ' -f1)
chmod u+w "$versioned_release/bin/project-orchestrator"
printf '# different build\n' >> "$versioned_release/bin/project-orchestrator"
write_manifest "$versioned_release"
if HOME="$versioned_home" PROJECT_ORCHESTRATOR_SKIP_PLUGINS=1 \
  bash "$versioned_release/install.sh" --both --no-start --prefix "$versioned_home/.local" >/dev/null 2>&1; then
  echo 'different same-version artifact unexpectedly replaced the installed release' >&2; exit 1
fi
test "$(sha256sum "$versioned_target/bin/project-orchestrator" | cut -d' ' -f1)" = "$versioned_before"
test "$(readlink -f "$versioned_home/.local/share/project-orchestrator/current")" = "$versioned_target"
test -z "$(find "$versioned_home/.local/share/project-orchestrator/releases" -maxdepth 1 -type d \( -name '.install-*' -o -name '.broken-*' \))"

# A failure after backup and initialize must restore the previous current target,
# database, generated environment, and unit files instead of leaving a mixed install.
printf 'original-database\n' > "$home/.project-orchestrator/orchestrator.sqlite"
before_env=$(sha256sum "$home/.project-orchestrator/runtime/service.env" | cut -d' ' -f1)
before_unit=$(sha256sum "$home/.config/systemd/user/project-orchestratord.service" | cut -d' ' -f1)
before_database=$(sha256sum "$home/.project-orchestrator/orchestrator.sqlite" | cut -d' ' -f1)
before_database_inode=$(stat -c %i "$home/.project-orchestrator/orchestrator.sqlite")
upgrade_release="$tmp/project-orchestrator-0.1.2"
cp -a "$release" "$upgrade_release"
chmod -R u+w "$upgrade_release"
printf '0.1.2\n' > "$upgrade_release/VERSION"

assert_backup_failure_unchanged() {
  test "$(readlink -f "$home/.local/share/project-orchestrator/current")" = "$installed"
  test "$(sha256sum "$home/.project-orchestrator/orchestrator.sqlite" | cut -d' ' -f1)" = "$before_database"
  test "$(stat -c %i "$home/.project-orchestrator/orchestrator.sqlite")" = "$before_database_inode"
  test ! -e "$home/.local/share/project-orchestrator/releases/0.1.2"
}

# Backup preparation failures happen before any data mutation. The live database
# must keep both its content and inode, proving rollback did not replace/delete it.
backup_cp_bin="$tmp/backup-cp-bin"
mkdir -p "$backup_cp_bin"
cat > "$backup_cp_bin/cp" <<EOF
#!/usr/bin/env bash
for argument in "\$@"; do
  if [[ \$argument = '$home/.project-orchestrator/objects' ]]; then exit 42; fi
done
exec $(command -v cp) "\$@"
EOF
chmod +x "$backup_cp_bin/cp"
if HOME="$home" PATH="$backup_cp_bin:$PATH" PROJECT_ORCHESTRATOR_SKIP_MANIFEST=1 PROJECT_ORCHESTRATOR_SKIP_PLUGINS=1 \
  bash "$upgrade_release/install.sh" --both --no-start --prefix "$home/.local" >/dev/null 2>&1; then
  echo 'objects backup failure injection unexpectedly succeeded' >&2; exit 1
fi
assert_backup_failure_unchanged
for failure in EXIT CORRUPT; do
  variable=PROJECT_ORCHESTRATOR_TEST_BACKUP_$failure
  if env HOME="$home" PROJECT_ORCHESTRATOR_SKIP_MANIFEST=1 PROJECT_ORCHESTRATOR_SKIP_PLUGINS=1 "$variable=1" \
    bash "$upgrade_release/install.sh" --both --no-start --prefix "$home/.local" >/dev/null 2>&1; then
    echo "backup $failure failure injection unexpectedly succeeded" >&2; exit 1
  fi
  assert_backup_failure_unchanged
done

assert_plugin_rollback() {
  local client=$1
  local failure_bin="$tmp/failure-$client-bin"
  local failure_market="$tmp/failure-$client-market"
  local failure_plugin="$tmp/failure-$client-plugin"
  local failure_once="$tmp/failure-$client-once"
  local failure_log="$tmp/failure-$client.log"
  mkdir -p "$failure_bin"
  printf '/old/%s-marketplace\n' "$client" > "$failure_market"
  printf '0.1.0\n' > "$failure_plugin"
  : > "$failure_once"
  cat > "$failure_bin/$client" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> '$failure_log'
case "\$*" in
  'plugin marketplace list --json')
    if [[ -s '$failure_market' ]]; then
      if [[ '$client' = codex ]]; then printf '{"marketplaces":[{"name":"project-orchestrator-local","root":"%s"}]}\n' "\$(cat '$failure_market')"
      else printf '[{"name":"project-orchestrator-local","root":"%s"}]\n' "\$(cat '$failure_market')"; fi
    else printf '[]\n'; fi ;;
  'plugin list --json')
    if [[ -s '$failure_plugin' ]]; then
      if [[ '$client' = codex ]]; then printf '{"installed":[{"pluginId":"project-orchestrator@project-orchestrator-local","version":"%s"}]}\n' "\$(cat '$failure_plugin')"
      else printf '[{"id":"project-orchestrator@project-orchestrator-local","version":"%s"}]\n' "\$(cat '$failure_plugin')"; fi
    else printf '[]\n'; fi ;;
  'plugin remove '*|'plugin uninstall '*) rm -f '$failure_plugin' ;;
  'plugin marketplace remove '*) rm -f '$failure_market' ;;
  'plugin marketplace add '*) printf '%s\n' "\${4:-}" > '$failure_market' ;;
  'plugin add '*|'plugin install '*)
    if [[ -e '$failure_once' ]]; then rm -f '$failure_once'; exit 42; fi
    printf '0.1.0\n' > '$failure_plugin' ;;
esac
EOF
  chmod +x "$failure_bin/$client"
  if HOME="$home" PATH="$failure_bin:/usr/bin:/bin" PROJECT_ORCHESTRATOR_PORT=7788 PROJECT_ORCHESTRATOR_TEST_MUTATE=1 \
    PROJECT_ORCHESTRATOR_SKIP_MANIFEST=1 bash "$upgrade_release/install.sh" "--$client" --no-start --prefix "$home/.local" >/dev/null 2>&1; then
    echo "$client plugin failure injection unexpectedly succeeded" >&2; exit 1
  fi
  test "$(readlink -f "$home/.local/share/project-orchestrator/current")" = "$installed"
  test "$(cat "$home/.project-orchestrator/orchestrator.sqlite")" = original-database
  test "$(sha256sum "$home/.project-orchestrator/runtime/service.env" | cut -d' ' -f1)" = "$before_env"
  test "$(sha256sum "$home/.config/systemd/user/project-orchestratord.service" | cut -d' ' -f1)" = "$before_unit"
  test ! -e "$home/.local/share/project-orchestrator/releases/0.1.2"
  test "$(cat "$failure_market")" = "/old/$client-marketplace"
  test "$(cat "$failure_plugin")" = 0.1.0
  grep -q '^plugin marketplace remove project-orchestrator-local' "$failure_log"
}
assert_plugin_rollback codex
assert_plugin_rollback claude

# If the client cannot report its existing plugin state, installation must stop
# before changing the release, database, or client registrations.
list_failure_bin="$tmp/list-failure-bin"
mkdir -p "$list_failure_bin"
cat > "$list_failure_bin/codex" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  'plugin marketplace list --json') exit 55 ;;
  *) printf '[]\n' ;;
esac
EOF
chmod +x "$list_failure_bin/codex"
preflight_database=$(sha256sum "$home/.project-orchestrator/orchestrator.sqlite" | cut -d' ' -f1)
preflight_database_inode=$(stat -c %i "$home/.project-orchestrator/orchestrator.sqlite")
if HOME="$home" PATH="$list_failure_bin:/usr/bin:/bin" PROJECT_ORCHESTRATOR_SKIP_MANIFEST=1 \
  bash "$upgrade_release/install.sh" --codex --no-start --prefix "$home/.local" >/dev/null 2>&1; then
  echo 'unreadable plugin preflight state unexpectedly continued' >&2; exit 1
fi
test "$(readlink -f "$home/.local/share/project-orchestrator/current")" = "$installed"
test "$(sha256sum "$home/.project-orchestrator/orchestrator.sqlite" | cut -d' ' -f1)" = "$preflight_database"
test "$(stat -c %i "$home/.project-orchestrator/orchestrator.sqlite")" = "$preflight_database_inode"
test ! -e "$home/.local/share/project-orchestrator/releases/0.1.2"

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

# Relative data input is normalized once so installer and runtime derive the
# same database identity regardless of their later working directory.
relative_home="$tmp/relative-home"
mkdir -p "$relative_home"
(cd "$tmp" && HOME="$relative_home" PROJECT_ORCHESTRATOR_DATA=relative-data PROJECT_ORCHESTRATOR_SKIP_MANIFEST=1 PROJECT_ORCHESTRATOR_SKIP_PLUGINS=1 \
  bash "$release/install.sh" --both --no-start --prefix "$relative_home/.local" >/dev/null)
grep -q "^PROJECT_ORCHESTRATOR_DATA=$tmp/relative-data$" "$tmp/relative-data/runtime/service.env"
grep -q "^PROJECT_ORCHESTRATOR_DB=$tmp/relative-data/orchestrator.sqlite$" "$tmp/relative-data/runtime/service.env"

if HOME="$home" bash "$release/install.sh" --prefix relative --no-start 2>/dev/null; then
  echo 'relative prefix unexpectedly accepted' >&2
  exit 1
fi

echo 'linux install smoke passed'
