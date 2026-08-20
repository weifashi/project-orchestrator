import { existsSync, readFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type Database from "better-sqlite3";
import type { ContentStore } from "@project-orchestrator/content-store";
import { ConfigService } from "@project-orchestrator/orchestrator-service";
import {
  EventRepository,
  SqliteConfigRepository,
} from "@project-orchestrator/sqlite-store";
import {
  createConfigHandlers,
  registerConfigRoutes,
  type ConfigHandlers,
} from "./routes/config.js";
import { registerReadRoutes } from "./routes/read.js";
import {
  closeEventStreams,
  streamEvents,
  type EventStreamConnections,
} from "./sse.js";

type WebListenerInput = {
  db: Database.Database;
  content: ContentStore;
  webToken: string;
  csrfToken: string;
  allowedOrigin: string;
  allowedHosts?: readonly string[];
  handlers?: ConfigHandlers;
  ssePollIntervalMs?: number;
  staticDirectory?: string;
};
export type WebListener = FastifyInstance & { closeEventStreams: () => void };
const buildCsp = (styleNonce: string) =>
  `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${styleNonce}'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
const buildBootstrapPage = (styleNonce: string) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>连接 Project Orchestrator</title>
<style nonce="${styleNonce}">
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#0f172a;color:#e5edf8}*{box-sizing:border-box}body{min-width:320px;min-height:100vh;margin:0;background:radial-gradient(circle at 18% 10%,rgba(52,211,153,.22),transparent 28rem),radial-gradient(circle at 85% 14%,rgba(96,165,250,.18),transparent 30rem),linear-gradient(135deg,#0f172a,#111827 55%,#08111f);display:grid;place-items:center;padding:24px}main{width:min(100%,980px);display:grid;grid-template-columns:minmax(0,1.08fr) minmax(320px,.92fr);gap:22px;align-items:stretch}.hero,.bootstrap-card{border:1px solid rgba(148,163,184,.2);background:linear-gradient(180deg,rgba(25,33,52,.9),rgba(15,23,42,.86));box-shadow:0 24px 80px rgba(0,0,0,.38);border-radius:28px;overflow:hidden}.hero{padding:34px;position:relative}.hero:before,.bootstrap-card:before{content:"";display:block;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.42),transparent);position:absolute;inset:0 0 auto}.brand{display:flex;align-items:center;gap:12px;margin-bottom:58px}.mark{display:grid;place-items:center;width:44px;height:44px;border-radius:16px;background:linear-gradient(135deg,#34d399,#60a5fa);color:#06121e;font-weight:950}.brand small{display:block;color:#94a3b8;margin-top:2px}.hero h1{font-size:clamp(2rem,5vw,4.4rem);line-height:.96;letter-spacing:-.07em;margin:0 0 18px;color:#fff;text-wrap:balance}.hero p{max-width:32rem;color:#b7c5d8;line-height:1.7;margin:0 0 28px}.trust-row{display:flex;flex-wrap:wrap;gap:10px}.pill{border:1px solid rgba(52,211,153,.24);background:rgba(16,185,129,.12);color:#bbf7d0;border-radius:999px;padding:8px 11px;font:700 .78rem ui-monospace,monospace}.bootstrap-card{position:relative;padding:30px;align-self:center}.kicker{text-transform:uppercase;letter-spacing:.14em;color:#8bf2bd;font-weight:850;font-size:.72rem;margin-bottom:12px}.bootstrap-card h2{font-size:clamp(1.65rem,3vw,2.35rem);letter-spacing:-.045em;margin:0 0 10px;color:#fff}.bootstrap-card p{color:#aab9cf;line-height:1.65;margin:0 0 22px}.field{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}label{font-weight:820;color:#dbeafe}input{min-height:52px;width:100%;border:1px solid rgba(148,163,184,.32);background:rgba(2,6,23,.44);border-radius:16px;color:#fff;padding:0 15px;font:700 1rem ui-monospace,monospace}input:focus{outline:3px solid rgba(52,211,153,.7);outline-offset:4px;border-color:#34d399}.hint{font-size:.82rem;color:#8fa2bb}button{width:100%;min-height:52px;border:1px solid rgba(52,211,153,.6);border-radius:16px;background:linear-gradient(135deg,#059669,#34d399);color:#04130d;font-weight:900;cursor:pointer;box-shadow:0 16px 32px rgba(5,150,105,.24)}button:hover{filter:brightness(1.04)}.status{display:grid;gap:10px;margin-top:20px;padding-top:18px;border-top:1px solid rgba(148,163,184,.16)}.status span{display:flex;justify-content:space-between;gap:16px;color:#94a3b8;font-size:.86rem}.status strong{color:#e5edf8;font-family:ui-monospace,monospace;overflow-wrap:anywhere;text-align:right}@media (max-width:760px){main{grid-template-columns:1fr}.hero{padding:26px}.brand{margin-bottom:34px}.bootstrap-card{padding:24px}.status span{flex-direction:column;gap:4px}.status strong{text-align:left}}@media (prefers-reduced-motion:reduce){*,*:before,*:after{transition-duration:.01ms!important;animation-duration:.01ms!important}}
</style>
</head>
<body>
<main>
<section class="hero" aria-labelledby="bootstrap-title">
  <div class="brand"><span class="mark">PO</span><span><strong>Project Orchestrator</strong><small>Local control plane</small></span></div>
  <h1 id="bootstrap-title">连接本机控制台</h1>
  <p>Web 只用于编排模板和观察 Run；不会启动、暂停、批准或部署任务。执行动作仍回到 Codex / Claude 会话。</p>
  <div class="trust-row" aria-label="安全边界"><span class="pill">127.0.0.1 only</span><span class="pill">HttpOnly session</span><span class="pill">Coder 安全代理</span></div>
</section>
<section class="bootstrap-card" aria-label="本机控制台登录">
  <div class="kicker">Secure bootstrap</div>
  <h2>输入 Web token</h2>
  <p>凭证只用于本次交换，不会写入 URL 或浏览器存储。允许粘贴，方便使用密码管理器。</p>
  <form method="post" action="/bootstrap">
    <div class="field"><label for="token">Web token</label><input id="token" name="token" type="password" required autocomplete="current-password" autofocus><span class="hint">文件位置：~/.project-orchestrator/runtime/web-token</span></div>
    <button type="submit" aria-label="连接">连接控制台 →</button>
  </form>
  <div class="status"><span>入口 <strong>Coder HTTPS proxy</strong></span><span>后端 <strong>127.0.0.1:3847</strong></span><span>权限 <strong>观察 + 编排未来模板</strong></span></div>
</section>
</main>
</body>
</html>`;
export function buildWebListener(input: WebListenerInput): WebListener {
  const app = Fastify({ logger: false }),
    eventStreams: EventStreamConnections = new Set();
  app.decorate("closeEventStreams", () => closeEventStreams(eventStreams));
  const sessionCookie = randomBytes(32).toString("base64url");
  const bootstrapStyleNonce = randomBytes(16).toString("base64url");
  const allowedHosts = new Set(input.allowedHosts ?? ["127.0.0.1", "localhost"]);
  const cookieSecurity = input.allowedOrigin.startsWith("https://") ? "; Secure" : "";
  const matchesBootstrapToken = (token: string | undefined): boolean => {
    const supplied = Buffer.from(token ?? "", "utf8");
    const expected = Buffer.from(input.webToken, "utf8");
    return (
      supplied.length === expected.length && timingSafeEqual(supplied, expected)
    );
  };
  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host?.split(":")[0];
    if (host === undefined || !allowedHosts.has(host))
      return reply.code(403).send({ error: "invalid host" });
    if (
      request.headers.origin !== undefined &&
      request.headers.origin !== input.allowedOrigin
    )
      return reply.code(403).send({ error: "invalid origin" });
    const authenticated = (request.headers.cookie ?? "")
      .split(";")
      .some((part) => part.trim() === `po_session=${sessionCookie}`);
    if (request.url === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD")
        return reply.code(405).send({ error: "method not allowed" });
      return;
    }
    if (request.url === "/bootstrap") {
      if (request.method !== "GET" && request.method !== "POST")
        return reply.code(405).send({ error: "method not allowed" });
      return;
    }
    const apiRequest = request.url.startsWith("/api/"),
      writes =
        request.method !== "GET" &&
        request.method !== "HEAD" &&
        request.method !== "OPTIONS";
    if (!apiRequest) {
      if (request.method !== "GET" && request.method !== "HEAD")
        return reply.code(405).send({ error: "method not allowed" });
      if (!authenticated)
        return reply.code(403).send({ error: "unauthorized" });
      return;
    }
    if (!authenticated) return reply.code(403).send({ error: "unauthorized" });
    if (
      writes &&
      (request.headers.origin !== input.allowedOrigin ||
        request.headers["x-csrf-token"] !== input.csrfToken)
    )
      return reply.code(403).send({ error: "csrf" });
  });
  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : "internal error";
    const status = message.includes("REVISION_CONFLICT")
      ? 409
      : message.startsWith("NOT_FOUND")
        ? 404
        : /^(POLICY_VIOLATION|SAFETY_BASELINE_INCOMPATIBLE|CONFIG_INVALID)/.test(
              message,
            )
          ? 400
          : typeof error === "object" && error !== null && "statusCode" in error
            ? Number(error.statusCode)
            : 500;
    return reply.code(status).send({ error: message });
  });
  app.addHook("onSend", async (request, reply, payload) => {
    reply
      .header("Content-Security-Policy", buildCsp(bootstrapStyleNonce))
      .header("X-Content-Type-Options", "nosniff")
      .header(
        "Referrer-Policy",
        request.url === "/bootstrap" ? "same-origin" : "no-referrer",
      )
      .header("X-Frame-Options", "DENY");
    const authenticated = (request.headers.cookie ?? "")
      .split(";")
      .some((part) => part.trim() === `po_session=${sessionCookie}`);
    if (authenticated && reply.statusCode < 400)
      reply.header(
        "Set-Cookie",
        `po_session=${sessionCookie}; HttpOnly; SameSite=Strict; Path=/${cookieSecurity}`,
      );
    return payload;
  });
  const handlers =
    input.handlers ??
    createConfigHandlers(
      new ConfigService(new SqliteConfigRepository(input.db), input.content),
      input.db,
    );
  registerConfigRoutes(app, handlers);
  registerReadRoutes(app, input.db, input.content);
  app.get("/health", async (_request, reply) =>
    reply.header("Cache-Control", "no-store").send({ ok: true }),
  );
  app.get("/api/read/session", async (_request, reply) =>
    reply
      .header("Cache-Control", "no-store")
      .send({ csrf_token: input.csrfToken }),
  );
  app.get(
    "/api/stream/events",
    streamEvents(
      new EventRepository(input.db),
      input.ssePollIntervalMs,
      eventStreams,
    ),
  );
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 16 * 1024 },
    (_request, body, done) => done(null, body),
  );
  const root = resolve(
    input.staticDirectory ??
      new URL("../../../web-console/dist", import.meta.url).pathname,
  );
  app.get("/bootstrap", async (_request, reply) =>
    reply
      .header("Cache-Control", "no-store")
      .type("text/html; charset=utf-8")
      .send(buildBootstrapPage(bootstrapStyleNonce)),
  );
  app.post("/bootstrap", async (request, reply) => {
    const body = new URLSearchParams(String(request.body ?? ""));
    if (!matchesBootstrapToken(body.get("token") ?? undefined))
      return reply.code(403).send({ error: "invalid bootstrap token" });
    return reply
      .header("Cache-Control", "no-store")
      .header(
        "Set-Cookie",
        `po_session=${sessionCookie}; HttpOnly; SameSite=Strict; Path=/${cookieSecurity}`,
      )
      .redirect("/");
  });
  if (existsSync(root)) {
    app.register(fastifyStatic, {
      root: resolve(root, "assets"),
      prefix: "/assets/",
      wildcard: true,
      decorateReply: false,
      maxAge: "1y",
      immutable: true,
    });
    const indexPath = resolve(root, "index.html");
    const index = () =>
      readFileSync(indexPath, "utf8").replace(
        "__PO_CSRF_TOKEN__",
        input.csrfToken,
      );
    app.get("/", async (_request, reply) =>
      reply
        .header("Cache-Control", "no-store")
        .type("text/html; charset=utf-8")
        .send(index()),
    );
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/"))
        return reply.code(404).send({ error: "not found" });
      if (request.method !== "GET" && request.method !== "HEAD")
        return reply.code(405).send({ error: "method not allowed" });
      return reply
        .header("Cache-Control", "no-store")
        .type("text/html; charset=utf-8")
        .send(index());
    });
  }
  return app as unknown as WebListener;
}
