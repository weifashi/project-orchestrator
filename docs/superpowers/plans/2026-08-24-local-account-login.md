# Local Account Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Web-token bootstrap with first-admin registration and password login backed by local SQLite.

**Architecture:** SQLite owns the user and hashed opaque sessions. `web-auth.ts` owns scrypt, validation, throttling and session lifecycle; Fastify only maps these decisions to HTTP pages and cookies. Existing Web boundaries remain unchanged.

**Tech Stack:** Node 22 `crypto.scrypt`, better-sqlite3, Fastify, React/Vite, Vitest, Playwright.

---

### Task 1: Persist accounts and sessions
- [ ] Write failing integration test: first registration creates an opaque session, a second registration throws `REGISTRATION_CLOSED`, and database rows contain no plaintext password/token.
- [ ] Run `pnpm exec vitest run --project integration tests/integration/web-auth.integration.test.ts`; expected RED because migration/service do not exist.
- [ ] Create `packages/sqlite-store/migrations/003_web_auth.sql` with `web_users` and `web_sessions`; create `apps/control-server/src/http/web-auth.ts` with `registerFirstUser`, `login`, `session`, `logout` and scrypt/SHA-256 helpers.
- [ ] Re-run focused test; expected GREEN.

### Task 2: Account HTTP gate
- [ ] Change `apps/control-server/src/http/web-listener.ts`, `config.ts`, and `runtime.ts`; add registration, login and logout endpoints; replace random in-memory cookie with persisted session lookup.
- [ ] Change `allowedOrigin` into exact `allowedOrigins`, keeping both public origins only.
- [ ] Update `tests/integration/web-agent-isolation.integration.test.ts` and `tests/integration/web-static-security.integration.test.ts` first; assert unauthenticated default deny, per-session CSRF, secure cookie and no token field.
- [ ] Run focused integration tests to RED then GREEN.

### Task 3: Account-first n8n-style UI and browser coverage
- [ ] Render compact graphite/coral registration and login pages with 44px fields/buttons, visible labels, inline errors and no token text.
- [ ] Add `tests/e2e/web-auth.spec.ts`: first visit registers, redirects to console, later visit shows login, and phone/desktop have no horizontal/document scrollbar.
- [ ] Run `pnpm exec playwright test tests/e2e/web-auth.spec.ts tests/e2e/web-responsive.spec.ts --reporter=line`; expected GREEN.

### Task 4: Release and rollout
- [ ] Bump release version, update README recovery instructions and remove token instructions.
- [ ] Run `CI=true pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build && pnpm diff-check && pnpm release`.
- [ ] Install via `coder ssh wfs`, restart `project-orchestrator-weifashi.service`, verify both public origins show account page, then push the branch.
