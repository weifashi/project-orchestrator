# Lightweight Project Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build and freeze a lightweight, queryable source index when a new Run first enters Research.

**Architecture:** A deterministic asynchronous indexer reads only safe Git-tracked files and reuses unchanged records from the latest CAS envelope. `RunService` fail-closed validates the frozen role and project path, then triggers a best-effort `ProjectIndexService` after the Research attempt transaction, while a new leased query tool returns schema-validated bounded pages from the Run's immutable index binding.

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

- [x] Write a migration test that expects `project_indexes` and `run_project_indexes`, unique project/head/tree reuse, cross-project ownership rejection, stage/attempt ownership rejection, and immutable update/delete behavior.
- [x] Run the focused test and confirm it fails because migration 005 and its tables do not exist.
- [x] Add the two tables, indexes, ownership triggers, and immutable triggers with only the columns approved in the design.
- [x] Keep foreign-key deletion restrictive so CAS and historical Run evidence cannot be silently removed.

### Task 2: Build the deterministic indexer

**Files:**
- Create: `packages/orchestrator-service/test/project-indexer.test.ts`
- Create: `packages/orchestrator-service/src/project-indexer.ts`

- [x] Write tests using temporary real Git repositories for tracked-only enumeration, TypeScript/JavaScript, Go, Dart, and Python extraction, line anchors, and metadata-only fallback.
- [x] Write tests proving untracked, symlink, sensitive, binary, oversized, dependency, and generated files are omitted with the correct skipped counters.
- [x] Write a test that supplies a previous envelope, changes one file, and expects unchanged record reuse plus added/changed/deleted path accounting.
- [x] Run the focused tests and confirm the missing indexer fails them.
- [x] Implement shell-free bounded Git commands, canonical path checks, hashing, limits, language detection, heuristic extractors, deterministic sorting, tree fingerprinting, and previous-record reuse.
- [x] Keep full source bodies and declaration text out of the returned envelope.

### Task 3: Persist, freeze, and query indexes

**Files:**
- Create: `packages/orchestrator-service/test/project-index-service.test.ts`
- Create: `packages/orchestrator-service/src/project-index-service.ts`
- Modify: `packages/orchestrator-service/src/index.ts`

- [x] Write tests that seed projects and Runs, ensure an index, verify CAS integrity, and bind the exact Research attempt.
- [x] Write tests that reuse the same project/HEAD/tree index across new Runs while preserving different Run bindings and creating a source-accurate index for a new HEAD.
- [x] Write a test that changes the repository after binding and proves the existing Run still reads its original object.
- [x] Write query tests for substring matching across path/import/symbol, language filtering, pagination, response-size bounding, and unavailable status.
- [x] Run the focused tests and confirm the missing service fails them.
- [x] Implement persistence and query projection using canonical CAS envelopes and short SQLite transactions after scanning.
- [x] Convert expected Git/index availability failures to an unavailable status while allowing policy, ownership, and path mismatches to fail closed.

### Task 4: Trigger indexing at Research entry

**Files:**
- Create: `packages/orchestrator-service/test/project-index-run.test.ts`
- Modify: `packages/orchestrator-service/src/run-service.ts`

- [x] Write a RunService test where a frozen role slug is `research` and beginning its ready stage creates one binding.
- [x] Write a test where a stage key says `research` but its frozen role slug is not `research`; expect no binding.
- [x] Write a test where indexing fails; expect the attempt to remain running and no binding to exist.
- [x] Run the focused test and confirm no automatic binding exists yet.
- [x] Refactor `beginStage` and `retryStage` to validate security context before transition, finish the leased transition, then asynchronously invoke best-effort indexing only when the frozen role slug is `research` and the Run has no binding.
- [x] Add a leased `queryProjectIndex` facade that scopes every query by the authenticated Run and existing lease.

### Task 5: Expose the bounded query tool

**Files:**
- Modify: `packages/contracts/src/tool-contracts.ts`
- Modify: `packages/contracts/src/internal-ipc.ts`
- Modify: `packages/mcp-adapter/src/tool-registry.ts`
- Modify: `packages/mcp-adapter/test/tool-registry.test.ts`
- Modify: `apps/control-server/src/ipc/control-dispatcher.ts`
- Modify: `tests/integration/control-dispatcher.integration.test.ts`

- [x] Extend contract tests with `query_project_index`, rejecting unknown fields, limits outside 1–20, and any caller-supplied path or object id.
- [x] Update registry and dispatcher tests first and confirm the exact-tool assertions fail.
- [x] Add the visible schema, leased internal schema, stable description, adapter registration, and dispatcher call.
- [x] Keep root-session and lease enforcement unchanged; do not add Web execution paths or direct CAS-id reads.

### Task 6: Make Research consume the index safely

**Files:**
- Modify: `skills/research/SKILL.md`

- [x] Require the root orchestration session to query the frozen project index using objective terms before broad source reads.
- [x] State that index matches are discovery hints, repository files remain authoritative, and every important conclusion still needs file/line evidence.
- [x] Define the unavailable fallback as direct repository inspection without failing Research.
- [x] Keep the Skill concise and do not add a new workflow stage or role.

### Task 7: Unified verification and delivery

**Files:**
- Modify only files required by failures caused by this feature.

- [x] Run `pnpm build`.
- [x] Run `pnpm typecheck`.
- [x] Run `pnpm lint`.
- [x] Run `pnpm test` and rerun any timeout-only failures sequentially to distinguish environmental contention from deterministic failures.
- [x] Run `pnpm test:integration`.
- [x] Run `pnpm check:generated`, `pnpm validate:skills`, and `pnpm validate:plugins`.
- [x] Run the relevant control-server/MCP end-to-end or contract tests that cover tool exposure and process equivalence.
- [x] Inspect `git diff` line by line for unrelated changes, secrets, generated drift, schema mistakes, and original-business-rule regressions.
- [x] Commit the implementation on `main`, push `main` to GitHub, and report changed files, table fields, business-rule impact, test evidence, and rollback point.
