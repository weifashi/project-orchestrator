# Portable JSON and Markdown Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe JSON and Markdown downloads for a Run and for project memories while SQLite/CAS remain the only source of truth.

**Architecture:** A pure export projection module reads allow-listed SQLite rows and verified CAS metadata, then renders one versioned JSON envelope or Markdown report. GET-only `/api/read/*` routes return attachments, and the existing Web client exposes URL builders rather than a generic mutation-capable API.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, React, Vitest, Playwright.

---

## File map

- Create `apps/control-server/src/http/export.ts`: allow-listed projections and JSON/Markdown renderers.
- Modify `apps/control-server/src/http/routes/read.ts`: two authenticated read-only attachment routes.
- Modify `apps/web-console/src/api/client.ts`: constrained export URL builders.
- Modify `apps/web-console/src/pages/run-detail.tsx`: Run export menu.
- Modify `apps/web-console/src/pages/memories.tsx`: memory export menu.
- Modify `apps/web-console/src/i18n.tsx`: Chinese and English export labels.
- Modify `tests/integration/web-agent-isolation.integration.test.ts`: export security and content tests.
- Modify `apps/web-console/test/client.test.ts`: API surface test.
- Modify `apps/web-console/test/run-detail.test.tsx`: visible download actions and no Run control.
- Create `apps/web-console/test/memories.test.tsx`: filtered memory export behavior.

## Task 1: Define the export evidence contract in tests

- [ ] Add an integration fixture containing one Run, frozen workflow, stage,
  attempt, artifact/CAS metadata, memory, confirmation, operation, and event.
- [ ] Assert JSON schema id/version, allow-listed sections, verified artifact
  SHA-256, attachment headers, and absence of secret/nonce/storage-key fields.
- [ ] Assert Markdown contains the objective, stage/evidence summaries and trust
  notice, while omitting event payloads and active artifact bodies.
- [ ] Assert project-filtered memory exports exclude every other project.
- [ ] Assert unsupported format is 400, missing Run is 404, and export performs
  no database or CAS writes.

## Task 2: Implement a single projection and two renderers

- [ ] Create `export.ts` with `buildRunExport`, `buildMemoryExport`,
  `renderJsonExport`, `renderRunMarkdown`, and `renderMemoryMarkdown`.
- [ ] Use explicit SELECT column lists. Join artifact rows to `content_objects`
  for hash/media/size while excluding `storage_key` and artifact body bytes.
- [ ] Parse frozen workflow, changed-file manifests, and output envelopes only
  from verified CAS objects. Keep event payloads out of the export contract.
- [ ] Escape Markdown table cells and headings so saved business text cannot
  corrupt the generated report structure.

## Task 3: Add safe read-only download routes

- [ ] Add `GET /api/read/run-export/:id?format=json|markdown`.
- [ ] Add `GET /api/read/memory-export?project_id=<id>&format=json|markdown`.
- [ ] Set fixed attachment filenames, `no-store`, `nosniff`, and media types.
- [ ] Do not add POST routes, CSRF exceptions, or any runtime-control surface.

## Task 4: Add constrained Web download actions

- [ ] Add `runs.exportUrl(id, format)` and
  `memories.exportUrl(projectId, format)` to the named API client surface.
- [ ] Add compact JSON/Markdown links to the Run detail header.
- [ ] Add compact JSON/Markdown links to the memory page and preserve its
  project filter in the URL.
- [ ] Add matching Chinese and English labels without translating saved business
  text or identifiers.

## Task 5: Run one final verification batch

- [ ] Run `pnpm lint`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm test:integration`.
- [ ] Run `pnpm test:e2e`.
- [ ] Run `pnpm build`, `pnpm validate:skills`, `pnpm validate:plugins`,
  `pnpm check:generated`, `pnpm diff-check`, and `pnpm test:install`.
- [ ] Confirm Git diff contains no database migration, secret value, new Run
  control route, or external network dependency.

