import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ContentStore } from "@project-orchestrator/content-store";
import {
  buildWebListener,
  ensureWebCredentials,
  rotateWebCredentials,
} from "@project-orchestrator/control-server";
import { migrate, openDatabase } from "@project-orchestrator/sqlite-store";
const directories: string[] = [];
afterEach(() =>
  directories
    .splice(0)
    .forEach((directory) =>
      rmSync(directory, { recursive: true, force: true }),
    ),
);
it("bootstraps an HttpOnly local session and serves SPA assets under a closed CSP", async () => {
  const directory = mkdtempSync(join(tmpdir(), "web-static-"));
  directories.push(directory);
  const db = openDatabase(join(directory, "db.sqlite"));
  migrate(db);
  const content = new ContentStore(join(directory, "objects"), db),
    staticDirectory = join(directory, "web");
  mkdirSync(join(staticDirectory, "assets"), { recursive: true });
  writeFileSync(
    join(staticDirectory, "index.html"),
    '<meta name="csrf-token" content="__PO_CSRF_TOKEN__"><div id="root"></div>',
  );
  writeFileSync(
    join(staticDirectory, "assets", "app-abc123.js"),
    'console.log("local")',
  );
  const app = buildWebListener({
    db,
    content,
    webToken: "secret web token",
    csrfToken: "csrf-secret",
    allowedOrigin: "http://127.0.0.1:3847",
    staticDirectory,
  });
  const unauthenticated = await app.inject({
    method: "GET",
    url: "/runs/example",
    headers: { host: "127.0.0.1" },
  });
  expect(unauthenticated.statusCode).toBe(403);
  expect(unauthenticated.headers["set-cookie"]).toBeUndefined();
  const login = await app.inject({
    method: "GET",
    url: "/bootstrap",
    headers: { host: "127.0.0.1" },
  });
  expect(login.statusCode).toBe(200);
  expect(login.body).not.toContain("secret web token");
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/bootstrap",
        headers: {
          host: "127.0.0.1",
          origin: "http://127.0.0.1:3847",
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: "token=wrong",
      })
    ).statusCode,
  ).toBe(403);
  const bootstrap = await app.inject({
    method: "POST",
    url: "/bootstrap",
    headers: {
      host: "127.0.0.1",
      origin: "http://127.0.0.1:3847",
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: "token=secret+web+token",
  });
  expect(bootstrap.statusCode).toBe(302);
  expect(bootstrap.headers.location).toBe("/");
  expect(bootstrap.headers["set-cookie"]).toMatch(/HttpOnly; SameSite=Strict/);
  const cookie = String(bootstrap.headers["set-cookie"]).split(";", 1)[0];
  expect(cookie).not.toContain(
    Buffer.from("secret web token").toString("base64url"),
  );
  const page = await app.inject({
    method: "GET",
    url: "/runs/example",
    headers: { host: "127.0.0.1", cookie },
  });
  expect(page.statusCode).toBe(200);
  expect(page.body).toContain('content="csrf-secret"');
  expect(page.headers["content-security-policy"]).toContain(
    "connect-src 'self'",
  );
  expect(page.headers["content-security-policy"]).toContain(
    "object-src 'none'",
  );
  const asset = await app.inject({
    method: "GET",
    url: "/assets/app-abc123.js",
    headers: { host: "127.0.0.1", cookie },
  });
  expect(asset.statusCode).toBe(200);
  expect(asset.headers["cache-control"]).toContain("immutable");
  const session = await app.inject({
    method: "GET",
    url: "/api/read/session",
    headers: { host: "127.0.0.1", cookie },
  });
  expect(session.json()).toEqual({ csrf_token: "csrf-secret" });
  expect(
    (
      await app.inject({
        method: "GET",
        url: "/api/not-real",
        headers: { host: "127.0.0.1" },
      })
    ).statusCode,
  ).toBe(403);
  await app.close();
  db.close();
});

it("generates private Web credentials on first install and rotates both values", () => {
  const directory = mkdtempSync(join(tmpdir(), "web-credentials-"));
  directories.push(directory);
  const path = join(directory, "web-token");
  ensureWebCredentials(path);
  const first = [
    readFileSync(path, "utf8"),
    readFileSync(`${path}.csrf`, "utf8"),
  ];
  expect(first[0]).not.toBe(first[1]);
  expect(statSync(path).mode & 0o077).toBe(0);
  expect(statSync(`${path}.csrf`).mode & 0o077).toBe(0);
  rotateWebCredentials({
    PROJECT_ORCHESTRATOR_DATA: directory,
    PROJECT_ORCHESTRATOR_WEB_TOKEN_FILE: path,
  });
  expect(readFileSync(path, "utf8")).not.toBe(first[0]);
  expect(readFileSync(`${path}.csrf`, "utf8")).not.toBe(first[1]);
});
