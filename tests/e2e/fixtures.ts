import type { Page } from "@playwright/test";
const generic = {
  schema_id: "project-orchestrator/generic",
  schema_version: 1,
  data: { type: "object" },
};
export const workflow = {
  entity_id: "workflow-1",
  revision: 1,
  updated_at: "2026-08-20T00:00:00Z",
  envelope: {
    schema_id: "project-orchestrator/workflow-version",
    schema_version: 1,
    data: {
      slug: "feature-development",
      version: 2,
      stages: [
        {
          key: "implementation",
          role_version_id: "role-v1",
          optional: false,
          mandatory_gate: false,
          failure_policy: "fail",
          max_attempts: 1,
          requires_confirmation: false,
        },
        {
          key: "testing",
          role_version_id: "role-v2",
          optional: false,
          mandatory_gate: true,
          failure_policy: "retry_then_fail",
          max_attempts: 2,
          requires_confirmation: false,
        },
      ],
      edges: [{ from: "implementation", to: "testing", edge_type: "requires" }],
      iteration_groups: [],
    },
  },
};
export const role = {
  entity_id: "role-testing",
  revision: 1,
  updated_at: "2026-08-20T00:00:00Z",
  envelope: {
    schema_id: "project-orchestrator/role-version",
    schema_version: 1,
    data: {
      slug: "testing",
      display_name: "Testing",
      responsibilities: ["Verify"],
      requested_capabilities: ["read-workspace"],
      forbidden_capabilities: ["production-shell"],
      input_schema: generic,
      output_schema: generic,
      completion_contract: {
        schema_id: "completion",
        schema_version: 1,
        data: {},
      },
      body_markdown: "# Testing",
    },
  },
};
const run = {
  id: "run-1",
  project_id: "p1",
  project_name: "Project",
  objective: "Build console",
  workflow_version_id: "wv1",
  workflow_name: "Feature Development",
  origin_client_type: "codex",
  status: "waiting_for_user",
  active_stages: ["testing", "security"],
  started_at: "2026-08-20T00:00:00Z",
  updated_at: "2026-08-20T00:01:00Z",
  completed_at: null,
  failure_code: null,
  failure_summary: null,
  is_retryable: 0,
};
export async function mockApi(page: Page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path === "/api/read/session")
      return route.fulfill({ json: { csrf_token: "e2e-csrf" } });
    if (path === "/api/read/system/diagnostics")
      return route.fulfill({
        json: {
          status: "ok",
          version: "0.0.0",
          database_path: "/tmp/db",
          cas_status: "verified",
          content_objects: 3,
          last_backup_at: null,
          web_listener: "127.0.0.1 · listening",
          control_socket: "Unix socket · listening",
          adapters: [],
          run_counts: { waiting_for_user: 1 },
        },
      });
    if (path === "/api/read/runs") return route.fulfill({ json: [run] });
    if (path === "/api/read/runs/run-1")
      return route.fulfill({
        json: {
          ...run,
          snapshot: { workflow_object_id: "o1" },
          stages: [
            {
              id: "s1",
              stage_key: "testing",
              iteration_number: 0,
              role_version_id: "rv1",
              status: "running",
            },
          ],
          attempts: [
            {
              id: "a1",
              attempt_number: 1,
              status: "running",
              started_at: "2026-08-20T00:00:00Z",
              changed_files_object_id: "files1",
            },
          ],
          iterations: [],
          artifacts: [
            {
              id: "art1",
              run_id: "run-1",
              artifact_type: "test_evidence",
              source_path: "test.html",
              summary: "tests passed",
              created_at: "2026-08-20T00:00:00Z",
            },
          ],
          confirmations: [{ id: "c1", status: "pending" }],
          side_effects: [{ id: "op1", status: "unknown" }],
          memories: [],
          events: [
            {
              id: "e1",
              run_id: "run-1",
              stage_run_id: null,
              sequence_number: 1,
              event_type: "run_created",
              payload_envelope: {},
              created_at: "2026-08-20T00:00:00Z",
            },
          ],
        },
      });
    if (path === "/api/read/events/run-1") return route.fulfill({ json: [] });
    if (path === "/api/stream/events") return route.abort();
    if (path === "/api/read/workflows")
      return route.fulfill({
        json: [
          {
            id: "workflow-1",
            slug: "feature-development",
            name: "Feature Development",
            task_type: "feature",
            status: "active",
            current_version_id: "wv1",
            version_number: 1,
            stage_count: 2,
            updated_at: "2026-08-20T00:00:00Z",
          },
        ],
      });
    if (path === "/api/read/workflow-drafts/workflow-1")
      return route.fulfill({ json: workflow });
    if (path === "/api/config/workflow-drafts/workflow-1")
      return route.fulfill({ json: { revision: 2 } });
    if (path === "/api/config/workflows/workflow-1/publish")
      return route.fulfill({ json: { id: "wv2", versionNumber: 2 } });
    if (path === "/api/read/roles")
      return route.fulfill({
        json: Array.from({ length: 10 }, (_, i) => ({
          id: i === 0 ? "role-testing" : `role-${i}`,
          slug: [
            "requirements",
            "research",
            "architecture",
            "ui-design",
            "implementation",
            "code-review",
            "testing",
            "security",
            "operations",
            "memory-docs",
          ][i],
          name: [
            "Requirements",
            "Research",
            "Architecture",
            "UI",
            "Implementation",
            "Code review",
            "Testing",
            "Security",
            "Operations",
            "Memory docs",
          ][i],
          status: "active",
          current_version_id: `rv${i}`,
          version_number: 1,
          updated_at: "2026-08-20T00:00:00Z",
          effective_capabilities: ["read-workspace"],
        })),
      });
    if (path === "/api/read/role-drafts/role-testing")
      return route.fulfill({ json: role });
    if (path === "/api/config/role-drafts/role-testing")
      return route.fulfill({ json: { revision: 2 } });
    if (path === "/api/config/roles/role-testing/publish")
      return route.fulfill({
        json: {
          id: "rv2",
          versionNumber: 2,
          effectiveCapabilities: ["read-workspace"],
        },
      });
    if (path === "/api/read/memories") return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  await bootstrap(page);
}
export async function bootstrap(page: Page) {
  await page.goto("/bootstrap");
  await page.evaluate(() => window.localStorage.setItem("po-locale", "zh-CN"));
  if (await page.getByLabel("账号名").count() === 0) {
    await page.goto("/");
    return;
  }
  await page.getByLabel("账号名").fill("owner");
  await page.getByLabel("密码").fill("twelve-char-password");
  await Promise.all([
    page.waitForURL("**/"),
    page.getByRole("button", { name: "登录" }).click(),
  ]);
}
export function guardNetwork(page: Page) {
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/(run-control|confirmations|operations)/.test(path))
      throw new Error(
        `forbidden Web request ${request.method()} ${request.url()}`,
      );
  });
}
