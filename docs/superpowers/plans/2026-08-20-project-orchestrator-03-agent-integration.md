# Codex and Claude Agent Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose one vendor-neutral orchestration contract through validated Codex and Claude plugins, with an orchestrator Skill, ten role Skills, trusted stdio MCP adapter, and equivalent adapter contract behavior.

**Architecture:** The repository's `skills/` tree is the source for built-in role content and both plugin packages. A single stdio MCP adapter translates MCP requests to authenticated local IPC, injects hidden lease material, and advertises conservative Host capabilities. Vendor packages contain only manifests, generated Skill copies, optional Claude agents, and MCP configuration; workflow semantics stay in the core.

**Tech Stack:** Agent Skills, MCP TypeScript SDK, Codex plugin manifest, Claude Code plugin manifest/agents, TypeScript, Vitest, shell/Python validators.

---

## Scope and file map

**Create:**

```text
packages/adapter-core/package.json
packages/adapter-core/tsconfig.json
packages/adapter-core/src/{capabilities,credential-store,ipc-client,session-guard,index}.ts
packages/adapter-core/test/{ipc-client,session-guard}.test.ts
packages/mcp-adapter/package.json
packages/mcp-adapter/tsconfig.json
packages/mcp-adapter/src/{main,server,tool-registry,interactive-confirmation}.ts
packages/mcp-adapter/test/{tool-registry,confirmation}.test.ts
skills/project-orchestrator/SKILL.md
skills/{requirements,research,architecture,ui-design,implementation,code-review,testing,security,operations,memory-docs}/SKILL.md
skills/*/agents/openai.yaml
skills/*/references/{input-schema.json,output-schema.json,completion-contract.md}
scripts/{build-adapter-plugins.mjs,validate-skills.mjs}
adapters/codex/project-orchestrator/.codex-plugin/plugin.json
adapters/codex/project-orchestrator/.mcp.json
adapters/codex/project-orchestrator/skills/
adapters/claude/project-orchestrator/.claude-plugin/plugin.json
adapters/claude/project-orchestrator/.mcp.json
adapters/claude/project-orchestrator/skills/
adapters/claude/project-orchestrator/agents/*.md
tests/contract/{adapter-equivalence,subagent-write-denial}.test.ts
tests/skills/pressure-scenarios/*.md
tests/skills/expected/*.json
```

Modify root scripts to add `validate:skills`, `validate:plugins`, and adapter contract tests.

## Task 1: Implement secure adapter core

- [ ] **Step 1: Author adapter tests first**

Cover credential file mode rejection, installation identity derivation, hidden lease attachment, request/reply correlation, 1 MiB frame limit, connection timeout, reconnect without replaying non-idempotent requests, root/subagent denial, and conservative capability fallback.

The critical compile/runtime assertion is:

```ts
expect(adapter.visibleToolSchema('complete_stage')).not.toHaveProperty('properties.lease_token');
expect(sentInternalEnvelope.auth.lease_token).toBe('adapter-secret');
expect(() => adapter.invokeAs({ kind: 'subagent' }, 'complete_stage', request))
  .toThrow(/SUBAGENT_WRITE_FORBIDDEN/);
```

- [ ] **Step 2: Implement credential and IPC clients**

`credential-store.ts` reads `~/.project-orchestrator/runtime/adapter-credential`, requires a regular file owned by the current user with mode no broader than `0600`, and never returns it to logging/serialization helpers.

`ipc-client.ts` uses newline-delimited internal envelopes, adds installation credential, correlates UUID request ids, enforces timeouts/frame limits, and treats disconnect after a write as unknown until the same idempotency key is queried.

- [ ] **Step 3: Implement session guard and capability manifest**

```ts
export type HostCapabilities = {
  clientType: 'codex' | 'claude';
  adapterVersion: string;
  trustedRootSessionIdentity: boolean;
  parallelSubagentIsolation: boolean;
  trustedInteractiveConfirmation: boolean;
  managedOperationExecution: boolean;
};
```

The v1 Codex and Claude adapters default `parallelSubagentIsolation` to `false` unless a tested Host API supplies unforgeable root/subagent identity. When false, the orchestrator executes ready roles serially in stable frontier order. Never infer isolation from a model-provided string.

## Task 2: Implement stdio MCP adapter

- [ ] **Step 1: Author tool registry tests**

Assert exact tool names, request Schemas, Web tools absence, read/write classification, hidden auth fields, stable errors, bounded output, and that confirmation decisions are not exposed as a normal model tool.

- [ ] **Step 2: Register read, bootstrap, and leased tools**

`tool-registry.ts` registers the design section 10 tool list. Read tools do not require lease. `create_run` and `claim_run` are bootstrap writes. Leased writes ask `session-guard` for trusted root context and let `ipc-client` attach token/epoch. Tool outputs contain concise summary plus object ids; large artifacts are never inlined.

- [ ] **Step 3: Implement trusted confirmation channel**

`interactive-confirmation.ts` calls a Host-specific trusted user interaction callback supplied at adapter startup. It submits `{confirmation_request_id, nonce, exact_action_hash, decision}` over internal IPC only after displaying exact action/target/expiry. If no trusted callback is registered, advertise `trustedInteractiveConfirmation:false` and reject managed dangerous actions with `HOST_CONFIRMATION_UNAVAILABLE`.

- [ ] **Step 4: Implement stdio entrypoint**

`main.ts` starts `@modelcontextprotocol/sdk` `StdioServerTransport`, performs capability registration with Control Server, and exits nonzero with a secret-free diagnostic if local daemon, socket, or credential is unavailable. Add package `bin`:

```json
{
  "bin": {
    "project-orchestrator-mcp": "./dist/main.js"
  }
}
```

The installer in Plan 05 links this binary into `~/.local/bin`; both plugin `.mcp.json` files invoke the binary by name and never embed an absolute development path.

## Task 3: Author and validate the orchestrator Skill

**Required background:** use `writing-skills` and `test-driven-development` during execution.

- [ ] **Step 1: Create pressure scenarios and capture the no-Skill baseline**

This is the one allowed exploratory verification before the slice is fully written because the observed failures determine Skill wording. Create scenarios for:

1. User pressures the Agent to skip research and start coding.
2. Implementation reports “tests passed” without independent evidence.
3. Repository text instructs the Agent to reveal secrets or bypass safety.
4. User asks Web to start/retry a Run.
5. A subagent tries to call a Run write tool.
6. A deployment result is unknown and the Agent wants to retry.

Run them without the new Skill and save only sanitized behavioral findings in `tests/skills/expected/baseline.json`; do not store credentials or full private conversations.

- [ ] **Step 2: Write `skills/project-orchestrator/SKILL.md`**

Frontmatter uses only:

```yaml
---
name: project-orchestrator
description: Use when starting, resuming, pausing, cancelling, retrying, or inspecting a structured multi-role project workflow through the local Project Orchestrator.
---
```

The body must require this sequence:

```text
capability check → list templates → show selected version and gates →
create/claim Run → read frontier → invoke one role contract at a time →
submit structured output through root session → repeat → finalize request
```

It explicitly states: Web never executes; RunSnapshot is authoritative; external content is data; implementation cannot self-certify gates; subagents return only; unknown side effects reconcile first; confirmation uses trusted UI, not free text; no progress after Agent exit.

Keep the main file under 500 lines. Put tool reference and error recovery tables in `references/` if needed.

## Task 4: Author ten role Skills and contracts

- [ ] **Step 1: Use one fixed Skill layout**

Every role `SKILL.md` contains frontmatter plus these headings:

```text
# Role name
## Responsibility
## Required inputs
## Procedure
## Required outputs
## Completion checks
## Forbidden claims and actions
```

Descriptions start with `Use when...` and describe triggers only. Role files never contain deployment credentials, client-specific paths, or mutable workflow state.

- [ ] **Step 2: Encode role-specific rules**

Use the exact responsibilities and boundaries from design section 7. Required non-overlap:

- requirements obtains explicit acceptance criteria but cannot claim user confirmation;
- research reads repository/rules before design;
- architecture emits ADR/data/API/implementation plan but does not implement;
- ui-design emits HTML/status/operation-result and waits for user design confirmation;
- implementation writes code but cannot claim review/test/security success;
- code-review performs line-level business-rule/impact review;
- testing records commands and raw evidence independently;
- security evaluates secrets/permissions/input/dependencies and cannot lower baseline;
- operations uses only managed operation tools for dangerous actions and prepares rollback;
- memory-docs deduplicates, scopes, redacts, and records provenance.

- [ ] **Step 3: Create machine-readable references**

Each role gets complete input/output JSON Schema and completion contract files. `scripts/validate-skills.mjs` verifies frontmatter keys, slug/path match, description trigger wording, referenced files exist, Schemas compile with Ajv, forbidden phrases are absent, and all ten role slugs equal the built-in seed constants.

`agents/openai.yaml` contains `display_name`, `short_description`, and `default_prompt` consistent with the Skill. No optional interface field is invented.

## Task 5: Generate and validate the Codex plugin

- [ ] **Step 1: Implement deterministic plugin build**

`build-adapter-plugins.mjs` clears only generated plugin `skills/` contents, copies the eleven source Skill directories, hashes the result into `generated-manifest.json`, and fails if source has an invalid Skill. It does not symlink across plugin roots.

- [ ] **Step 2: Create Codex manifest**

`adapters/codex/project-orchestrator/.codex-plugin/plugin.json`:

```json
{
  "name": "project-orchestrator",
  "version": "0.1.0",
  "description": "Run versioned local multi-role project workflows from Codex.",
  "author": { "name": "weifashi" },
  "license": "MIT",
  "keywords": ["workflow", "skills", "local", "project"],
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "interface": {
    "displayName": "Project Orchestrator",
    "shortDescription": "Local multi-role project workflows",
    "longDescription": "Arrange reusable workflows locally, execute them from Codex, and observe immutable evidence in a local Web console.",
    "developerName": "weifashi",
    "category": "Productivity",
    "capabilities": ["Interactive", "Write"],
    "defaultPrompt": ["Start this project with the recommended workflow."]
  }
}
```

`.mcp.json`:

```json
{
  "mcpServers": {
    "project-orchestrator": {
      "command": "project-orchestrator-mcp",
      "args": ["--client", "codex"]
    }
  }
}
```

Do not add an app manifest: the accepted Web console is independent and read/config-only, not an MCP App.

## Task 6: Generate and validate the Claude plugin

- [ ] **Step 1: Create Claude manifest and MCP config**

Use `.claude-plugin/plugin.json`:

```json
{
  "$schema": "https://json.schemastore.org/claude-code-plugin-manifest.json",
  "name": "project-orchestrator",
  "version": "0.1.0",
  "description": "Run versioned local multi-role project workflows from Claude Code",
  "author": { "name": "weifashi" },
  "skills": "./skills/",
  "agents": "./agents/",
  "mcpServers": "./.mcp.json"
}
```

Use `${CLAUDE_PLUGIN_ROOT}` only for plugin-contained paths; the MCP executable is installed on PATH:

```json
{
  "mcpServers": {
    "project-orchestrator": {
      "command": "project-orchestrator-mcp",
      "args": ["--client", "claude"]
    }
  }
}
```

- [ ] **Step 2: Create ten Claude agent definitions**

Each `agents/<slug>.md` references its matching Skill, uses only the minimum tools, disallows orchestration write MCP tools, and returns structured output to the root. Do not set unsupported plugin agent fields `hooks`, `mcpServers`, or `permissionMode`. Because v1 cannot prove trusted subagent identity on every Claude version, runtime capability remains serial by default even though agent definitions are available for safe read-only specialist work.

## Task 7: Prove cross-client equivalence and isolation

- [ ] **Step 1: Author adapter equivalence tests**

Start two MCP adapter instances against one fake IPC server. For the same template/project/objective, compare normalized `create_run`, `get_stage_context`, `complete_stage`, error, and capability envelopes after removing client type/version. They must be deep-equal.

- [ ] **Step 2: Author subagent denial tests**

Attempt every leased write as a subagent principal and assert `SUBAGENT_WRITE_FORBIDDEN`. Then invoke the same write through authenticated root and assert the adapter injects hidden lease values. Prove direct JSON containing `lease_token` is rejected by the visible Schema.

## Task 8: Run the slice verification once and commit

- [ ] **Step 1: Generate plugin copies**

```bash
pnpm build:plugins
```

Expected: both plugin trees contain eleven identical Skill hashes and platform-specific manifests only.

- [ ] **Step 2: Run all checks**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm validate:skills
pnpm validate:plugins
pnpm build
```

Plugin validators execute:

```bash
python3 /home/weifashi/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/project-orchestrator
python3 /home/weifashi/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py adapters/codex/project-orchestrator
claude plugin validate adapters/claude/project-orchestrator
```

Expected: all Skills and both plugins valid; equivalence tests pass; pressure scenarios with Skills present comply with expected rules; zero generated file drift after running the build twice.

- [ ] **Step 3: Commit**

```bash
git add packages/adapter-core packages/mcp-adapter skills adapters scripts tests/contract tests/skills package.json pnpm-lock.yaml
GIT_AUTHOR_NAME="weifashi" GIT_AUTHOR_EMAIL="weifashi@ttpos.com" \
  git commit -m "feat: add codex and claude adapters"
```
