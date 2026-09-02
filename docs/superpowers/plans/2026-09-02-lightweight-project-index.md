# Lightweight Project Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and freeze a lightweight, queryable source index when a new Run first enters Research.

**Architecture:** A deterministic indexer reads only safe Git-tracked files and reuses unchanged records from the latest CAS envelope. `RunService` triggers a best-effort `ProjectIndexService` after the Research attempt transaction, while a new leased query tool returns bounded pages from the Run's immutable index binding.

**Tech Stack:** TypeScript, Node.js built-ins, better-sqlite3, existing CAS, TypeBox contracts, Vitest, pnpm.

---

## File map

- `packages/sqlite-store/migrations/005_project_index.sql` — immutable index and Run-binding tables.
- `packages/sqlite-store/test/project-index-migration.test.ts` — migration ownership and immutability coverage.
- `packages/orchestrator-service/src/project-indexer.ts` — safe Git enumeration, hashing, language extraction, incremental reuse.
- `packages/orchestrator-service/src/project-index-service.ts` — CAS persistence, Run binding, and bounded query projection.
- `packages/orchestrator-service/src/run-service.ts` — Research-entry trigger and leased query facade.
- `packages/orchestrator-service/src/index.ts` — exports for the new service contract.
- `packages/orchestrator-service/test/project-indexer.test.ts` — structural extraction, reuse, and filtering coverage.
- `packages/orchestrator-service/test/project-index-service.test.ts` — persistence, freezing, fallback, and query coverage.
- `packages/orchestrator-service/test/project-index-run.test.ts` — Research versus non-Research trigger behavior.
- `packages/contracts/src/tool-contracts.ts` — model-visible query request schema.
- `packages/contracts/src/internal-ipc.ts` — leased internal query envelope.
- `packages/mcp-adapter/src/tool-registry.ts` — query tool description and registration.
- `apps/control-server/src/ipc/control-dispatcher.ts` — server-owned query dispatch.
- `packages/mcp-adapter/test/tool-registry.test.ts` — exact visible-tool boundary.
- `tests/integration/control-dispatcher.integration.test.ts` — dispatch parity for the added tool.
- `skills/research/SKILL.md` — query-first, source-verification, and fallback instructions.

### Task 1: Add immutable persistence

**Files:**
- Create: `packages/sqlite-store/migrations/005_project_index.sql`
- Create: `packages/sqlite-store/test/project-index-migration.test.ts`

- [ ] Write a migration test that expects `project_indexes` and `run_project_indexes`, unique project/tree reuse, cross-project ownership rejection, stage/attempt ownership rejection, and immutable update/delete behavior.
- [ ] Run the focused test and confirm it fails because migration 005 and its tables do not exist.
- [ ] Add the two tables, indexes, ownership triggers, and immutable triggers with only the columns approved in the design.
- [ ] Keep foreign-key deletion restrictive so CAS and historical Run evidence cannot be silently removed.

### Task 2: Build the deterministic indexer

**Files:**
- Create: `packages/orchestrator-service/test/project-indexer.test.ts`
- Create: `packages/orchestrator-service/src/project-indexer.ts`

- [ ] Write tests using temporary real Git repositories for tracked-only enumeration, TypeScript/JavaScript, Go, Dart, and Python extraction, line anchors, and metadata-only fallback.
- [ ] Write tests proving untracked, symlink, sensitive, binary, oversized, dependency, and generated files are omitted with the correct skipped counters.
- [ ] Write a test that supplies a previous envelope, changes one file, and expects unchanged record reuse plus added/changed/deleted path accounting.
- [ ] Run the focused tests and confirm the missing indexer fails them.
- [ ] Implement shell-free bounded Git commands, canonical path checks, hashing, limits, language detection, heuristic extractors, deterministic sorting, tree fingerprinting, and previous-record reuse.
- [ ] Keep full source bodies and declaration text out of the returned envelope.

### Task 3: Persist, freeze, and query indexes

**Files:**
- Create: `packages/orchestrator-service/test/project-index-service.test.ts`
- Create: `packages/orchestrator-service/src/project-index-service.ts`
- Modify: `packages/orchestrator-service/src/index.ts`

- [ ] Write tests that seed projects and Runs, ensure an index, verify CAS integrity, and bind the exact Research attempt.
- [ ] Write tests that reuse the same project/tree index across new Runs while preserving different Run bindings.
- [ ] Write a test that changes the repository after binding and proves the existing Run still reads its original object.
- [ ] Write query tests for substring matching across path/import/symbol, language filtering, pagination, response-size bounding, and unavailable status.
- [ ] Run the focused tests and confirm the missing service fails them.
- [ ] Implement persistence and query projection using canonical CAS envelopes and short SQLite transactions after scanning.
- [ ] Convert expected Git/index availability failures to an unavailable status while allowing policy, ownership, and path mismatches to fail closed.

### Task 4: Trigger indexing at Research entry

**Files:**
- Create: `packages/orchestrator-service/test/project-index-run.test.ts`
- Modify: `packages/orchestrator-service/src/run-service.ts`

- [ ] Write a RunService test where a frozen role slug is `research` and beginning its ready stage creates one binding.
- [ ] Write a test where a stage key says `research` but its frozen role slug is not `research`; expect no binding.
- [ ] Write a test where indexing fails; expect the attempt to remain running and no binding to exist.
- [ ] Run the focused test and confirm no automatic binding exists yet.
- [ ] Refactor `beginStage` to finish its existing leased transition first, then invoke best-effort indexing only when the frozen role slug is `research`.
- [ ] Add a leased `queryProjectIndex` facade that scopes every query by the authenticated Run and existing lease.

### Task 5: Expose the bounded query tool

**Files:**
- Modify: `packages/contracts/src/tool-contracts.ts`
- Modify: `packages/contracts/src/internal-ipc.ts`
- Modify: `packages/mcp-adapter/src/tool-registry.ts`
- Modify: `packages/mcp-adapter/test/tool-registry.test.ts`
- Modify: `apps/control-server/src/ipc/control-dispatcher.ts`
- Modify: `tests/integration/control-dispatcher.integration.test.ts`

- [ ] Extend contract tests with `query_project_index`, rejecting unknown fields, limits outside 1–20, and any caller-supplied path or object id.
- [ ] Update registry and dispatcher tests first and confirm the exact-tool assertions fail.
- [ ] Add the visible schema, leased internal schema, stable description, adapter registration, and dispatcher call.
- [ ] Keep root-session and lease enforcement unchanged; do not add Web execution paths or direct CAS-id reads.

### Task 6: Make Research consume the index safely

**Files:**
- Modify: `skills/research/SKILL.md`

- [ ] Require the root orchestration session to query the frozen project index using objective terms before broad source reads.
- [ ] State that index matches are discovery hints, repository files remain authoritative, and every important conclusion still needs file/line evidence.
- [ ] Define the unavailable fallback as direct repository inspection without failing Research.
- [ ] Keep the Skill concise and do not add a new workflow stage or role.

### Task 7: Unified verification and delivery

**Files:**
- Modify only files required by failures caused by this feature.

- [ ] Run `pnpm build`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm test` and rerun any timeout-only failures sequentially to distinguish environmental contention from deterministic failures.
- [ ] Run `pnpm test:integration`.
- [ ] Run `pnpm check:generated`, `pnpm validate:skills`, and `pnpm validate:plugins`.
- [ ] Run the relevant control-server/MCP end-to-end or contract tests that cover tool exposure and process equivalence.
- [ ] Inspect `git diff` line by line for unrelated changes, secrets, generated drift, schema mistakes, and original-business-rule regressions.
- [ ] Commit the implementation on `main`, push `main` to GitHub, and report changed files, table fields, business-rule impact, test evidence, and rollback point.
