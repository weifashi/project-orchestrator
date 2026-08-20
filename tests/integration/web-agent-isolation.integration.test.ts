import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ContentStore } from "@project-orchestrator/content-store";
import { migrate, openDatabase } from "@project-orchestrator/sqlite-store";
import { buildWebListener } from "@project-orchestrator/control-server";

const dirs: string[] = [];
afterEach(() =>
  dirs.splice(0).forEach((directory) =>
    rmSync(directory, { recursive: true, force: true }),
  ),
);

async function bootstrap(app: ReturnType<typeof buildWebListener>, token: string) {
  const response = await app.inject({
    method: "POST",
    url: "/bootstrap",
    headers: {
      host: "127.0.0.1",
      origin: "http://127.0.0.1:3847",
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: new URLSearchParams({ token }).toString(),
  });
  expect(response.statusCode).toBe(302);
  return String(response.headers["set-cookie"]).split(";", 1)[0]!;
}

it("isolates Web config/read surface from all runtime control and enforces origin/csrf/default deny", async () => {
  const dir = mkdtempSync(join(tmpdir(), "web-int-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "db"));
  migrate(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO workflow_templates(id,slug,name,task_type,status,created_at,updated_at) VALUES('a','a','A','feature','active',?,?)",
  ).run(now, now);
  const app = buildWebListener({
    db,
    content: new ContentStore(join(dir, "objects"), db),
    webToken: "web",
    csrfToken: "csrf",
    allowedOrigin: "http://127.0.0.1:3847",
  });
  const base = {
    host: "127.0.0.1",
    cookie: await bootstrap(app, "web"),
    origin: "http://127.0.0.1:3847",
  };
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/config/workflow-drafts/a",
        headers: base,
        payload: {},
      })
    ).statusCode,
  ).toBe(403);
  const save = await app.inject({
    method: "POST",
    url: "/api/config/workflow-drafts/a",
    headers: { ...base, "x-csrf-token": "csrf" },
    payload: { expected_revision: 0, envelope: { draft: true } },
  });
  expect(save.statusCode).toBe(200);
  expect(save.json()).toEqual({ revision: 1 });
  expect(
    db
      .prepare(
        "SELECT revision FROM workflow_drafts WHERE workflow_template_id='a'",
      )
      .get(),
  ).toEqual({ revision: 1 });
  for (const route of [
    "/api/run/create",
    "/api/confirmation/submit",
    "/api/operation/execute",
  ])
    expect(
      (
        await app.inject({
          method: "POST",
          url: route,
          headers: { ...base, "x-csrf-token": "csrf" },
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  expect(
    (
      await app.inject({
        method: "GET",
        url: "/api/read/system/status",
        headers: { ...base, origin: "https://evil.invalid" },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: "GET",
        url: "/api/read/system/status",
        headers: { ...base, cookie: "po_session=adapter" },
      })
    ).statusCode,
  ).toBe(403);
  await app.close();
  db.close();
});

it("exchanges the Web token for an independent opaque session cookie", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cookie-int-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "db"));
  migrate(db);
  const token = "web token+/=";
  const app = buildWebListener({
    db,
    content: new ContentStore(join(dir, "objects"), db),
    webToken: token,
    csrfToken: "csrf",
    allowedOrigin: "http://127.0.0.1:3847",
  });
  const cookie = await bootstrap(app, token);
  expect(cookie).not.toContain(Buffer.from(token).toString("base64url"));
  const response = await app.inject({
    method: "GET",
    url: "/api/read/system/status",
    headers: { host: "127.0.0.1", cookie },
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers["set-cookie"]).toContain(`${cookie};`);
  await app.close();
  db.close();
});
