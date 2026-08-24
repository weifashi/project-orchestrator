import { createHash, createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";

const scryptParameters = { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 } as const;
const tokenBytes = 32;
const sessionLifetimeMs = 12 * 60 * 60 * 1_000;
const loginWindowMs = 15 * 60 * 1_000;
const maxLoginFailures = 5;

type Credentials = Readonly<{ username: string; password: string }>;
type SessionResult = Readonly<{ userId: string; username: string; csrfToken: string }>;
type LoginResult = SessionResult & Readonly<{ sessionToken: string }>;
type UserRow = Readonly<{ id: string; username: string; password_hash: string }>;
type AttemptRow = Readonly<{ failures: number; window_started_at: string; locked_until: string | null }>;

const now = (): string => new Date().toISOString();
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const randomToken = (): string => randomBytes(tokenBytes).toString("base64url");
const validUsername = (username: string): boolean => /^[A-Za-z0-9_-]{3,32}$/.test(username);
const validPassword = (password: string): boolean => password.length > 0;
const mismatch = (left: Buffer, right: Buffer): boolean => left.length !== right.length || !timingSafeEqual(left, right);
const scrypt = (password: string, salt: Buffer, length: number): Promise<Buffer> => new Promise((resolve, reject) => {
  scryptCallback(password, salt, length, scryptParameters, (error, output) => error ? reject(error) : resolve(output));
});

async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const output = await scrypt(password, salt, 32);
  return ["scrypt", "v1", String(scryptParameters.N), String(scryptParameters.r), String(scryptParameters.p), salt.toString("base64url"), Buffer.from(output).toString("base64url")].join("$");
}

async function passwordMatches(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 7 || parts[0] !== "scrypt" || parts[1] !== "v1") return false;
  const [,, rawN, rawR, rawP, rawSalt, rawOutput] = parts;
  const N = Number(rawN), r = Number(rawR), p = Number(rawP);
  if (N !== scryptParameters.N || r !== scryptParameters.r || p !== scryptParameters.p || !rawSalt || !rawOutput) return false;
  try {
    const expected = Buffer.from(rawOutput, "base64url");
    const actual = await scrypt(password, Buffer.from(rawSalt, "base64url"), expected.length);
    return !mismatch(actual, expected);
  } catch {
    return false;
  }
}

function requireCredentials(input: Credentials): Credentials {
  const username = input.username.trim();
  if (!validUsername(username)) throw new Error("INVALID_USERNAME");
  if (!validPassword(input.password)) throw new Error("INVALID_PASSWORD");
  return { username, password: input.password };
}

export function createWebAuth(db: Database.Database, csrfKey: string) {
  const csrfFor = (sessionToken: string): string => createHmac("sha256", csrfKey).update(sessionToken).digest("base64url");
  const createSession = (user: Pick<UserRow, "id" | "username">): LoginResult => {
    const sessionToken = randomToken(), csrfToken = csrfFor(sessionToken), timestamp = now();
    const expiresAt = new Date(Date.now() + sessionLifetimeMs).toISOString();
    db.prepare("INSERT INTO web_sessions(id,user_id,token_hash,csrf_hash,created_at,expires_at,last_seen_at,revoked_at) VALUES(?,?,?,?,?,?,?,NULL)")
      .run(randomUUID(), user.id, digest(sessionToken), digest(csrfToken), timestamp, expiresAt, timestamp);
    return { userId: user.id, username: user.username, sessionToken, csrfToken };
  };
  const currentAttempt = (clientKey: string): AttemptRow | undefined => db.prepare("SELECT failures,window_started_at,locked_until FROM web_login_attempts WHERE client_key=?").get(clientKey) as AttemptRow | undefined;
  const locked = (clientKey: string): boolean => {
    const attempt = currentAttempt(clientKey);
    return attempt?.locked_until !== null && attempt?.locked_until !== undefined && attempt.locked_until > now();
  };
  const failedLogin = (clientKey: string): void => {
    const timestamp = now(), previous = currentAttempt(clientKey);
    const withinWindow = previous !== undefined && Date.parse(timestamp) - Date.parse(previous.window_started_at) < loginWindowMs;
    const failures = (withinWindow ? previous?.failures ?? 0 : 0) + 1;
    const lockedUntil = failures >= maxLoginFailures ? new Date(Date.now() + loginWindowMs).toISOString() : null;
    db.prepare("INSERT INTO web_login_attempts(client_key,failures,window_started_at,locked_until,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(client_key) DO UPDATE SET failures=excluded.failures,window_started_at=excluded.window_started_at,locked_until=excluded.locked_until,updated_at=excluded.updated_at")
      .run(clientKey, failures, withinWindow ? previous?.window_started_at ?? timestamp : timestamp, lockedUntil, timestamp);
  };
  const clearFailures = (clientKey: string): void => { db.prepare("DELETE FROM web_login_attempts WHERE client_key=?").run(clientKey); };
  return Object.freeze({
    hasUsers: (): boolean => (db.prepare("SELECT 1 FROM web_users LIMIT 1").get() !== undefined),
    async registerFirstUser(input: Credentials): Promise<LoginResult> {
      const credentials = requireCredentials(input), encoded = await passwordHash(credentials.password), timestamp = now();
      return db.transaction(() => {
        if (db.prepare("SELECT 1 FROM web_users LIMIT 1").get() !== undefined) throw new Error("REGISTRATION_CLOSED");
        const user: UserRow = { id: randomUUID(), username: credentials.username, password_hash: encoded };
        try {
          db.prepare("INSERT INTO web_users(id,username,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)")
            .run(user.id, user.username, user.password_hash, timestamp, timestamp);
        } catch {
          throw new Error("REGISTRATION_CLOSED");
        }
        return createSession(user);
      }).immediate();
    },
    async login(input: Credentials, clientKey = "unknown"): Promise<LoginResult> {
      const credentials = requireCredentials(input);
      if (locked(clientKey)) throw new Error("LOGIN_RATE_LIMITED");
      const user = db.prepare("SELECT id,username,password_hash FROM web_users WHERE username=? COLLATE NOCASE").get(credentials.username) as UserRow | undefined;
      if (user === undefined || !(await passwordMatches(credentials.password, user.password_hash))) {
        failedLogin(clientKey);
        throw new Error("INVALID_CREDENTIALS");
      }
      clearFailures(clientKey);
      return db.transaction(() => createSession(user)).immediate();
    },
    session(sessionToken: string | undefined): SessionResult | undefined {
      if (!sessionToken) return undefined;
      const row = db.prepare("SELECT u.id,u.username,s.csrf_hash FROM web_sessions s JOIN web_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? LIMIT 1")
        .get(digest(sessionToken), now()) as { id: string; username: string; csrf_hash: string } | undefined;
      if (!row) return undefined;
      return { userId: row.id, username: row.username, csrfToken: csrfFor(sessionToken) };
    },
    validateCsrf(sessionToken: string | undefined, csrfToken: string | undefined): boolean {
      if (!sessionToken || !csrfToken) return false;
      const row = db.prepare("SELECT csrf_hash FROM web_sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at>? LIMIT 1")
        .get(digest(sessionToken), now()) as { csrf_hash: string } | undefined;
      return row !== undefined
        && !mismatch(Buffer.from(row.csrf_hash, "utf8"), Buffer.from(digest(csrfToken), "utf8"))
        && !mismatch(Buffer.from(csrfFor(sessionToken), "utf8"), Buffer.from(csrfToken, "utf8"));
    },
    logout(sessionToken: string | undefined): void {
      if (sessionToken) db.prepare("UPDATE web_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL").run(now(), digest(sessionToken));
    },
  });
}
