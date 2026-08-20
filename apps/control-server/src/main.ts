import { rotateWebCredentials } from "./config.js";
import { startControlServer } from "./runtime.js";

if (process.argv[2] === "--rotate-web-credentials") {
  rotateWebCredentials();
  process.stdout.write(
    "Web credentials rotated. Restart the Control Server and bootstrap a new browser session.\n",
  );
} else {
  const termination = new Promise<void>((resolve) =>
    process.once("SIGTERM", resolve),
  );
  const runtime = await startControlServer();
  await termination;
  try {
    await runtime.shutdown();
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(
      `control server shutdown failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
  }
}
