# Distribution, Autostart, Security, and Release Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the orchestrator for local Linux/macOS installation, start services after user login, install validated Codex/Claude plugins, preserve/backup local data, and prove the complete product through security and end-to-end release checks.

**Architecture:** A platform-neutral release directory contains compiled Node applications, static Web assets, plugins, migrations, and idempotent install/uninstall scripts. Linux uses systemd user units; macOS uses LaunchAgents. Data and credentials live outside the release directory, so upgrades are atomic and rollbacks preserve SQLite/CAS state.

**Tech Stack:** Node.js 22, pnpm deploy, shell, systemd user services, launchd LaunchAgents, SQLite backup API, Vitest, Playwright, Codex/Claude plugin validators.

---

## Scope and file map

**Create:**

```text
apps/control-server/src/cli/{backup,doctor,migrate,rotate-web-token}.ts
scripts/{build-release.mjs,install.sh,uninstall.sh,doctor.sh}
distribution/codex-marketplace/marketplace.json
distribution/claude-marketplace/.claude-plugin/marketplace.json
installer/linux/{project-orchestratord.service,project-orchestrator-operations.service,project-orchestrator-backup.service,project-orchestrator-backup.timer}
installer/macos/{cn.ttpos.project-orchestratord.plist,cn.ttpos.project-orchestrator-operations.plist}
tests/install/{linux-smoke.sh,macos-static-smoke.sh,upgrade-smoke.sh,uninstall-smoke.sh}
tests/security/{auth-boundary,artifact-ingest,prompt-injection,secret-redaction,side-effect-fencing}.test.ts
tests/e2e/{codex-simulated-run,claude-simulated-run,interrupt-recover,iteration-limit}.spec.ts
docs/operations/{install,backup-restore,upgrade-rollback,troubleshooting,release-checklist}.md
CHANGELOG.md
LICENSE
```

Modify root scripts to add release, install-smoke, security, backup, and doctor commands.

## Task 1: Build reproducible local release artifacts

- [ ] **Step 1: Author release-layout tests first**

Given a built release directory, assert it contains compiled control server, MCP adapter binary, operation helper, Web assets, migrations, both plugins, licenses, and a dependency inventory. Assert it excludes source maps in production, test fixtures, `.env`, developer credentials, Git metadata, and absolute workspace paths.

- [ ] **Step 2: Implement `build-release.mjs`**

The script requires a clean lockfile install, builds all packages/apps/Web/plugins, uses `pnpm deploy --prod` for runtime dependencies, and creates:

```text
release/project-orchestrator-<version>/
├─ app/
├─ bin/{project-orchestratord,project-orchestrator-mcp,project-orchestrator-operations,project-orchestrator}
├─ web/
├─ migrations/
├─ plugins/{codex,claude}/project-orchestrator/
├─ marketplaces/{codex,claude}/
├─ installer/{linux,macos}/
├─ LICENSE
├─ THIRD_PARTY_NOTICES.json
└─ manifest.sha256
```

Wrappers resolve their own release path, require Node >=22, set no secret environment variables, and use `exec node <entrypoint>`. The manifest hashes every regular file except itself in sorted path order.

- [ ] **Step 3: Create local marketplace metadata**

Codex marketplace entry uses local source `./plugins/project-orchestrator`, availability `AVAILABLE`, authentication `ON_INSTALL`, and category `Productivity`. Claude marketplace has name `project-orchestrator-local`, owner `weifashi`, and source `./plugins/project-orchestrator`. Marketplace files never reference a network URL.

## Task 2: Implement secure, idempotent installation

- [ ] **Step 1: Author installer fixture tests**

Install twice into a temporary fake HOME and assert no duplicate units/marketplace entries, old release remains available for rollback, current symlink changes atomically, data persists, directories/files have `0700/0600`, and no listener binds beyond loopback.

- [ ] **Step 2: Implement `scripts/install.sh`**

The installer:

1. validates platform `linux` or `darwin`, Node >=22, release manifest, and required Codex/Claude CLI presence only when the corresponding plugin flag is selected;
2. copies release to `~/.local/share/project-orchestrator/releases/<version>`;
3. atomically points `current` to that release;
4. links wrappers into `~/.local/bin`;
5. creates `~/.project-orchestrator/{backups,logs,objects,runtime}` with `0700`;
6. creates web and adapter secrets from 32 random bytes with `0600`, never overwriting existing valid secrets;
7. runs database migration and built-in seed;
8. installs the selected platform services;
9. registers the local Codex/Claude marketplaces and prints exact plugin enable/install commands;
10. starts services and runs `project-orchestrator doctor`.

Supported flags are `--codex`, `--claude`, `--both`, `--no-start`, and `--prefix <absolute-path>`. Default is `--both`. Reject relative prefix and unknown flags.

The registered marketplace name is `project-orchestrator-local`. Installer commands are:

```bash
codex plugin marketplace add "$HOME/.local/share/project-orchestrator/current/marketplaces/codex"
codex plugin install project-orchestrator@project-orchestrator-local
claude plugin marketplace add "$HOME/.local/share/project-orchestrator/current/marketplaces/claude"
claude plugin install project-orchestrator@project-orchestrator-local --scope user
```

- [ ] **Step 3: Implement safe uninstall**

`uninstall.sh` stops/removes service definitions, plugin registrations, wrappers, and current release link. It preserves `~/.project-orchestrator` and backups by default. Only explicit `--purge-data --i-understand-data-will-be-deleted` removes data after creating a final backup and showing the path.

## Task 3: Implement Linux user-login autostart

- [ ] **Step 1: Create operation helper unit**

`project-orchestrator-operations.service` uses the installed operation binary, restart-on-failure, `UMask=0077`, `NoNewPrivileges=true`, `PrivateTmp=true`, a dedicated credential EnvironmentFile readable only by the user, and write access only to the operation socket/log location. It starts after `default.target` and never exposes TCP.

- [ ] **Step 2: Create Control Server unit**

Use:

```ini
[Unit]
Description=Local Project Orchestrator
After=project-orchestrator-operations.service
Requires=project-orchestrator-operations.service

[Service]
Type=simple
ExecStart=%h/.local/bin/project-orchestratord
Restart=on-failure
RestartSec=2
StartLimitIntervalSec=60
StartLimitBurst=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
```

The application itself binds Web to `127.0.0.1` and Agent transport to Unix socket. The installer runs `systemctl --user daemon-reload` and enables both units for login, not OS kernel boot.

- [ ] **Step 3: Add backup timer**

Daily user timer calls `project-orchestrator backup`; backup service refuses to run during migration, uses SQLite online backup, verifies the copied DB, retains configured `3..50` files with default `10`, and never deletes the only valid backup.

## Task 4: Implement macOS LaunchAgents

- [ ] **Step 1: Create operation helper plist**

Label `cn.ttpos.project-orchestrator-operations`, `RunAtLoad=true`, `KeepAlive` on unsuccessful exit, program under `~/.local/bin`, stdout/stderr under local logs, and `Umask=63` (`0077`). It uses only a local Unix socket.

- [ ] **Step 2: Create Control Server plist**

Label `cn.ttpos.project-orchestratord`, same login lifecycle and log policy, with throttling to avoid crash loops. Installer expands real absolute user paths into the installed plist, validates with `plutil -lint`, uses `launchctl bootstrap gui/$UID`, and uses `kickstart` only after bootstrap.

- [ ] **Step 3: Implement static macOS smoke on Linux and real smoke on macOS**

Linux CI parses plist XML, verifies labels/path/RunAtLoad/KeepAlive/Umask and rejects network wildcard. A macOS runner additionally bootstraps, checks process/socket/Web endpoint, logs out/in or simulates bootstrap lifecycle, and uninstalls cleanly.

## Task 5: Implement backup, migration, doctor, and rollback commands

- [ ] **Step 1: Author command tests**

Cover healthy/corrupt DB, missing CAS object, unsafe permissions, stale PID/socket, incompatible adapter, migration checksum drift, failed migration restoration, backup retention boundaries, Web wildcard bind, and secret appearing in logs.

- [ ] **Step 2: Implement CLI commands**

```text
project-orchestrator doctor [--json]
project-orchestrator backup
project-orchestrator migrate
project-orchestrator rotate-web-token
project-orchestrator version
```

`doctor --json` reports booleans/codes and non-secret paths only. `migrate` takes a verified backup first and restores it on transaction failure. Token rotation invalidates existing Web sessions and never prints the new token.

- [ ] **Step 3: Implement atomic upgrade/rollback**

Upgrade installs a new immutable release, verifies manifest and DB compatibility, migrates, flips `current`, restarts, and runs doctor. On application-start failure before an irreversible migration, flip back. If schema is incompatible with old code, restore the migration backup and then flip back. Document exact decision table in `docs/operations/upgrade-rollback.md`.

## Task 6: Complete security tests

- [ ] **Step 1: Authentication and transport suite**

Prove loopback-only Web, `0600` socket/secret files, Web/Agent credential separation, Host/Origin/CSRF checks, default deny, subagent denial, expired/stale leases, recovery credential rotation, and server-epoch fencing.

- [ ] **Step 2: Content and prompt suite**

Test traversal, symlink/hardlink races, oversized artifacts, hash tampering, stored HTML/SVG, event/log injection, prompt injection in repository/web/memory content, and redaction of token/password/API-key patterns. Active content must download or render only in credential-free sandbox origin.

- [ ] **Step 3: Managed operation suite**

Prove exact action hash, one-time nonce, expiry, wrong target, replay, helper-only driver registry, sanitized environment, bounded output, crash-to-unknown, reconcile-before-retry, and absence of production credentials in root/control/Web process environments.

## Task 7: Complete cross-client end-to-end tests

- [ ] **Step 1: Simulated Codex and Claude Runs**

Run both adapters against one temporary daemon with identical objective/template/project. Complete a full new-project flow with architecture/UI active set, delivery gates, operations fixture, and memory. Compare normalized snapshots/events/artifacts except client identity/version fields.

- [ ] **Step 2: Interruption and bounded iteration**

Interrupt after an Attempt progress checkpoint, change worktree, verify silent resume is rejected, restore/fork as directed, then complete. Separately fail review/test/security for three delivery rounds and prove no fourth iteration is created.

- [ ] **Step 3: Real client smoke**

On a machine with authenticated clients:

1. Install local marketplace/plugin for Codex; open a new Codex session in a fixture repo; ask “列出适用流程但不要创建 Run”; verify MCP read tool works and Web remains empty.
2. Ask Codex “按 Bug 修复流程开始”; verify one Run appears and can be cancelled only from the session.
3. Install/load Claude plugin; repeat the read-only listing and create a Bug Run; verify equivalent snapshot shape.
4. Close each Agent during running; verify daemon records interrupted and does not advance until the same client installation recovers.

Save sanitized command/version/result evidence under `release-evidence/<version>/`; never save full chat or secrets.

## Task 8: Final release verification and documentation

- [ ] **Step 1: Write operator docs**

Document install, local URL discovery, plugin enablement, backups, restore, upgrade, rollback, troubleshooting, data paths, permission model, and v1 exclusions. Do not promise absolute control over an independently credentialed user shell; scope managed-action guarantees to the controlled executor and valid Run results.

- [ ] **Step 2: Run the full repository matrix once**

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:security
pnpm test:e2e
pnpm build
pnpm validate:skills
pnpm validate:plugins
bash tests/install/linux-smoke.sh
bash tests/install/macos-static-smoke.sh
bash tests/install/upgrade-smoke.sh
bash tests/install/uninstall-smoke.sh
```

Expected: all exit `0`, no skipped mandatory security test, no external network request, and no dirty generated plugin tree.

- [ ] **Step 3: Build and inspect release**

```bash
pnpm release
sha256sum -c release/project-orchestrator-*/manifest.sha256
git diff --check
git status --short
```

Expected: hashes verify, status contains only intentional release evidence excluded by `.gitignore`, and dependency inventory contains no third-party orchestration SaaS/engine.

- [ ] **Step 4: Map acceptance evidence**

In `docs/operations/release-checklist.md`, make a 16-row table matching design section 17. Every row contains the exact automated test or real-client/manual smoke evidence path and pass date; no row uses “not applicable.”

- [ ] **Step 5: Commit the verified release slice**

```bash
git add apps/control-server scripts distribution installer tests docs/operations CHANGELOG.md LICENSE package.json pnpm-lock.yaml
GIT_AUTHOR_NAME="weifashi" GIT_AUTHOR_EMAIL="weifashi@ttpos.com" \
  git commit -m "feat: package and verify local orchestrator"
```

Expected: fifth implementation commit completes the release candidate; `git status --short` is empty after excluding generated archives/evidence.
