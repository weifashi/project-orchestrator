# Portable JSON and Markdown Export Design

## Decision

SQLite and the content-addressed object store remain the source of truth. The
Web console adds read-only, generated exports for a single Run and for a
project's memory records. Exporting never writes a second durable copy back to
the database and never changes Run state.

## User-visible scope

### Run detail

The Run detail header gains an **Export** menu with two downloads:

- `run-<id>.json` — complete machine-readable Run projection.
- `run-<id>.md` — human-readable handoff and audit report.

Both include the frozen workflow snapshot, stage state, attempts, iteration
history, evidence indexes, confirmations, managed side-effect records, memories,
and the ordered event timeline. Artifact bodies remain separate safe downloads;
the export contains their content hash, size, media type, provenance, and source
path but does not inline active content.

### Project memory

The project-memory page gains the same JSON and Markdown actions. When a project
filter is present the export contains that project's records. With no project
filter, the export contains the currently visible cross-project index and is
named `project-memories.*`.

## Export contracts

### JSON

Every JSON file uses an explicit envelope:

```json
{
  "schema_id": "project-orchestrator/run-export",
  "schema_version": 1,
  "exported_at": "2026-08-28T00:00:00.000Z",
  "data": {}
}
```

Run exports contain `run`, `workflow_snapshot`, `stages`, `attempts`,
`iterations`, `artifacts`, `confirmations`, `side_effects`, `memories`, and
`events`. Memory exports use `project_filter` and `memories`. JSON is formatted
with two-space indentation and a trailing newline so it is readable and Git
friendly.

### Markdown

Markdown is derived from the same in-memory projection as JSON. It contains a
short trust notice, identifiers, stage/attempt tables, evidence and file-change
sections, decisions/memories, risks or failures, and the ordered event timeline.
All saved business text is rendered as plain Markdown text; export generation
does not interpret it as instructions.

## Security boundary

- Export routes stay under `/api/read/*` and accept GET only.
- Existing public-host account and LAN trust checks apply unchanged.
- Responses use `Content-Disposition: attachment`, `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`, and a fixed media type.
- The projection is allow-listed. It excludes Web users, session secrets,
  cookies, CSRF tokens, adapter credentials, lease tokens, recovery credentials,
  confirmation nonces, internal object storage keys, and operation parameters.
- Event payloads are excluded because they can contain adapter- or
  operation-specific input. The timeline exports only event identity, type,
  stage, sequence, source principal, and timestamp.
- Artifact contents are never embedded. CAS metadata is joined by object id to
  provide a verifiable SHA-256 digest without exposing the storage key.

## Data and failure behavior

No migration or new table is required. Each request reads a consistent SQLite
snapshot inside a deferred transaction, verifies referenced CAS objects before
reporting their hashes, then renders the selected format. Missing Run ids return
404. Unsupported formats return 400. A missing or corrupted referenced CAS
object fails closed with 500 rather than producing a misleading complete report.

## Compatibility

The v1 JSON schema is append-only: future readers must ignore unknown fields.
Import is deliberately out of scope for this slice. A later importer must verify
schema id/version, hashes, ownership, and conflicts rather than treating an
export as trusted executable policy.

## Acceptance criteria

1. A signed-in public user and a trusted LAN user can download both formats.
2. Run JSON and Markdown represent the same allow-listed evidence.
3. Project-filtered memory exports contain no other project's records.
4. Exported files contain no credential, session, lease, nonce, or CAS storage
   key fields.
5. No database row, Run state, or CAS object is created by an export.
6. Web continues to expose no Run execution, retry, confirmation, or deployment
   action.

