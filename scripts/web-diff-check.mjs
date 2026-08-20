import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stdout } from "node:process";

function filesUnder(directory) {
  const files = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(directory);
  return files;
}

const sourceFiles = filesUnder("apps/web-console/src");
const source = sourceFiles.map((file) => readFileSync(file, "utf8")).join("\n");
for (const pattern of [
  /\/api\/(?:run-control|confirmations|operations)/,
  /\b(?:create_run|claim_run|retry_stage|pause_run|cancel_run|submit_confirmation)\b/,
]) {
  if (pattern.test(source))
    throw new Error(`forbidden Web execution surface: ${pattern}`);
}
if (/https?:\/\//.test(source))
  throw new Error("remote URL found in Web source");
const builtIndex = readFileSync("apps/web-console/dist/index.html", "utf8");
if (/<(?:script|link|img)[^>]+(?:src|href)=["']https?:/i.test(builtIndex)) {
  throw new Error("remote asset found in built Web entrypoint");
}
execFileSync("git", ["diff", "--check"], { stdio: "inherit" });
stdout.write(`web diff check passed (${sourceFiles.length} source files)\n`);
