import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { migrate, openDatabase } from "@project-orchestrator/sqlite-store";
import { createWebAuth } from "@project-orchestrator/control-server";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

it("creates exactly one first administrator and stores no plaintext authentication secrets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "web-auth-"));
  directories.push(directory);
  const db = openDatabase(join(directory, "orchestrator.sqlite"));
  migrate(db);
  const auth = createWebAuth(db, "test csrf key");
  const created = await auth.registerFirstUser({
    username: "owner",
    password: "short",
  });

  expect(created.sessionToken).toHaveLength(43);
  expect(created.csrfToken).toHaveLength(43);
  await expect(auth.registerFirstUser({ username: "other", password: "twelve-char-password" }))
    .rejects.toThrow("REGISTRATION_CLOSED");
  expect(db.prepare("SELECT username,password_hash FROM web_users").get()).toEqual({
    username: "owner",
    password_hash: expect.not.stringContaining("short"),
  });
  expect(db.prepare("SELECT token_hash,csrf_hash FROM web_sessions").get()).not.toMatchObject({
    token_hash: created.sessionToken,
    csrf_hash: created.csrfToken,
  });
  db.close();
});

it("rejects closed registration before validating or hashing another password", async () => {
  const directory = mkdtempSync(join(tmpdir(), "web-registration-closed-"));
  directories.push(directory);
  const db = openDatabase(join(directory, "orchestrator.sqlite"));
  migrate(db);
  const auth = createWebAuth(db, "test csrf key");
  await auth.registerFirstUser({ username: "owner", password: "short" });

  await expect(auth.registerFirstUser({ username: "other", password: "" }))
    .rejects.toThrow("REGISTRATION_CLOSED");
  expect(db.prepare("SELECT COUNT(*) AS count FROM web_users").get()).toEqual({ count: 1 });
  db.close();
});

it("invalidates existing sessions when the web session secret changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "web-session-rotation-"));
  directories.push(directory);
  const db = openDatabase(join(directory, "orchestrator.sqlite"));
  migrate(db);
  const beforeRotation = createWebAuth(db, "old csrf key");
  const created = await beforeRotation.registerFirstUser({ username: "owner", password: "short" });

  expect(beforeRotation.session(created.sessionToken)).toMatchObject({ username: "owner" });
  const afterRotation = createWebAuth(db, "new csrf key");
  expect(afterRotation.session(created.sessionToken)).toBeUndefined();
  expect(afterRotation.validateCsrf(created.sessionToken, created.csrfToken)).toBe(false);
  db.close();
});

it("logs in, validates the current session, and revokes it on logout", async () => {
  const directory = mkdtempSync(join(tmpdir(), "web-session-"));
  directories.push(directory);
  const db = openDatabase(join(directory, "orchestrator.sqlite"));
  migrate(db);
  const auth = createWebAuth(db, "test csrf key");
  await auth.registerFirstUser({ username: "owner", password: "twelve-char-password" });

  for (let attempt = 0; attempt < 4; attempt += 1)
    await expect(auth.login({ username: "owner", password: "wrong-password" }, "browser-a"))
      .rejects.toThrow("INVALID_CREDENTIALS");
  await expect(auth.login({ username: "owner", password: "wrong-password" }, "browser-a"))
    .rejects.toThrow("INVALID_CREDENTIALS");
  await expect(auth.login({ username: "owner", password: "twelve-char-password" }, "browser-a"))
    .rejects.toThrow("LOGIN_RATE_LIMITED");
  const login = await auth.login({ username: "owner", password: "twelve-char-password" }, "browser-b");
  expect(auth.session(login.sessionToken)).toMatchObject({ username: "owner", csrfToken: login.csrfToken });
  auth.logout(login.sessionToken);
  expect(auth.session(login.sessionToken)).toBeUndefined();
  db.close();
});

it("shares one bounded unknown-user bucket without locking a real account behind the same proxy", async () => {
  const directory = mkdtempSync(join(tmpdir(), "web-proxy-rate-limit-"));
  directories.push(directory);
  const db = openDatabase(join(directory, "orchestrator.sqlite"));
  migrate(db);
  const auth = createWebAuth(db, "test csrf key");
  await auth.registerFirstUser({ username: "owner", password: "password" });

  for (let attempt = 0; attempt < 5; attempt += 1)
    await expect(auth.login({ username: `missing-${attempt}`, password: "wrong" }, "shared-proxy"))
      .rejects.toThrow("INVALID_CREDENTIALS");
  for (let attempt = 5; attempt < 100; attempt += 1)
    await expect(auth.login({ username: `missing-${attempt}`, password: "wrong" }, "shared-proxy"))
      .rejects.toThrow("LOGIN_RATE_LIMITED");

  expect(db.prepare("SELECT COUNT(*) AS count FROM web_login_attempts WHERE client_key LIKE ?").get("shared-proxy%"))
    .toEqual({ count: 1 });

  await expect(auth.login({ username: "owner", password: "password" }, "shared-proxy"))
    .resolves.toMatchObject({ username: "owner" });
  db.close();
});

it("prunes expired login attempts and caps the persistent rate-limit table", async () => {
  const directory = mkdtempSync(join(tmpdir(), "web-rate-limit-prune-"));
  directories.push(directory);
  const db = openDatabase(join(directory, "orchestrator.sqlite"));
  migrate(db);
  const auth = createWebAuth(db, "test csrf key");
  const timestamp = new Date().toISOString();
  const insert = db.prepare("INSERT INTO web_login_attempts(client_key,failures,window_started_at,locked_until,updated_at) VALUES(?,1,?,NULL,?)");
  db.transaction(() => {
    for (let index = 0; index < 10_010; index += 1) insert.run(`client-${index}`, timestamp, timestamp);
  }).immediate();

  await expect(auth.login({ username: "missing-user", password: "wrong" }, "new-client"))
    .rejects.toThrow("INVALID_CREDENTIALS");
  expect(db.prepare("SELECT COUNT(*) AS count FROM web_login_attempts").get()).toEqual({ count: 10_000 });
  db.close();
});
