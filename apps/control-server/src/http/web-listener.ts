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
  handlers?: ConfigHandlers;
  ssePollIntervalMs?: number;
  staticDirectory?: string;
};
export type WebListener = FastifyInstance & { closeEventStreams: () => void };
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const BOOTSTRAP_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Project Orchestrator 登录</title></head>
<body><main><h1>连接本机编排器</h1><p>输入本机 web-token。凭证只用于本次交换，不会写入 URL 或浏览器存储。</p><form method="post" action="/bootstrap"><label>Web token <input name="token" type="password" required autocomplete="off"></label><button type="submit">连接</button></form></main></body></html>`;
export function buildWebListener(input: WebListenerInput): WebListener {
  const app = Fastify({ logger: false }),
    eventStreams: EventStreamConnections = new Set();
  app.decorate("closeEventStreams", () => closeEventStreams(eventStreams));
  const sessionCookie = randomBytes(32).toString("base64url");
  const matchesBootstrapToken = (token: string | undefined): boolean => {
    const supplied = Buffer.from(token ?? "", "utf8");
    const expected = Buffer.from(input.webToken, "utf8");
    return (
      supplied.length === expected.length && timingSafeEqual(supplied, expected)
    );
  };
  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host?.split(":")[0];
    if (host !== "127.0.0.1" && host !== "localhost")
      return reply.code(403).send({ error: "invalid host" });
    if (
      request.headers.origin !== undefined &&
      request.headers.origin !== input.allowedOrigin
    )
      return reply.code(403).send({ error: "invalid origin" });
    const authenticated = (request.headers.cookie ?? "")
      .split(";")
      .some((part) => part.trim() === `po_session=${sessionCookie}`);
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
      .header("Content-Security-Policy", CSP)
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
        `po_session=${sessionCookie}; HttpOnly; SameSite=Strict; Path=/`,
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
      .send(BOOTSTRAP_PAGE),
  );
  app.post("/bootstrap", async (request, reply) => {
    const body = new URLSearchParams(String(request.body ?? ""));
    if (!matchesBootstrapToken(body.get("token") ?? undefined))
      return reply.code(403).send({ error: "invalid bootstrap token" });
    return reply
      .header("Cache-Control", "no-store")
      .header(
        "Set-Cookie",
        `po_session=${sessionCookie}; HttpOnly; SameSite=Strict; Path=/`,
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
