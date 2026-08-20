# Project Orchestrator

Local workflow orchestration for Codex and Claude, with a read-only Web console and an isolated operation helper.

## Install in a Linux Coder workspace

Requires Node.js 22+, pnpm, Codex CLI and Claude CLI. Build a release and run its installer:

```bash
git clone https://github.com/weifashi/project-orchestrator.git
cd project-orchestrator
pnpm install --frozen-lockfile
pnpm release
bash release/project-orchestrator-0.1.0/install.sh --both
```

The installer is idempotent. It creates private state under `~/.project-orchestrator`, immutable releases under `~/.local/share/project-orchestrator/releases`, command links under `~/.local/bin`, separate Codex/Claude adapter credentials, SQLite/CAS state, and the built-in workflow templates. It also registers both local plugin marketplaces.

In Coder, `VSCODE_PROXY_URI` is used to print the external HTTPS URL. The server itself always listens only on `127.0.0.1:3847`; only the exact names in `PROJECT_ORCHESTRATOR_ALLOWED_HOSTS` pass Host validation. Forwarded Host headers are not trusted.

For this workspace the expected URL is:

```text
https://3847--main--wfs--weifashi.coder.tbc.5ok.co/bootstrap
```

Read the bootstrap token without putting it in shell history or a URL:

```bash
cat ~/.project-orchestrator/runtime/web-token
```

## Operations

```bash
project-orchestrator doctor --json
project-orchestrator url
project-orchestrator version
```

The installer prefers `systemd --user`. When Coder has no user D-Bus but passwordless sudo is available, it installs system units named `project-orchestrator-$USER.service` and `project-orchestrator-$USER-operations.service`, both running as the current non-root user with `UMask=0077`. To install without starting services, pass `--no-start`.

Current Linux data paths:

```text
~/.project-orchestrator/orchestrator.sqlite
~/.project-orchestrator/objects/
~/.project-orchestrator/runtime/control.sock
~/.project-orchestrator/runtime/operations.sock
~/.project-orchestrator/runtime/{web-token,adapter-codex-credential,adapter-claude-credential}
```

Backups, upgrade/rollback automation, uninstall/purge, and macOS LaunchAgents remain follow-up release work. Do not delete `~/.project-orchestrator` when replacing a release.
