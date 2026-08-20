# Project Orchestrator Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the monorepo, versioned contracts, local SQLite/CAS persistence, immutable workflow/role publishing, and three built-in templates with ten built-in roles.

**Architecture:** Shared TypeBox schemas are the only cross-package contract source. SQLite stores relational state and object indexes; a filesystem CAS stores immutable normalized content. Configuration changes follow draft → validated publish → immutable version, so later Web edits cannot alter a published version or Run input.

**Tech Stack:** Node.js 22, TypeScript, pnpm, TypeBox, Ajv, better-sqlite3, Vitest.

---

## Scope and file map

**Create:**

```text
package.json
pnpm-workspace.yaml
tsconfig.base.json
eslint.config.mjs
vitest.workspace.ts
packages/contracts/package.json
packages/contracts/tsconfig.json
packages/contracts/src/{envelope,workflow,role,run,error,index}.ts
packages/contracts/test/contracts.test.ts
packages/sqlite-store/package.json
packages/sqlite-store/tsconfig.json
packages/sqlite-store/migrations/001_foundation.sql
packages/sqlite-store/src/{database,migrate,config-repository,index}.ts
packages/sqlite-store/test/{migration,config-repository}.test.ts
packages/content-store/package.json
packages/content-store/tsconfig.json
packages/content-store/src/{content-store,index}.ts
packages/content-store/test/content-store.test.ts
packages/orchestrator-service/package.json
packages/orchestrator-service/tsconfig.json
packages/orchestrator-service/src/{config-service,seed-builtins,index}.ts
packages/orchestrator-service/test/{config-service,seed-builtins}.test.ts
```

No application server, Agent adapter, Web UI, lease, or Run state is implemented in this slice.

## Task 1: Bootstrap the workspace

**Files:** root workspace files and the four package manifests listed above.

- [ ] **Step 1: Write the root manifest**

Create `package.json` with the exact scripts that later plans extend:

```json
{
  "name": "project-orchestrator",
  "private": true,
  "packageManager": "pnpm@11.0.8",
  "engines": { "node": ">=22.0.0" },
  "scripts": {
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "lint": "eslint .",
    "test": "vitest run --project unit",
    "test:integration": "vitest run --project integration"
  },
  "devDependencies": {
    "@eslint/js": "latest",
    "@types/node": "latest",
    "eslint": "latest",
    "typescript": "latest",
    "typescript-eslint": "latest",
    "vitest": "latest"
  }
}
```

- [ ] **Step 2: Define workspace and compiler policy**

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*
```

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

Create `vitest.workspace.ts`:

```ts
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['packages/*/test/**/*.test.ts'],
      exclude: ['packages/*/test/**/*.integration.test.ts'],
    },
  },
  {
    test: {
      name: 'integration',
      include: ['tests/integration/**/*.test.ts', 'packages/*/test/**/*.integration.test.ts'],
      testTimeout: 30_000,
    },
  },
]);
```

Create `eslint.config.mjs` that applies TypeScript recommended rules, ignores `dist`, `coverage`, `playwright-report`, and rejects floating promises via `@typescript-eslint/no-floating-promises`.

- [ ] **Step 3: Define package manifests**

Use package names `@project-orchestrator/contracts`, `@project-orchestrator/sqlite-store`, `@project-orchestrator/content-store`, and `@project-orchestrator/orchestrator-service`. Each manifest must be private ESM, export `./dist/index.js`, and provide:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

Add these dependencies only where used:

```text
contracts: @sinclair/typebox, ajv, ajv-formats
sqlite-store: better-sqlite3, contracts; dev @types/better-sqlite3
content-store: contracts
orchestrator-service: contracts, sqlite-store, content-store
```

Each package `tsconfig.json` extends `../../tsconfig.base.json`, sets `rootDir: "src"`, `outDir: "dist"`, and includes `src/**/*.ts`.

## Task 2: Define versioned shared contracts

**Files:** `packages/contracts/src/*` and `packages/contracts/test/contracts.test.ts`.

- [ ] **Step 1: Author contract tests before implementations**

Create tests proving:

```ts
import { describe, expect, it } from 'vitest';
import {
  ContractValidator,
  WorkflowVersionEnvelopeSchema,
  StageOutputEnvelopeSchema,
} from '../src/index.js';

const validator = new ContractValidator();

describe('contract envelopes', () => {
  it('accepts a versioned workflow envelope', () => {
    const input = {
      schema_id: 'project-orchestrator/workflow-version',
      schema_version: 1,
      data: {
        slug: 'new-project',
        version: 1,
        stages: [{ key: 'research', role_version_id: 'role-v1', optional: false, mandatory_gate: false }],
        edges: [],
        iteration_groups: [],
      },
    };
    expect(validator.check(WorkflowVersionEnvelopeSchema, input)).toEqual(input);
  });

  it('rejects an unversioned stage output', () => {
    expect(() => validator.check(StageOutputEnvelopeSchema, { status: 'succeeded' }))
      .toThrow(/schema_id/);
  });
});
```

- [ ] **Step 2: Implement the envelope and validator**

Create `envelope.ts` with `Envelope(schemaId, version, dataSchema)` returning a TypeBox object with `additionalProperties: false`. Implement `ContractValidator.check(schema, value)` using one Ajv 2020 instance with formats, `allErrors: true`, and a stable error string sorted by `instancePath + keyword`.

The exported helper must have this signature:

```ts
export class ContractValidator {
  check<T extends TSchema>(schema: T, value: unknown): Static<T>;
}
```

- [ ] **Step 3: Implement workflow contracts**

`workflow.ts` must export schemas and static types for:

```ts
type WorkflowStage = {
  key: string;
  role_version_id: string;
  optional: boolean;
  mandatory_gate: boolean;
  condition?: ConditionExpression;
  failure_policy: 'pause' | 'fail' | 'retry_then_fail' | 'trigger_iteration';
  max_attempts: number;
  iteration_group_key?: string;
  requires_confirmation: boolean;
};

type WorkflowEdge = {
  from: string;
  to: string;
  edge_type: 'requires' | 'on_success';
  condition?: ConditionExpression;
};

type ConditionExpression =
  | { op: 'eq' | 'ne'; path: string; value: string | number | boolean | null }
  | { op: 'in'; path: string; values: Array<string | number | boolean> }
  | { op: 'exists'; path: string }
  | { op: 'all' | 'any'; items: ConditionExpression[] }
  | { op: 'not'; item: ConditionExpression };
```

`WorkflowVersionEnvelopeSchema` uses schema id `project-orchestrator/workflow-version`, version `1`, unique stage keys, and iteration groups shaped as `{key, entry_stage_key, gate_stage_keys, aggregation_policy:'collect_all', max_iterations}`.

- [ ] **Step 4: Implement role and Run contracts**

`role.ts` defines immutable role content with slug, display name, responsibilities, allowed/forbidden capability strings, input/output schemas, completion contract, and Markdown body.

`run.ts` defines:

```ts
export type StageOutputData = {
  status: 'succeeded' | 'failed';
  summary: string;
  artifact_object_ids: string[];
  evidence_object_ids: string[];
  changed_file_manifest_object_id?: string;
  risks: string[];
  next_stage_notes: string[];
};
```

Add tool request/response envelopes for create/claim/begin/complete/fail/confirmation later without lease secrets. Model-visible request types may contain `run_id`, `stage_run_id`, and `request_id`, but must not contain `lease_token` or `lease_epoch`.

`error.ts` exports stable error codes from design section 14 plus `INVALID_TRANSITION`, `STALE_LEASE`, `IDEMPOTENCY_CONFLICT`, `SCHEMA_INVALID`, `POLICY_VIOLATION`, and `NOT_FOUND`.

## Task 3: Implement SQLite foundation and migrations

**Files:** sqlite package migration, source, and tests.

- [ ] **Step 1: Author migration tests**

Create tests that open a temporary DB, run migrations twice, assert `PRAGMA foreign_keys=1`, `journal_mode=wal`, and verify tables/constraints by attempting duplicate slugs, duplicate version numbers, and deleting a referenced content object.

Use this assertion pattern:

```ts
expect(() => db.prepare(
  "INSERT INTO content_objects(id, sha256, media_type, size_bytes, storage_key, created_at) VALUES(?,?,?,?,?,?)",
).run('2', 'same', 'text/plain', 1, 'same', now)).toThrow(/UNIQUE/);
```

- [ ] **Step 2: Write `001_foundation.sql`**

Create these tables with UUID text primary keys, UTC ISO text timestamps, explicit foreign keys, and `ON DELETE RESTRICT`:

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE content_objects (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  storage_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE workflow_templates (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  task_type TEXT NOT NULL CHECK(task_type IN ('new_project','feature','bugfix')),
  status TEXT NOT NULL CHECK(status IN ('active','disabled','archived')),
  current_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workflow_drafts (
  workflow_template_id TEXT PRIMARY KEY REFERENCES workflow_templates(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  draft_envelope TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workflow_versions (
  id TEXT PRIMARY KEY,
  workflow_template_id TEXT NOT NULL REFERENCES workflow_templates(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL CHECK(version_number > 0),
  description TEXT NOT NULL,
  safety_baseline_version INTEGER NOT NULL,
  content_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT,
  content_hash TEXT NOT NULL,
  published_at TEXT NOT NULL,
  UNIQUE(workflow_template_id, version_number)
);

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','disabled','archived')),
  current_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE role_drafts (
  role_id TEXT PRIMARY KEY REFERENCES roles(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  draft_envelope TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE role_versions (
  id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL CHECK(version_number > 0),
  content_object_id TEXT NOT NULL REFERENCES content_objects(id) ON DELETE RESTRICT,
  skill_hash TEXT NOT NULL,
  input_schema_envelope TEXT NOT NULL,
  output_schema_envelope TEXT NOT NULL,
  requested_capabilities TEXT NOT NULL,
  effective_capabilities TEXT NOT NULL,
  forbidden_capabilities TEXT NOT NULL,
  completion_contract_envelope TEXT NOT NULL,
  published_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('published','revoked')),
  UNIQUE(role_id, version_number)
);
```

Add deferred foreign keys from both `current_version_id` columns to their version tables through triggers that abort when a version belongs to another parent. Add indexes on status and parent/version keys.

- [ ] **Step 3: Implement database lifecycle**

`database.ts` exports `openDatabase(path)` and applies:

```sql
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
PRAGMA synchronous=FULL;
```

`migrate.ts` reads sorted `NNN_name.sql` files, hashes each file, rejects checksum drift, creates a pre-migration backup for non-empty databases, and applies each new migration plus its `schema_migrations` row in one transaction.

- [ ] **Step 4: Implement configuration repositories**

`config-repository.ts` must expose transactional methods:

```ts
export interface ConfigRepository {
  saveWorkflowDraft(templateId: string, expectedRevision: number, envelope: unknown): number;
  publishWorkflow(input: PublishedWorkflowInsert): void;
  saveRoleDraft(roleId: string, expectedRevision: number, envelope: unknown): number;
  publishRole(input: PublishedRoleInsert): void;
  getPublishedWorkflow(id: string): PublishedWorkflowRecord | undefined;
  getPublishedRole(id: string): PublishedRoleRecord | undefined;
}
```

Draft update SQL includes `WHERE revision = ?`; zero changed rows throws `REVISION_CONFLICT`. Publishing inserts version and updates parent current version in the same immediate transaction. Repository return values are plain immutable objects, never live SQLite rows.

## Task 4: Implement the content-addressed store

**Files:** content store source and tests.

- [ ] **Step 1: Author immutability and path-safety tests**

Cover same-content deduplication, concurrent duplicate writes, hash mismatch detection, read-only final mode, atomic temp cleanup, symlink source rejection, and refusal to resolve a storage key outside the objects root.

- [ ] **Step 2: Implement canonical content writes**

`content-store.ts` exports:

```ts
export type ContentObject = {
  id: string;
  sha256: string;
  mediaType: string;
  sizeBytes: number;
  storageKey: string;
};

export class ContentStore {
  constructor(objectsRoot: string, db: Database.Database);
  putBytes(bytes: Uint8Array, mediaType: string): ContentObject;
  putCanonicalJson(value: unknown): ContentObject;
  putUtf8(text: string, mediaType?: string): ContentObject;
  read(objectId: string): Uint8Array;
  verify(objectId: string): void;
}
```

Canonical JSON recursively sorts object keys, preserves array order, rejects non-finite numbers and `undefined`, encodes UTF-8 without trailing whitespace, and hashes the exact bytes. Writes use a random temp file under the same objects directory, `fsync`, `rename`, directory `fsync`, and `0444` final mode. SQLite insertion and duplicate-hash lookup are transactional; filesystem races converge on the existing object.

## Task 5: Implement draft publication and built-in seed data

**Files:** orchestrator service source and tests.

- [ ] **Step 1: Author service tests**

Tests must prove:

1. Publishing a role intersects requested capabilities with the platform allowlist.
2. A role requesting forbidden capability `production-shell` is rejected.
3. Publishing a workflow with a missing role, cycle, missing mandatory gate, or `max_iterations > 3` fails.
4. Saving a draft does not change current published version.
5. Publishing v2 leaves v1 CAS bytes and DB row unchanged.
6. Seeding twice is idempotent and yields exactly ten roles and three templates.

- [ ] **Step 2: Implement `ConfigService`**

Expose:

```ts
export class ConfigService {
  saveWorkflowDraft(input: SaveDraftInput): SavedDraft;
  publishWorkflow(input: PublishWorkflowInput): PublishedVersion;
  saveRoleDraft(input: SaveDraftInput): SavedDraft;
  publishRole(input: PublishRoleInput): PublishedVersion;
  listPublishedTemplates(taskType?: string): PublishedVersion[];
}
```

Publication order is: validate envelope → canonicalize → enforce platform baseline → resolve active published roles → compute effective capabilities → write CAS object → insert immutable version and advance current pointer in one DB transaction. A CAS object written just before a failed DB transaction is harmless and is later collectible only by maintenance tooling.

- [ ] **Step 3: Seed ten roles**

`seed-builtins.ts` defines these fixed slugs:

```ts
export const BUILTIN_ROLE_SLUGS = [
  'requirements', 'research', 'architecture', 'ui-design', 'implementation',
  'code-review', 'testing', 'security', 'operations', 'memory-docs',
] as const;
```

Each seed role has version `1`, a non-empty Markdown responsibility body, explicit input/output Schema envelopes, requested capabilities, forbidden capabilities, and completion contract. `operations` may request `managed-side-effect`; no role may request raw production credentials.

- [ ] **Step 4: Seed three templates**

Seed `new-project`, `feature-development`, and `bug-fix` from design section 6.2. The new-project template contains `delivery_loop` with entry `implementation`, gates `code-review/testing/security`, `collect_all`, maximum `3`, then `operations` and `memory-docs`. Feature and Bug templates encode the exact condition triggers from the design, not free-form scripts.

## Task 6: Run the slice verification once and commit

- [ ] **Step 1: Install and lock dependencies**

```bash
pnpm install
```

Expected: `pnpm-lock.yaml` is created and installation exits `0` on Node 22.

- [ ] **Step 2: Run the complete foundation checks**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
```

Expected: all commands exit `0`; contract invalid-input tests fail for the intended Schema reason; SQLite integration tests run against temporary files; no test touches the user's real home data directory.

- [ ] **Step 3: Inspect generated dependency boundary**

```bash
pnpm list -r --depth 0
git diff --check
git status --short
```

Expected: only approved open-source basics are present; no hosted orchestrator/database SDK appears; diff check is clean.

- [ ] **Step 4: Commit the verified slice**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json eslint.config.mjs vitest.workspace.ts packages
GIT_AUTHOR_NAME="weifashi" GIT_AUTHOR_EMAIL="weifashi@ttpos.com" \
  git commit -m "feat: add orchestrator foundation"
```

Expected: one commit containing workspace, contracts, SQLite/CAS, configuration service, seeds, and their tests.
