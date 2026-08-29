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

async function register(app: ReturnType<typeof buildWebListener>) {
  const response = await app.inject({
    method: "POST", url: "/bootstrap/register",
    headers: { host: "127.0.0.1", origin: "http://127.0.0.1:3847", "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ username: "owner", password: "twelve-char-password", confirm_password: "twelve-char-password" }).toString(),
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
    sessionSecret: "csrf",
    allowedOrigins: ["http://127.0.0.1:3847"],
  });
  const base = {
    host: "127.0.0.1",
    cookie: await register(app),
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
    headers: { ...base, "x-csrf-token": (await app.inject({ method: "GET", url: "/api/read/session", headers: base })).json().csrf_token },
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
          headers: { ...base, "x-csrf-token": (await app.inject({ method: "GET", url: "/api/read/session", headers: base })).json().csrf_token },
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

it("uses a stored account session instead of accepting a legacy bootstrap token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cookie-int-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "db"));
  migrate(db);
  const app = buildWebListener({ db, content: new ContentStore(join(dir, "objects"), db), sessionSecret: "csrf", allowedOrigins: ["http://127.0.0.1:3847"] });
  expect((await app.inject({ method: "GET", url: "/bootstrap", headers: { host: "127.0.0.1" } })).body).toContain("创建管理员账号");
  const cookie = await register(app);
  const login = await app.inject({ method: "GET", url: "/bootstrap", headers: { host: "127.0.0.1" } });
  expect(login.body).toContain("欢迎回来");
  expect((await app.inject({ method: "POST", url: "/bootstrap", headers: { host: "127.0.0.1", "content-type": "application/x-www-form-urlencoded" }, payload: "token=legacy" })).statusCode).toBe(405);
  expect((await app.inject({ method: "GET", url: "/api/read/system/status", headers: { host: "127.0.0.1", cookie } })).statusCode).toBe(200);
  await app.close(); db.close();
});

it("requires an account only on public hosts while allowing trusted LAN access", async () => {
  const dir = mkdtempSync(join(tmpdir(), "web-lan-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "db"));
  migrate(db);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO workflow_templates(id,slug,name,task_type,status,created_at,updated_at) VALUES('lan','lan','LAN','feature','active',?,?)")
    .run(now, now);
  const publicOrigin = "https://3847--main--wfs--weifashi.coder.example";
  const lanOrigin = "http://192.168.1.20:3847";
  const app = buildWebListener({
    db,
    content: new ContentStore(join(dir, "objects"), db),
    sessionSecret: "csrf",
    allowedOrigins: [publicOrigin],
    allowedHosts: ["127.0.0.1", "192.168.1.20", "3847--main--wfs--weifashi.coder.example"],
    lanOrigins: [lanOrigin],
  });

  expect((await app.inject({ method: "GET", url: "/api/read/system/status", headers: { host: "3847--main--wfs--weifashi.coder.example" } })).statusCode).toBe(403);
  const lan = { host: "192.168.1.20" };
  expect((await app.inject({ method: "GET", url: "/api/read/system/status", headers: lan })).statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: "/api/read/system/status", headers: { host: "192.168.1.20" }, remoteAddress: "192.168.1.23" })).statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: "/api/read/session", headers: lan })).json()).toEqual({ csrf_token: "lan-bypass" });
  expect((await app.inject({
    method: "POST", url: "/api/config/workflow-drafts/lan", headers: lan,
    payload: { expected_revision: 0, envelope: { draft: true } },
  })).statusCode).toBe(403);
  expect((await app.inject({
    method: "POST", url: "/api/config/workflow-drafts/lan", headers: { ...lan, origin: lanOrigin },
    payload: { expected_revision: 0, envelope: { draft: true } },
  })).statusCode).toBe(200);

  await app.close();
  db.close();
});

it("keeps LAN access account-free only for explicitly configured hosts and origins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "web-lan-boundary-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "db"));
  migrate(db);
  const publicOrigin = "https://3847--main--wfs--weifashi.coder.example";
  const lanOrigin = "http://192.168.1.20:3847";
  const app = buildWebListener({
    db,
    content: new ContentStore(join(dir, "objects"), db),
    sessionSecret: "csrf",
    allowedOrigins: [publicOrigin],
    allowedHosts: ["3847--main--wfs--weifashi.coder.example", "192.168.1.20"],
    lanOrigins: [lanOrigin],
  });
  const source = "192.168.1.23";
  const roleBody = {
    slug: "release-notes",
    display_name: "Release Notes",
    responsibilities: ["Summarise the release"],
    requested_capabilities: ["read-workspace"],
  };

  expect((await app.inject({ method: "GET", url: "/api/read/system/status", headers: { host: "evil.example", origin: "https://evil.example" }, remoteAddress: source })).statusCode).toBe(403);
  expect((await app.inject({ method: "GET", url: "/api/read/system/status", headers: { host: "3847--main--wfs--weifashi.coder.example" }, remoteAddress: source })).statusCode).toBe(403);
  expect((await app.inject({ method: "GET", url: "/api/read/system/status", headers: { host: "192.168.1.20" }, remoteAddress: source })).statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: "/api/config/roles", headers: { host: "192.168.1.20" }, payload: roleBody, remoteAddress: source })).statusCode).toBe(403);
  expect((await app.inject({ method: "POST", url: "/api/config/roles", headers: { host: "192.168.1.20", origin: "https://evil.example" }, payload: roleBody, remoteAddress: source })).statusCode).toBe(403);
  expect(db.prepare("SELECT COUNT(*) AS count FROM roles WHERE slug='release-notes'").get()).toEqual({ count: 0 });

  const created = await app.inject({ method: "POST", url: "/api/config/roles", headers: { host: "192.168.1.20", origin: lanOrigin }, payload: roleBody, remoteAddress: source });
  expect(created.statusCode).toBe(200);
  const roleId = created.json().roleId as string;
  const removed = await app.inject({ method: "DELETE", url: `/api/config/roles/${roleId}`, headers: { host: "192.168.1.20", origin: lanOrigin }, payload: {}, remoteAddress: source });
  expect(removed.statusCode).toBe(200);
  expect(db.prepare("SELECT removed_at FROM roles WHERE id=?").get(roleId)).toEqual({ removed_at: expect.any(String) });
  const restored = await app.inject({ method: "POST", url: `/api/config/roles/${roleId}/restore`, headers: { host: "192.168.1.20", origin: lanOrigin }, payload: {}, remoteAddress: source });
  expect(restored.statusCode).toBe(200);
  expect(db.prepare("SELECT removed_at FROM roles WHERE id=?").get(roleId)).toEqual({ removed_at: null });

  expect((await app.inject({ method: "GET", url: "/api/read/session", headers: { host: "evil.example" }, remoteAddress: source })).statusCode).toBe(403);
  expect((await app.inject({ method: "GET", url: "/api/read/session", headers: { host: "192.168.1.20" }, remoteAddress: source })).json()).toEqual({ csrf_token: "lan-bypass" });
  expect((await app.inject({ method: "GET", url: "/api/read/system/status", headers: { host: "192.168.1.20", "x-forwarded-for": "127.0.0.1" }, remoteAddress: "203.0.113.42" })).statusCode).toBe(403);

  await app.close();
  db.close();
});

it("keeps the passwordless bypass on the loopback deployment it was configured for", async () => {
  const dir = mkdtempSync(join(tmpdir(), "web-loopback-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "db.sqlite"));
  migrate(db);
  // 默认安装的形态：绑 0.0.0.0，但只配了回环 lan origin。
  const app = buildWebListener({
    db,
    content: new ContentStore(join(dir, "objects"), db),
    sessionSecret: "session-secret",
    allowedOrigins: ["https://public.example"],
    allowedHosts: ["127.0.0.1", "localhost"],
    lanOrigins: ["http://127.0.0.1:3847", "http://localhost:3847"],
  });
  const status = "/api/read/system/status";

  // 本机免登录照旧可用。
  expect((await app.inject({ method: "GET", url: status, headers: { host: "127.0.0.1" }, remoteAddress: "127.0.0.1" })).statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: status, headers: { host: "localhost" }, remoteAddress: "::1" })).statusCode).toBe(200);

  // 局域网机器伪造 Host: localhost 不再跳过鉴权 —— Host 头是客户端自填的，不能当凭据。
  for (const remoteAddress of ["192.168.1.23", "10.0.0.7", "172.20.5.9", "::ffff:192.168.1.23"]) {
    expect((await app.inject({ method: "GET", url: status, headers: { host: "localhost" }, remoteAddress })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: status, headers: { host: "127.0.0.1" }, remoteAddress })).statusCode).toBe(403);
  }
  // 写操作同样挡住，即便带上合法的 lan origin。
  expect((await app.inject({
    method: "POST", url: "/api/config/roles",
    headers: { host: "localhost", origin: "http://127.0.0.1:3847" },
    payload: { slug: "intruder", display_name: "Intruder", responsibilities: ["x"], requested_capabilities: [] },
    remoteAddress: "192.168.1.23",
  })).statusCode).toBe(403);
  expect(db.prepare("SELECT count(*) AS count FROM roles WHERE slug='intruder'").get()).toEqual({ count: 0 });

  await app.close();
  db.close();
});
