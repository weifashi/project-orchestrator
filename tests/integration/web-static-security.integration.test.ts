import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ContentStore } from "@project-orchestrator/content-store";
import { buildWebListener } from "@project-orchestrator/control-server";
import { migrate, openDatabase } from "@project-orchestrator/sqlite-store";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

it("serves account-first bootstrap and keeps static pages behind a secure opaque session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "web-static-"));
  directories.push(directory);
  const db = openDatabase(join(directory, "db.sqlite"));
  migrate(db);
  const staticDirectory = join(directory, "web");
  mkdirSync(join(staticDirectory, "assets"), { recursive: true });
  writeFileSync(join(staticDirectory, "index.html"), '<meta name="csrf-token" content="__PO_CSRF_TOKEN__"><div id="root"></div>');
  writeFileSync(join(staticDirectory, "assets", "app-abc123.js"), 'console.log("local")');
  const coderOrigin = "https://3847--main--wfs--weifashi.coder.example";
  const publicOrigin = "https://orchestrator.co.weifashi.example";
  const app = buildWebListener({ db, content: new ContentStore(join(directory, "objects"), db), sessionSecret: "csrf-secret", allowedOrigins: [coderOrigin, publicOrigin], allowedHosts: ["3847--main--wfs--weifashi.coder.example", "orchestrator.co.weifashi.example"], staticDirectory });
  const host = "3847--main--wfs--weifashi.coder.example";

  const registration = await app.inject({ method: "GET", url: "/bootstrap", headers: { host } });
  expect(registration.statusCode).toBe(200);
  expect(registration.body).toContain("创建管理员账号");
  // 登录页是服务端内联渲染的，不走 SPA 的 index.html；两边的 favicon 各写一份，
  // 这里交叉校验防止只改一边导致登录前后标签页图标不一致。
  const spaIndex = readFileSync(new URL("../../apps/web-console/index.html", import.meta.url), "utf8");
  const spaFavicon = /href="(data:image\/svg\+xml,[^"]+)"/.exec(spaIndex)?.[1];
  expect(spaFavicon).toBeTruthy();
  expect(registration.body).toContain(`<link rel="icon" type="image/svg+xml" href="${spaFavicon}">`);
  expect(registration.body).not.toContain("Web token");
  expect(registration.body).not.toContain('name="password" type="password" autocomplete="new-password" required minlength');
  expect(registration.body).not.toContain('name="confirm_password" type="password" autocomplete="new-password" required minlength');
  const englishRegistration = await app.inject({ method: "GET", url: "/bootstrap?lang=en", headers: { host, "accept-language": "zh-CN" } });
  expect(englishRegistration.body).toContain("Create administrator account");
  expect(englishRegistration.body).toContain('lang="en"');
  const cspNonce = String(registration.headers["content-security-policy"]).match(/style-src 'self' 'nonce-([A-Za-z0-9_-]+)'/)?.[1];
  const styleNonce = registration.body.match(/<style nonce="([A-Za-z0-9_-]+)">/)?.[1];
  expect(cspNonce).toBe(styleNonce);
  expect((await app.inject({ method: "GET", url: "/bootstrap", headers: { host: "orchestrator.co.weifashi.example", origin: publicOrigin } })).statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: "/bootstrap", headers: { host, origin: "https://evil.example" } })).statusCode).toBe(403);
  const created = await app.inject({
    method: "POST", url: "/bootstrap/register",
    headers: { host, origin: coderOrigin, "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ username: "owner", password: "twelve-char-password", confirm_password: "twelve-char-password" }).toString(),
  });
  expect(created.statusCode).toBe(302);
  expect(created.headers.location).toBe("/");
  const cookie = String(created.headers["set-cookie"]).split(";", 1)[0]!;
  expect(String(created.headers["set-cookie"])).toContain("HttpOnly; SameSite=Strict; Path=/; Secure");
  expect(cookie).not.toContain("twelve-char-password");
  expect((await app.inject({ method: "GET", url: "/bootstrap", headers: { host } })).body).toContain("欢迎回来");
  const unauthenticatedPage = await app.inject({ method: "GET", url: "/workflows", headers: { host } });
  expect(unauthenticatedPage.statusCode).toBe(302);
  expect(unauthenticatedPage.headers.location).toBe("/bootstrap");
  expect((await app.inject({ method: "GET", url: "/api/read/system/status", headers: { host } })).json()).toEqual({ error: "unauthorized" });
  const page = await app.inject({ method: "GET", url: "/runs/example", headers: { host, cookie } });
  expect(page.statusCode).toBe(200);
  expect(page.body).toContain('__PO_CSRF_TOKEN__');
  const authenticatedBootstrap = await app.inject({ method: "GET", url: "/bootstrap", headers: { host, cookie } });
  expect(authenticatedBootstrap.statusCode).toBe(302);
  expect(authenticatedBootstrap.headers.location).toBe("/");
  const session = await app.inject({ method: "GET", url: "/api/read/session", headers: { host, cookie } });
  expect(session.json().csrf_token).toHaveLength(43);
  const asset = await app.inject({ method: "GET", url: "/assets/app-abc123.js", headers: { host, cookie } });
  expect(asset.statusCode).toBe(200);
  expect(asset.headers["cache-control"]).toContain("immutable");
  const logout = await app.inject({ method: "POST", url: "/logout", headers: { host, origin: coderOrigin, cookie } });
  expect(logout.statusCode).toBe(302);
  expect(String(logout.headers["set-cookie"])).toContain("Max-Age=0");
  expect((await app.inject({ method: "GET", url: "/api/read/system/status", headers: { host, cookie } })).statusCode).toBe(403);
  await app.close(); db.close();
});
