import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export function runtimeVersion(env: NodeJS.ProcessEnv = process.env): string {
  const versionFile = env["PROJECT_ORCHESTRATOR_VERSION_FILE"];
  if (versionFile !== undefined && existsSync(versionFile)) {
    const version = readFileSync(versionFile, "utf8").trim();
    if (version) return version;
  }
  return env["PROJECT_ORCHESTRATOR_VERSION"]?.trim() || "development";
}

export function databaseIdentity(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}
