import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export type ControlConfig = {
  dataDirectory: string;
  databasePath: string;
  objectsPath: string;
  controlSocketPath: string;
  operationSocketPath: string;
  webHost: "127.0.0.1";
  webPort: number;
  webToken: string;
  csrfToken: string;
  adapterCredential: string;
  allowedOrigin: string;
  allowedHosts?: readonly string[];
  staticDirectory?: string;
  maxFrameBytes: number;
};

const secret = (path: string): string => {
  const stats = lstatSync(path);
  const currentUid =
    typeof process.getuid === "function" ? process.getuid() : stats.uid;
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.uid !== currentUid ||
    (stats.mode & 0o077) !== 0
  ) {
    throw new Error(`POLICY_VIOLATION: secret file permissions ${path}`);
  }
  const value = readFileSync(path, "utf8").trim();
  if (value.length === 0) throw new Error("CONFIG_MISSING: empty credential");
  return value;
};
const ensurePrivateDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const mode = lstatSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0)
    throw new Error(`POLICY_VIOLATION: private directory permissions ${path}`);
};
const writeSecret = (path: string, value: string): void => {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  writeFileSync(temporary, `${value}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
};
const generatedSecret = (): string => randomBytes(32).toString("base64url");

function webTokenPath(env: NodeJS.ProcessEnv, dataDirectory: string): string {
  return resolve(
    env["PROJECT_ORCHESTRATOR_WEB_TOKEN_FILE"] ?? `${dataDirectory}/runtime/web-token`,
  );
}

export function ensureWebCredentials(path: string): void {
  ensurePrivateDirectory(dirname(path));
  if (!existsSync(path)) writeSecret(path, generatedSecret());
  if (!existsSync(`${path}.csrf`))
    writeSecret(`${path}.csrf`, generatedSecret());
}

export function rotateWebCredentials(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dataDirectory = resolve(
    env["PROJECT_ORCHESTRATOR_DATA"] ??
      `${env["HOME"] ?? "."}/.project-orchestrator`,
  );
  ensurePrivateDirectory(dataDirectory);
  const path = webTokenPath(env, dataDirectory);
  writeSecret(path, generatedSecret());
  writeSecret(`${path}.csrf`, generatedSecret());
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): ControlConfig {
  const dataDirectory = resolve(
    env["PROJECT_ORCHESTRATOR_DATA"] ??
      `${env["HOME"] ?? "."}/.project-orchestrator`,
  );
  ensurePrivateDirectory(dataDirectory);
  const host = env["PROJECT_ORCHESTRATOR_HOST"] ?? "127.0.0.1";
  if (host !== "127.0.0.1")
    throw new Error("POLICY_VIOLATION: web listener must be loopback");
  const configuredWebTokenPath = webTokenPath(env, dataDirectory);
  ensureWebCredentials(configuredWebTokenPath);
  const webToken = secret(configuredWebTokenPath);
  const csrfToken = secret(`${configuredWebTokenPath}.csrf`);
  const adapterPath = env["PROJECT_ORCHESTRATOR_ADAPTER_CREDENTIAL_FILE"];
  const adapterCredential = adapterPath === undefined ? "" : secret(adapterPath);
  if (webToken === csrfToken || (adapterCredential.length > 0 && (webToken === adapterCredential || csrfToken === adapterCredential))) {
    throw new Error("POLICY_VIOLATION: credentials must use separate values");
  }
  const controlSocketPath = resolve(
    env["PROJECT_ORCHESTRATOR_SOCKET"] ?? `${dataDirectory}/runtime/control.sock`,
  );
  const operationSocketPath = resolve(
    env["PROJECT_ORCHESTRATOR_OPERATION_SOCKET"] ??
      `${dataDirectory}/runtime/operations.sock`,
  );
  ensurePrivateDirectory(dirname(controlSocketPath));
  ensurePrivateDirectory(dirname(operationSocketPath));
  const webPort = Number(env["PROJECT_ORCHESTRATOR_PORT"] ?? 3847);
  if (!Number.isInteger(webPort) || webPort < 0 || webPort > 65_535)
    throw new Error("CONFIG_INVALID: web port");
  const allowedOrigin = env["PROJECT_ORCHESTRATOR_ORIGIN"] ?? `http://127.0.0.1:${webPort}`;
  const allowedHosts = (env["PROJECT_ORCHESTRATOR_ALLOWED_HOSTS"] ?? "127.0.0.1,localhost")
    .split(',').map((value) => value.trim()).filter((value) => value.length > 0);
  if (allowedHosts.length === 0 || allowedHosts.some((value) => value.includes('/') || value.includes(':'))) {
    throw new Error('CONFIG_INVALID: allowed hosts');
  }
  return {
    dataDirectory,
    databasePath: resolve(
      env["PROJECT_ORCHESTRATOR_DB"] ?? `${dataDirectory}/orchestrator.sqlite`,
    ),
    objectsPath: resolve(
      env["PROJECT_ORCHESTRATOR_OBJECTS"] ?? `${dataDirectory}/objects`,
    ),
    controlSocketPath,
    operationSocketPath,
    webHost: "127.0.0.1",
    webPort,
    webToken,
    csrfToken,
    adapterCredential,
    allowedOrigin,
    allowedHosts,
    ...(env["PROJECT_ORCHESTRATOR_WEB_STATIC"] === undefined ? {} : { staticDirectory: resolve(env["PROJECT_ORCHESTRATOR_WEB_STATIC"]) }),
    maxFrameBytes: 256 * 1024,
  };
}
