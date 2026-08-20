# Deterministic Run Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the deterministic workflow runtime, Run/Stage/Attempt persistence, leases and recovery, immutable evidence, confirmation-bound side effects, and local Control Server boundaries.

**Architecture:** Pure workflow functions decide conditions, frontiers, legal transitions, and bounded iterations; transactional services persist their decisions in SQLite and emit ordered events. Agent writes enter through a `0600` Unix socket, while Web config/read endpoints use a separate loopback listener and principal. A separately launched operation helper owns managed side-effect credentials.

**Tech Stack:** TypeScript, better-sqlite3, TypeBox/Ajv, fast-check, Fastify, Node Unix sockets, Vitest.

---

## Scope and file map

**Create:**

```text
packages/contracts/src/{tool-contracts,internal-ipc,events}.ts
packages/sqlite-store/migrations/002_runtime.sql
packages/sqlite-store/src/{run-repository,event-repository,idempotency-repository}.ts
packages/sqlite-store/test/runtime-migration.test.ts
packages/workflow-engine/package.json
packages/workflow-engine/tsconfig.json
packages/workflow-engine/src/{condition,graph,frontier,state-machine,iteration,index}.ts
packages/workflow-engine/test/{condition,graph,frontier,state-machine,iteration}.test.ts
packages/orchestrator-service/src/{run-service,lease-service,evidence-service,confirmation-service,operation-service,recovery-service}.ts
packages/orchestrator-service/test/{run-service,lease-service,evidence-service,confirmation-service,operation-service,recovery-service}.test.ts
packages/operation-executor/package.json
packages/operation-executor/tsconfig.json
packages/operation-executor/src/{main,server,driver-registry,types}.ts
packages/operation-executor/test/server.test.ts
apps/control-server/package.json
apps/control-server/tsconfig.json
apps/control-server/src/{config,app,main}.ts
apps/control-server/src/ipc/{agent-listener,principal}.ts
apps/control-server/src/http/{web-listener,sse}.ts
apps/control-server/src/http/routes/{config,read,system}.ts
tests/integration/{run-lifecycle,web-agent-isolation,side-effect}.test.ts
```

Modify root manifests to include `apps/*`, Fastify, fast-check, and the new packages.

## Task 1: Extend contracts and runtime schema

- [ ] **Step 1: Author runtime migration tests**

Before implementation, create a test that migrates a Plan 01 DB and asserts foreign keys, unique event sequence, unique attempt number, unique iteration, confirmation state checks, and `ON DELETE RESTRICT` for Run history.

- [ ] **Step 2: Create `002_runtime.sql`**

Implement every table from design sections 11.4–11.7:

```text
client_installations, projects, runs, run_snapshots,
workspace_checkpoints, stage_runs, run_iterations, stage_attempts,
confirmation_requests, side_effect_operations, artifacts, memories,
events, idempotency_requests
```

Required relational constraints:

```sql
UNIQUE(run_id, stage_key, iteration_number)
UNIQUE(run_id, group_key, iteration_number)
UNIQUE(stage_run_id, attempt_number)
UNIQUE(run_id, sequence_number)
UNIQUE(principal_id, operation, request_id)
```

Use exact `CHECK` enums from design section 11. `stage_runs.iteration_number` is `INTEGER NOT NULL DEFAULT 0`; `iteration_group_key` is nullable. `run_snapshots.run_id` is both PK and FK. Secret columns store only SHA-256 hashes. Add indexes for active Runs, project history, frontier StageRuns, pending confirmations, event tailing, and CAS references.

- [ ] **Step 3: Define model-visible tool contracts**

`tool-contracts.ts` must define these request schemas without lease secrets:

```ts
export type VisibleWriteContext = { run_id: string; request_id: string };

export const AgentToolNames = [
  'create_run', 'claim_run', 'heartbeat_run', 'begin_stage', 'complete_stage',
  'fail_stage', 'retry_stage', 'skip_stage', 'request_confirmation',
  'record_artifact', 'record_workspace_checkpoint', 'record_memory',
  'append_agent_note', 'prepare_side_effect', 'execute_side_effect',
  'reconcile_side_effect', 'pause_run', 'cancel_run', 'finalize_run',
] as const;
```

`internal-ipc.ts` adds adapter-only fields `{installation_id, root_session_id, lease_epoch?, lease_token?}` in a separate envelope. A TypeScript compile-time test uses `satisfies` and `@ts-expect-error` to prove `lease_token` cannot be passed to a model-visible request.

- [ ] **Step 4: Define event contracts**

`events.ts` exports server-owned event names for state changes and one Agent-owned name `agent_note`. No request schema permits a caller-selected `source_principal_id`, `sequence_number`, confirmation decision, or system event type.

## Task 2: Implement pure workflow logic

**Files:** workflow engine source and tests.

- [ ] **Step 1: Author all pure-function tests first**

Cover:

- condition operations `eq/ne/in/exists/all/any/not`;
- missing/invalid path fails closed;
- success graph must be acyclic and reachable;
- mandatory gates cannot be optional or conditionally bypassed;
- frontier derives multiple parallel ready stages;
- Run and Stage transition matrices reject every unspecified edge;
- three failed delivery iterations terminate without creating iteration four;
- a successful latest iteration unlocks operations;
- historical succeeded StageRuns remain immutable.

Use fast-check to generate transition sequences and assert terminal states never leave terminal and event sequence is monotonic.

- [ ] **Step 2: Implement condition evaluation**

`condition.ts` exports:

```ts
export type EvaluationContext = Readonly<{
  input: unknown;
  outputs: Readonly<Record<string, unknown>>;
  constants: Readonly<Record<string, unknown>>;
}>;

export function evaluateCondition(expression: ConditionExpression | undefined, context: EvaluationContext): boolean;
```

Only JSON pointer roots `/input`, `/outputs`, and `/constants` are legal. `undefined`, invalid path, wrong operand type, or evaluation exception throws `CONDITION_EVALUATION_FAILED`; the caller marks the Run failed.

- [ ] **Step 3: Implement graph validation and frontier**

`graph.ts` uses Kahn's algorithm over `requires/on_success` edges and returns a stable stage-key order. Reject duplicate keys, missing endpoints, cycles, unreachable stages, empty iteration gates, an iteration entry also used as a gate, maximum iteration outside `1..3`, and any mandatory gate with a bypass path.

`frontier.ts` takes immutable workflow plus persisted StageRun projections and returns:

```ts
export type Frontier = {
  ready: string[];
  blocked: Array<{ stageKey: string; reason: string }>;
  skipped: string[];
  waitingForUser: string[];
};
```

It never mutates input and sorts each array by workflow topological order.

- [ ] **Step 4: Implement transition matrices and iteration reducer**

Represent legal transitions as closed maps, not scattered conditionals:

```ts
export const RUN_TRANSITIONS = {
  created: ['running', 'cancelled'],
  running: ['waiting_for_user', 'paused', 'interrupted', 'failed', 'cancelled', 'completed'],
  waiting_for_user: ['running', 'paused', 'interrupted', 'cancelled'],
  paused: ['running', 'cancelled'],
  interrupted: ['running', 'cancelled'],
  failed: ['running'],
  cancelled: [],
  completed: [],
} as const;
```

Stage and Attempt maps follow design section 8.3. `iteration.ts` returns explicit commands `{createIteration, createStageRuns, markIteration, markRunFailed}`; it never writes SQLite itself.

## Task 3: Implement transactional repositories and ordered events

- [ ] **Step 1: Author repository tests**

Test concurrent idempotency keys, same-key different-body conflict, event allocation without `MAX()+1`, transaction rollback leaving no partial Attempt/artifact/event, and stale lease epoch rejection.

- [ ] **Step 2: Implement repositories**

`run-repository.ts` exposes transaction-scoped methods only; callers cannot directly set `completed`. `event-repository.ts` atomically reads/increments `runs.next_event_sequence` and inserts the event in the same transaction as the business state change. `idempotency-repository.ts` implements:

```ts
begin(principalId: string, operation: string, requestId: string, requestHash: string):
  | { kind: 'new'; id: string }
  | { kind: 'replay'; response: unknown };
complete(id: string, response: unknown): void;
fail(id: string, error: unknown): void;
```

A conflicting request hash throws `IDEMPOTENCY_CONFLICT`.

## Task 4: Implement Run creation, progression, retry, and recovery

- [ ] **Step 1: Author lifecycle service tests**

Use an in-process temporary DB/CAS and assert:

1. `createRun` freezes full immutable objects and creates initial StageRuns.
2. Changing drafts after create does not change context.
3. Root claim returns lease and recovery secrets once while DB stores hashes.
4. Parallel frontier can contain architecture and UI while only root commits results.
5. Run failed retry atomically claims a lease, creates a new Attempt, and moves both records running.
6. A still-running parallel Run can locally retry failed/interrupted StageRun.
7. stale token/epoch, expired lease, and subagent principal are rejected.
8. server epoch invalidates old leases after restart.
9. recovery uses last trusted workspace checkpoint and returns stable mismatch codes.

- [ ] **Step 2: Implement `LeaseService`**

Use 32-byte random tokens, SHA-256 stored hashes, constant-time comparison, monotonic `lease_epoch`, UTC deadlines, and an installation-bound rotating recovery secret. The service receives adapter-authenticated principal fields; it never trusts identity in request JSON.

- [ ] **Step 3: Implement `RunService`**

Methods mirror the Agent tool names. Every write executes this order inside one immediate transaction:

```text
authenticate principal → begin idempotency → validate lease/fencing →
validate current state/frontier → freeze supplied content → mutate rows →
emit server event(s) → save idempotent response → commit
```

`finalizeRun` recalculates all required stages, latest iteration, confirmations, artifacts, and safety gates; it ignores any caller-supplied completion boolean. A Run with runnable parallel work remains running even if one StageRun fails; it enters failed only when no legal work remains.

- [ ] **Step 4: Implement evidence and checkpoints**

`EvidenceService.recordArtifact` opens source files with no-follow semantics, validates the resolved file descriptor is under the authorized project root, copies bytes into CAS, and stores source path as metadata only. Successful Attempt completion freezes its artifact/evidence/changed-file manifests in one transaction.

`recordWorkspaceCheckpoint` accepts kinds `run_start/before_attempt/progress/after_attempt`. Recovery compares current repository head, staged patch, unstaged patch, untracked manifest, and submodule manifest to the last trusted resulting fingerprint. Unrecorded changes return `WORKTREE_CHANGED` and a Diff object reference; they are never silently accepted.

## Task 5: Implement confirmation and managed operations

- [ ] **Step 1: Author confirmation/operation tests**

Prove nonce expiry, wrong action hash, wrong installation, replay, double consumption, unknown-result no-auto-retry, and reconciliation. Prove a Web principal and a model-visible Agent payload cannot submit a confirmation decision.

- [ ] **Step 2: Implement `ConfirmationService`**

Create one-time requests bound to Run, StageRun, exact canonical action hash, safety baseline object, installation, nonce hash, and expiry. `submitDecision` is callable only from the Adapter's trusted interactive channel; rejection marks the Attempt `USER_REJECTED` and applies pause/cancel policy.

- [ ] **Step 3: Implement `OperationService`**

`prepareSideEffect` canonicalizes `{action_type,target_fingerprint,parameters}` and creates `intent_recorded` plus confirmation. `executeSideEffect` atomically consumes approval and changes to `executing`, then calls the helper. Success records external reference and evidence; transport loss or process crash records `unknown`. `unknown` can only call reconcile, never execute again.

- [ ] **Step 4: Implement isolated operation helper**

The helper listens on its own `0600` Unix socket and loads a root-owned/user-readable driver registry unavailable to Web editing. A driver entry is:

```ts
export type OperationDriver = {
  actionType: string;
  executable: string;
  allowedParameterKeys: string[];
  fixedArgs: string[];
  timeoutMs: number;
};
```

The model never supplies executable, environment variable names, or arbitrary argument positions. The helper starts with a sanitized environment plus an optional operator-managed credential file, captures bounded stdout/stderr with redaction, and returns `{status:'succeeded'|'unknown', externalReference?, evidence}`. Tests use only a fixture executable; no real deployment runs in CI.

## Task 6: Implement Control Server transport boundaries

- [ ] **Step 1: Author integration tests**

Create `web-agent-isolation.test.ts` that starts both listeners and proves:

- Web token can publish a valid draft and read Runs.
- Web token cannot connect to the Unix socket or invoke any Run write.
- Agent installation credential cannot call Web config routes.
- Host/Origin/CSRF failures return 403.
- unknown route defaults to 404 and unknown capability to 403.
- SSE resumes from `Last-Event-ID` without gaps or duplicates.

- [ ] **Step 2: Implement runtime config**

`config.ts` reads explicit paths, validates data/runtime directory permissions, requires loopback host, separates web token and adapter credential files, and never prints secret values. Default paths match design section 12.1.

- [ ] **Step 3: Implement Agent Unix listener**

Use newline-delimited, size-limited internal envelopes over `control.sock`. Authenticate installation credential during connection setup, derive principal, and attach lease fields from adapter-only envelopes. Reject subagent/root-session mismatch. Set socket mode `0600` after listen.

- [ ] **Step 4: Implement Web listener and routes**

Fastify listens only on `127.0.0.1`. Register exactly:

```text
/api/config/workflow-drafts/*
/api/config/workflows/*/publish
/api/config/role-drafts/*
/api/config/roles/*/publish
/api/read/runs/*
/api/read/events/*
/api/read/artifacts/*
/api/read/memories/*
/api/read/system/*
/api/stream/events
```

Do not register create/claim/begin/complete/fail/retry/skip/pause/cancel/finalize/confirmation/operation routes. Config writes use HttpOnly SameSite cookie plus CSRF header. Artifact active content downloads with `Content-Disposition: attachment`; it is never rendered in the credentialed origin.

- [ ] **Step 5: Implement startup and recovery scan**

`main.ts` opens/migrates DB, verifies CAS, increments server epoch, marks previously running/waiting Runs interrupted, starts Agent socket, starts Web listener, and logs only non-secret endpoint metadata. SIGTERM stops accepting connections, flushes events, closes SQLite, and leaves external `executing` operations as `unknown` for next-start reconciliation.

## Task 7: Run the slice verification once and commit

- [ ] **Step 1: Install the expanded dependency graph**

```bash
pnpm install
```

Expected: lockfile updates with Fastify and fast-check; no hosted orchestration dependency appears.

- [ ] **Step 2: Run all runtime checks**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
```

Expected: zero failures; property tests report no counterexample; integration tests bind temporary loopback/socket paths only; no real side effect driver runs.

- [ ] **Step 3: Run boundary probes**

```bash
if rg -n "lease_token|lease_epoch" packages/contracts/src/tool-contracts.ts; then exit 1; fi
if rg -n "create_run|claim_run|begin_stage|complete_stage|retry_stage|pause_run|cancel_run|submit_confirmation" apps/control-server/src/http; then exit 1; fi
```

Expected: first command has no model-visible fields; second command has no registered HTTP route or handler.

- [ ] **Step 4: Commit**

```bash
git add apps/control-server packages tests/integration package.json pnpm-lock.yaml
GIT_AUTHOR_NAME="weifashi" GIT_AUTHOR_EMAIL="weifashi@ttpos.com" \
  git commit -m "feat: add deterministic run runtime"
```
