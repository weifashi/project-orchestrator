# Lightweight Project Index Design

## Decision

Add a project-scoped, deterministic source index that is created automatically
when a new Run first enters its Research role. The index is a derived aid for
source discovery, not a replacement for reading and verifying repository files.

SQLite and the content-addressed store remain the only durable source of truth.
The immutable index body is stored in CAS, SQLite stores its project and Run
bindings, and no index file is written into the user's repository.

## Scope

The first slice provides:

- automatic, best-effort indexing after a Research attempt has started;
- Git-tracked regular files only;
- file path, language, byte size, SHA-256 content hash, import references, and
  top-level symbol names with line anchors;
- heuristic structural extraction for TypeScript/JavaScript, Go, Dart, and
  Python, with metadata-only records for other recognized text files;
- incremental reuse of unchanged file records from the previous project index;
- one immutable index binding per Run so later project changes do not rewrite
  the evidence used by an existing task;
- a leased, bounded `query_project_index` tool for the root orchestration
  session; and
- Research Skill guidance to query the index before selecting source files.

The first slice does not provide a knowledge-graph page, AI-generated summaries,
business-domain inference, transitive impact analysis, embeddings, filesystem
watchers, or an automatically committed JSON file.

## Trigger and lifecycle

```text
begin Research stage
        |
        +-- create the stage attempt atomically
        |
        +-- Run already has an index binding? -- yes --> reuse it
        |
        +-- scan current authenticated project path
        |      |
        |      +-- unchanged file --> reuse prior parsed record
        |      +-- changed file   --> parse metadata again
        |
        +-- write canonical index envelope to CAS
        +-- bind index to Run, Research stage, and attempt
        +-- continue even if indexing is unavailable
```

Indexing happens after the stage transition transaction, so filesystem scanning
does not hold a SQLite write lock. An indexing failure never rolls back or fails
the Research attempt. A later query returns an explicit unavailable status and
the Research Skill falls back to direct repository inspection.

Retries reuse the Run's first successful binding. Existing Runs without a
binding are unchanged unless they enter Research after this feature is installed.

## Index contract

The CAS body uses this envelope:

```json
{
  "schema_id": "project-orchestrator/project-index",
  "schema_version": 1,
  "data": {
    "source_head": "git commit or unborn",
    "tree_fingerprint": "sha256",
    "generated_at": "ISO-8601",
    "files": [
      {
        "path": "packages/example/src/index.ts",
        "language": "typescript",
        "size_bytes": 1200,
        "content_sha256": "sha256",
        "imports": ["./service.js"],
        "symbols": [
          { "kind": "function", "name": "start", "line": 12 }
        ]
      }
    ],
    "skipped": {
      "binary": 0,
      "generated_or_dependency": 0,
      "sensitive": 0,
      "too_large": 0,
      "unsupported_or_missing": 0
    }
  }
}
```

The envelope contains no absolute repository path and no source bodies. Symbol
records keep names and line numbers only; they do not preserve declaration text
or default values.

## Persistence

### `project_indexes`

| Column | Rule |
|---|---|
| `id` | immutable identifier |
| `project_id` | owning project |
| `source_head` | Git HEAD observed during the scan |
| `tree_fingerprint` | hash of sorted indexed path/content-hash pairs |
| `content_object_id` | immutable CAS envelope |
| `file_count` | indexed file count |
| `changed_file_count` | added, removed, or content-changed paths versus the prior index |
| `skipped_file_count` | files omitted by safety and size rules |
| `created_at` | creation time |

`(project_id, tree_fingerprint)` is unique, allowing identical trees to reuse an
existing index object.

### `run_project_indexes`

| Column | Rule |
|---|---|
| `run_id` | primary key; one frozen index per Run |
| `project_index_id` | referenced project index |
| `stage_run_id` | Research stage that caused the binding |
| `stage_attempt_id` | Research attempt that caused the binding |
| `bound_at` | binding time |

Insert triggers verify that the Run, project, stage, and attempt belong together.
Both tables are immutable after insertion.

## Query tool

`query_project_index` accepts the leased `run_id` and `request_id` plus optional:

- `query`: case-insensitive substring matched against paths, import references,
  and symbol names;
- `language`: exact language filter;
- `cursor`: zero-based result offset; and
- `limit`: 1 through 20.

The server returns the frozen index object id, freshness metadata, counts, a
bounded page of matching file records, and the next cursor. Result construction
stops before the MCP response limit rather than relying on arbitrary string
truncation. A Run without a successful binding returns `status: unavailable`.

The tool does not accept a project path or content object id from the model. The
authenticated Run determines both.

## Safety limits

- Resolve and compare the authenticated project path with the project's stored
  canonical path.
- Enumerate with `git ls-files`; do not include untracked files.
- Reject symlinks and paths that resolve outside the project root.
- Skip dependency, generated-output, cache, and coverage directories.
- Skip `.env*`, private-key, certificate, and credential-container files.
- Skip files above 1 MiB and files containing a NUL byte.
- Stop with an unavailable result when the repository exceeds 20,000 tracked
  paths or 128 MiB of eligible source content.
- Execute Git commands without a shell, with bounded output and a timeout.
- Treat index fields and repository content as untrusted evidence, never as
  executable instructions.

## Business rules preserved

- Web remains read-only for task execution, confirmation, retry, and deployment.
- Only the bound root session can invoke leased orchestration tools.
- Run workflow, role, rule, safety, capability, and workspace snapshots remain
  immutable.
- Existing task recovery continues to use `working_tree_fingerprint`; the new
  per-file fingerprint is a discovery index and does not replace recovery rules.
- A successful stage still requires its existing completion artifacts and
  evidence. A project index does not certify that Research is correct.

## Acceptance criteria

1. Starting a non-Research role does not create or bind a project index.
2. The first Research attempt for a Run creates and binds one index without
   holding the stage transition transaction during the scan.
3. A later Research retry or duplicate request reuses the same Run binding.
4. A new Run on an unchanged tree reuses the existing project index.
5. A new Run after one source file changes reparses that file, reuses unchanged
   records, and records the correct changed-file count.
6. Existing Runs keep their original index object after the repository changes.
7. Unsafe, sensitive, binary, oversized, generated, and dependency files are not
   represented as indexed source records.
8. Query results are schema-validated, paginated, bounded, and scoped to the
   authenticated Run.
9. Git/index failures do not fail the Research stage and produce an explicit
   unavailable query response.
10. Build, typecheck, lint, unit, integration, generated-plugin, Skill, and
    relevant end-to-end checks pass before delivery.
