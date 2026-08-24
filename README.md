# Project Orchestrator

Local workflow orchestration for Codex and Claude, with a read-only Web console and an isolated operation helper.

## Install in a Linux Coder workspace

Requires Node.js 22+, pnpm, Codex CLI and Claude CLI. Build a release and run its installer:

```bash
git clone https://github.com/weifashi/project-orchestrator.git
cd project-orchestrator
pnpm install --frozen-lockfile
pnpm release
bash release/project-orchestrator-0.1.32/install.sh --both
```

The installer is idempotent. It creates private state under `~/.project-orchestrator`, immutable releases under `~/.local/share/project-orchestrator/releases`, command links under `~/.local/bin`, separate Codex/Claude adapter credentials, SQLite/CAS state, and the built-in workflow templates. It also registers both local plugin marketplaces.

In Coder, `VSCODE_PROXY_URI` is used to print the external HTTPS URL. Public hosts always require a local account. The installer binds `0.0.0.0:3847` for the private network by default; direct private-network and loopback access can edit and observe without a login, while the configured public hosts still require a session. Set `PROJECT_ORCHESTRATOR_LAN_ACCESS=0` when installing to keep loopback-only listening. Forwarded Host headers are not trusted.

For this workspace the expected URL is:

```text
https://3847--main--wfs--weifashi.coder.tbc.5ok.co/bootstrap
```

首次访问 `/bootstrap` 时创建本机管理员账号；以后使用账号和密码登录。公开注册会在第一个账号创建后自动关闭，Web token 不再用于登录。

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
~/.project-orchestrator/runtime/{web-session-secret,adapter-codex-credential,adapter-claude-credential}
```

Backups, upgrade/rollback automation, uninstall/purge, and macOS LaunchAgents remain follow-up release work. Do not delete `~/.project-orchestrator` when replacing a release.

## 画布编排与运行观察

- 在「流程模板」进入画布优先编辑器：首次打开会自动把节点定位到视野中央；没有节点时，画布中央直接提供「添加节点」。空白处拖动平移，滚轮缩放，右下角小地图定位；`F` 适应画布，`Ctrl/Cmd+S` 保存草稿，`Ctrl/Cmd+Z` 撤销，`Esc` 取消选择。
- 点击「添加节点」可搜索本机角色，也可以把角色卡拖入画布；从节点端口拖线建立前后依赖。节点设置和角色市场均以浮层打开，不会压缩画布。
- 节点分组和折叠仅改变展示，不改变阶段、边或运行规则。强制安全门和受保护依赖不能删除或绕过。
- 「任务记录」复用同一画布导航，但只能查看冻结流程、状态和证据；网页没有开始、暂停、重试、确认或部署功能。
