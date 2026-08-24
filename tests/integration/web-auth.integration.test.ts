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
    password: "twelve-char-password",
  });

  expect(created.sessionToken).toHaveLength(43);
  expect(created.csrfToken).toHaveLength(43);
  await expect(auth.registerFirstUser({ username: "other", password: "twelve-char-password" }))
    .rejects.toThrow("REGISTRATION_CLOSED");
  expect(db.prepare("SELECT username,password_hash FROM web_users").get()).toEqual({
    username: "owner",
    password_hash: expect.not.stringContaining("twelve-char-password"),
  });
  expect(db.prepare("SELECT token_hash,csrf_hash FROM web_sessions").get()).not.toMatchObject({
    token_hash: created.sessionToken,
    csrf_hash: created.csrfToken,
  });
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
