import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type ControlConfig = {
  dataDirectory: string;
  databasePath: string;
  objectsPath: string;
  controlSocketPath: string;
  operationSocketPath: string;
  webHost: "127.0.0.1";
  webPort: number;
  webSessionSecret: string;
  adapterCredential: string;
  allowedOrigins: readonly string[];
  allowedHosts?: readonly string[];
  staticDirectory?: string;
  maxFrameBytes: number;
};

const secret = (path: string): string => {
  const stats = lstatSync(path), currentUid = typeof process.getuid === "function" ? process.getuid() : stats.uid;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== currentUid || (stats.mode & 0o077) !== 0) throw new Error(`POLICY_VIOLATION: secret file permissions ${path}`);
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new Error("CONFIG_MISSING: empty credential");
  return value;
};
const ensurePrivateDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if ((lstatSync(path).mode & 0o077) !== 0) throw new Error(`POLICY_VIOLATION: private directory permissions ${path}`);
};
const writeSecret = (path: string, value: string): void => {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  writeFileSync(temporary, `${value}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
};
const generatedSecret = (): string => randomBytes(32).toString("base64url");
const sessionSecretPath = (env: NodeJS.ProcessEnv, dataDirectory: string): string => resolve(env["PROJECT_ORCHESTRATOR_WEB_SESSION_SECRET_FILE"] ?? `${dataDirectory}/runtime/web-session-secret`);

export function ensureWebSessionSecret(path: string): void {
  ensurePrivateDirectory(dirname(path));
  if (!existsSync(path)) writeSecret(path, generatedSecret());
}

export function rotateWebSessionSecret(env: NodeJS.ProcessEnv = process.env): void {
  const dataDirectory = resolve(env["PROJECT_ORCHESTRATOR_DATA"] ?? `${env["HOME"] ?? "."}/.project-orchestrator`);
  ensurePrivateDirectory(dataDirectory);
  writeSecret(sessionSecretPath(env, dataDirectory), generatedSecret());
}

const parseOrigins = (value: string): readonly string[] => {
  const origins = value.split(",").map((origin) => origin.trim()).filter(Boolean);
  if (!origins.length) throw new Error("CONFIG_INVALID: allowed origins");
  for (const origin of origins) try {
    const url = new URL(origin);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== origin) throw new Error();
  } catch { throw new Error("CONFIG_INVALID: allowed origins"); }
  return Object.freeze([...new Set(origins)]);
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ControlConfig {
  const dataDirectory = resolve(env["PROJECT_ORCHESTRATOR_DATA"] ?? `${env["HOME"] ?? "."}/.project-orchestrator`);
  ensurePrivateDirectory(dataDirectory);
  if ((env["PROJECT_ORCHESTRATOR_HOST"] ?? "127.0.0.1") !== "127.0.0.1") throw new Error("POLICY_VIOLATION: web listener must be loopback");
  const webSessionSecretFile = sessionSecretPath(env, dataDirectory);
  ensureWebSessionSecret(webSessionSecretFile);
  const webSessionSecret = secret(webSessionSecretFile);
  const adapterPath = env["PROJECT_ORCHESTRATOR_ADAPTER_CREDENTIAL_FILE"];
  const adapterCredential = adapterPath === undefined ? "" : secret(adapterPath);
  if (adapterCredential && adapterCredential === webSessionSecret) throw new Error("POLICY_VIOLATION: credentials must use separate values");
  const controlSocketPath = resolve(env["PROJECT_ORCHESTRATOR_SOCKET"] ?? `${dataDirectory}/runtime/control.sock`);
  const operationSocketPath = resolve(env["PROJECT_ORCHESTRATOR_OPERATION_SOCKET"] ?? `${dataDirectory}/runtime/operations.sock`);
  ensurePrivateDirectory(dirname(controlSocketPath)); ensurePrivateDirectory(dirname(operationSocketPath));
  const webPort = Number(env["PROJECT_ORCHESTRATOR_PORT"] ?? 3847);
  if (!Number.isInteger(webPort) || webPort < 0 || webPort > 65_535) throw new Error("CONFIG_INVALID: web port");
  const allowedOrigins = parseOrigins(env["PROJECT_ORCHESTRATOR_ORIGINS"] ?? env["PROJECT_ORCHESTRATOR_ORIGIN"] ?? `http://127.0.0.1:${webPort}`);
  const allowedHosts = (env["PROJECT_ORCHESTRATOR_ALLOWED_HOSTS"] ?? "127.0.0.1,localhost").split(",").map((value) => value.trim()).filter(Boolean);
  if (!allowedHosts.length || allowedHosts.some((value) => value.includes("/") || value.includes(":"))) throw new Error("CONFIG_INVALID: allowed hosts");
  return {
    dataDirectory, databasePath: resolve(env["PROJECT_ORCHESTRATOR_DB"] ?? `${dataDirectory}/orchestrator.sqlite`), objectsPath: resolve(env["PROJECT_ORCHESTRATOR_OBJECTS"] ?? `${dataDirectory}/objects`), controlSocketPath, operationSocketPath,
    webHost: "127.0.0.1", webPort, webSessionSecret, adapterCredential, allowedOrigins, allowedHosts,
    ...(env["PROJECT_ORCHESTRATOR_WEB_STATIC"] === undefined ? {} : { staticDirectory: resolve(env["PROJECT_ORCHESTRATOR_WEB_STATIC"]) }), maxFrameBytes: 256 * 1024,
  };
}
