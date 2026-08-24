import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import type Database from "better-sqlite3";
import type { ContentStore } from "@project-orchestrator/content-store";
import { ConfigService } from "@project-orchestrator/orchestrator-service";
import { EventRepository, SqliteConfigRepository } from "@project-orchestrator/sqlite-store";
import { createConfigHandlers, registerConfigRoutes, type ConfigHandlers } from "./routes/config.js";
import { registerReadRoutes } from "./routes/read.js";
import { createWebAuth } from "./web-auth.js";
import { closeEventStreams, streamEvents, type EventStreamConnections } from "./sse.js";

type WebListenerInput = {
  db: Database.Database;
  content: ContentStore;
  sessionSecret: string;
  allowedOrigins: readonly string[];
  allowedHosts?: readonly string[];
  handlers?: ConfigHandlers;
  ssePollIntervalMs?: number;
  staticDirectory?: string;
};
export type WebListener = FastifyInstance & { closeEventStreams: () => void };

const buildCsp = (styleNonce: string) =>
  `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${styleNonce}'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
const sessionCookie = (value: string, secure: boolean) =>
  `po_session=${value}; HttpOnly; SameSite=Strict; Path=/${secure ? "; Secure" : ""}`;
const clearSessionCookie = (secure: boolean) =>
  `po_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`;
const cookieValue = (raw: string | undefined, name: string): string | undefined =>
  raw?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
const hostName = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  if (raw.startsWith("[")) return raw.slice(1, raw.indexOf("]")).toLowerCase();
  return raw.split(":", 1)[0]?.toLowerCase();
};
const trustedAddress = (raw: string): boolean => {
  const ip = raw.replace(/^::ffff:/, "").toLowerCase();
  if (ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80:")) return true;
  const octets = ip.split(".").map(Number);
  return octets.length === 4 && octets.every(Number.isInteger) && (octets[0] === 10 || octets[0] === 127 || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) || (octets[0] === 192 && octets[1] === 168));
};
const formValue = (body: unknown, key: string): string => new URLSearchParams(String(body ?? "")).get(key) ?? "";
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const authError = (error: unknown): { status: number; message: string } => {
  const code = error instanceof Error ? error.message : "";
  if (code === "REGISTRATION_CLOSED") return { status: 403, message: "管理员账号已经创建，请直接登录。" };
  if (code === "INVALID_USERNAME") return { status: 400, message: "账号名需为 3–32 位字母、数字、下划线或连字符。" };
  if (code === "INVALID_PASSWORD") return { status: 400, message: "密码至少需要 12 个字符。" };
  if (code === "LOGIN_RATE_LIMITED") return { status: 429, message: "尝试次数过多，请 15 分钟后再试。" };
  return { status: 403, message: "账号或密码不正确。" };
};

const bootstrapPage = (styleNonce: string, registering: boolean, error?: string) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${registering ? "创建管理员账号" : "登录"} · Project Orchestrator</title>
<style nonce="${styleNonce}">
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#1e1e1e;color:#f6f6f6}*{box-sizing:border-box}body{min-width:320px;min-height:100dvh;margin:0;background:radial-gradient(circle at 12% 0,rgba(255,109,90,.13),transparent 28rem),#1e1e1e;display:grid;place-items:center;padding:24px}.shell{width:min(100%,960px);display:grid;grid-template-columns:minmax(0,1fr) minmax(350px,.78fr);border:1px solid #444;border-radius:16px;overflow:hidden;background:#252525;box-shadow:0 28px 80px rgba(0,0,0,.35)}.hero{padding:42px;background:linear-gradient(145deg,#2b2524,#242424 55%);border-right:1px solid #444}.brand{display:flex;align-items:center;gap:10px;margin-bottom:66px}.mark{display:grid;place-items:center;width:34px;height:34px;border-radius:9px;background:#ff6d5a;color:#301411;font-weight:950}.brand small{display:block;color:#aaa;margin-top:2px}.eyebrow{color:#ff9b8e;font-size:.73rem;font-weight:850;letter-spacing:.1em;text-transform:uppercase}.eyebrow:before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:#ff6d5a;margin-right:7px;box-shadow:0 0 0 4px rgba(255,109,90,.13)}h1{font-size:clamp(2.1rem,5vw,4rem);line-height:.98;letter-spacing:-.065em;margin:12px 0 18px;color:#fff;text-wrap:balance}.hero p{max-width:28rem;color:#b8b8b8;line-height:1.7;margin:0}.pills{display:flex;flex-wrap:wrap;gap:8px;margin-top:30px}.pills span{border:1px solid #4b4b4b;border-radius:999px;padding:6px 9px;color:#d0d0d0;font-size:.76rem}.panel{padding:34px;align-self:center}.panel h2{font-size:1.7rem;letter-spacing:-.04em;margin:8px 0}.panel p{color:#aaa;line-height:1.6;margin:0 0 22px}.field{display:grid;gap:7px;margin:14px 0}.field label{font-size:.84rem;font-weight:800;color:#eee}.field input{min-height:46px;width:100%;border:1px solid #505050;border-radius:8px;background:#1d1d1d;color:#fff;padding:0 12px;font:inherit}.field input:focus{outline:3px solid rgba(255,109,90,.34);outline-offset:2px;border-color:#ff806f}.hint{color:#9c9c9c;font-size:.76rem}.error{margin:0 0 14px;padding:10px 12px;border-left:3px solid #ff6d5a;background:#3b2927;color:#ffd3cd;font-size:.84rem}button{width:100%;min-height:46px;border:0;border-radius:8px;background:#ff6d5a;color:#301411;font:850 .92rem inherit;cursor:pointer;margin-top:8px}button:hover{background:#ff806f}.notice{margin-top:20px;padding-top:16px;border-top:1px solid #444;color:#aaa;font-size:.78rem;line-height:1.6}.notice strong{color:#ddd}@media(max-width:760px){body{padding:14px}.shell{grid-template-columns:1fr}.hero{padding:28px;border-right:0;border-bottom:1px solid #444}.brand{margin-bottom:38px}.panel{padding:28px}.hero h1{font-size:2.4rem}}@media(prefers-reduced-motion:reduce){*{transition-duration:.01ms!important;animation-duration:.01ms!important}}
</style></head><body><main class="shell"><section class="hero"><div class="brand"><span class="mark">PO</span><span><strong>Project Orchestrator</strong><small>本机控制台</small></span></div><div class="eyebrow">模板编排 · 任务仅查看</div><h1>让流程清楚，<br>让执行可追溯。</h1><p>网页只能编辑未来的流程模板和观察任务。启动、确认、重试及部署仍在 Codex 或 Claude 会话中完成。</p><div class="pills"><span>本机 SQLite</span><span>受限 Web 权限</span><span>安全会话</span></div></section><section class="panel"><div class="eyebrow">${registering ? "首次使用" : "安全登录"}</div><h2>${registering ? "创建管理员账号" : "欢迎回来"}</h2><p>${registering ? "此电脑还没有账号。第一个账号将管理本机控制台。" : "使用本机账号登录后继续编排和观察。"}</p>${error ? '<div class="error" role="alert">' + error + '</div>' : ""}<form method="post" action="${registering ? "/bootstrap/register" : "/bootstrap/login"}"><div class="field"><label for="username">账号名</label><input id="username" name="username" autocomplete="username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_-]+" autofocus></div><div class="field"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="${registering ? "new-password" : "current-password"}" required minlength="12">${registering ? "<span class=\"hint\">至少 12 位，支持密码管理器粘贴。</span>" : ""}</div>${registering ? "<div class=\"field\"><label for=\"confirm-password\">确认密码</label><input id=\"confirm-password\" name=\"confirm_password\" type=\"password\" autocomplete=\"new-password\" required minlength=\"12\"></div>" : ""}<button type="submit">${registering ? "创建账号并进入控制台" : "登录"}</button></form><div class="notice"><strong>${registering ? "注册后将关闭公开注册。" : "忘记密码？"}</strong> ${registering ? "账号只拥有网页编排与只读观察权限。" : "请在可信的本机终端执行管理员恢复命令。"}</div></section></main></body></html>`;

export function buildWebListener(input: WebListenerInput): WebListener {
  const app = Fastify({ logger: false }), eventStreams: EventStreamConnections = new Set();
  const sessionSecret = input.sessionSecret;
  const allowedOrigins = new Set(input.allowedOrigins);
  if (allowedOrigins.size === 0) throw new Error("CONFIG_MISSING: web auth configuration");
  const allowedHosts = new Set(input.allowedHosts ?? ["127.0.0.1", "localhost"]);
  const publicHosts = new Set([...allowedOrigins].map((origin) => new URL(origin).hostname.toLowerCase()));
  const secureCookies = [...allowedOrigins].some((origin) => origin.startsWith("https://"));
  const auth = createWebAuth(input.db, sessionSecret);
  const authenticated = (cookie: string | undefined) => auth.session(cookieValue(cookie, "po_session"));
  const isPublicRequest = (request: { headers: { host?: string | undefined } }) => publicHosts.has(hostName(request.headers.host) ?? "");
  const isTrustedLanRequest = (request: { headers: { host?: string | undefined }; ip: string }) => !isPublicRequest(request) && trustedAddress(request.ip);
  const publicPaths = new Set(["/health", "/bootstrap", "/bootstrap/register", "/bootstrap/login"]);
  app.decorate("closeEventStreams", () => closeEventStreams(eventStreams));
  app.addHook("onRequest", async (request, reply) => {
    const host = hostName(request.headers.host), lan = isTrustedLanRequest(request);
    if (!host || (!allowedHosts.has(host) && !lan)) return reply.code(403).send({ error: "invalid host" });
    if (request.headers.origin !== undefined && !allowedOrigins.has(request.headers.origin) && !lan) return reply.code(403).send({ error: "invalid origin" });
    if (publicPaths.has(request.url) || lan) return;
    const session = authenticated(request.headers.cookie);
    if (!session) return reply.code(403).send({ error: "unauthorized" });
    if (request.url === "/logout") return;
    const apiRequest = request.url.startsWith("/api/");
    if (!apiRequest) {
      if (request.method !== "GET" && request.method !== "HEAD") return reply.code(405).send({ error: "method not allowed" });
      return;
    }
    const writes = request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";
    if (writes && (!request.headers.origin || !auth.validateCsrf(cookieValue(request.headers.cookie, "po_session"), String(request.headers["x-csrf-token"] ?? "")))) return reply.code(403).send({ error: "csrf" });
  });
  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : "internal error";
    const status = message.includes("REVISION_CONFLICT") ? 409 : message.startsWith("NOT_FOUND") ? 404 : /^(POLICY_VIOLATION|SAFETY_BASELINE_INCOMPATIBLE|CONFIG_INVALID)/.test(message) ? 400 : typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : 500;
    return reply.code(status).send({ error: message });
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    reply.header("Content-Security-Policy", buildCsp(randomBytes(16).toString("base64url"))).header("X-Content-Type-Options", "nosniff").header("Referrer-Policy", request.url.startsWith("/bootstrap") ? "same-origin" : "no-referrer").header("X-Frame-Options", "DENY");
    return payload;
  });
  const handlers = input.handlers ?? createConfigHandlers(new ConfigService(new SqliteConfigRepository(input.db), input.content), input.db);
  registerConfigRoutes(app, handlers); registerReadRoutes(app, input.db, input.content);
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16 * 1024 }, (_request, body, done) => done(null, body));
  const page = (reply: FastifyReply, error?: { status: number; message: string }) => reply.code(error?.status ?? 200).header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(bootstrapPage(randomBytes(16).toString("base64url"), !auth.hasUsers(), error ? escapeHtml(error.message) : undefined));
  app.get("/health", async (_request, reply) => reply.header("Cache-Control", "no-store").send({ ok: true }));
  app.get("/bootstrap", async (request, reply) => isTrustedLanRequest(request) ? reply.redirect("/") : page(reply));
  app.post("/bootstrap/register", async (request, reply) => {
    if (formValue(request.body, "password") !== formValue(request.body, "confirm_password")) return page(reply, { status: 400, message: "两次输入的密码不一致。" });
    try { const login = await auth.registerFirstUser({ username: formValue(request.body, "username"), password: formValue(request.body, "password") }); return reply.header("Cache-Control", "no-store").header("Set-Cookie", sessionCookie(login.sessionToken, secureCookies)).redirect("/"); } catch (error) { return page(reply, authError(error)); }
  });
  app.post("/bootstrap/login", async (request, reply) => {
    try { const login = await auth.login({ username: formValue(request.body, "username"), password: formValue(request.body, "password") }, request.ip); return reply.header("Cache-Control", "no-store").header("Set-Cookie", sessionCookie(login.sessionToken, secureCookies)).redirect("/"); } catch (error) { return page(reply, authError(error)); }
  });
  app.post("/logout", async (request, reply) => { auth.logout(cookieValue(request.headers.cookie, "po_session")); return reply.header("Set-Cookie", clearSessionCookie(secureCookies)).redirect("/bootstrap"); });
  app.get("/api/read/session", async (request, reply) => reply.header("Cache-Control", "no-store").send({ csrf_token: isTrustedLanRequest(request) ? "lan-bypass" : authenticated(request.headers.cookie)?.csrfToken }));
  app.get("/api/stream/events", streamEvents(new EventRepository(input.db), input.ssePollIntervalMs, eventStreams));
  const root = resolve(input.staticDirectory ?? new URL("../../../web-console/dist", import.meta.url).pathname);
  if (existsSync(root)) {
    app.register(fastifyStatic, { root: resolve(root, "assets"), prefix: "/assets/", wildcard: true, decorateReply: false, maxAge: "1y", immutable: true });
    const indexPath = resolve(root, "index.html"), index = () => readFileSync(indexPath, "utf8");
    app.get("/", async (_request, reply) => reply.header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(index()));
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      if (request.method !== "GET" && request.method !== "HEAD") return reply.code(405).send({ error: "method not allowed" });
      return reply.header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(index());
    });
  }
  return app as unknown as WebListener;
}
