import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api/client";
describe("boundary-safe Web API client", () => {
  it("exposes only named config and read operations", () => {
    const api = createApiClient({ fetch: vi.fn() });
    expect(Object.keys(api.workflows).sort()).toEqual([
      "getDraft",
      "getVersion",
      "list",
      "publish",
      "saveDraft",
    ]);
    expect(Object.keys(api.roles).sort()).toEqual([
      "create",
      "getDraft",
      "getVersion",
      "list",
      "publish",
      "remove",
      "resetBuiltin",
      "restore",
      "saveDraft",
    ]);
    expect(Object.keys(api.runs).sort()).toEqual(["exportUrl", "get", "list"]);
    expect(Object.keys(api.events)).toEqual(["list"]);
    expect(Object.keys(api.artifacts).sort()).toEqual(["downloadUrl", "list"]);
    expect(Object.keys(api.memories).sort()).toEqual(["exportUrl", "list"]);
    expect(Object.keys(api.system)).toEqual(["diagnostics"]);
    expect(api).not.toHaveProperty("post");
  });
  it("builds encoded read-only export URLs without issuing a request", () => {
    const fetcher = vi.fn();
    const api = createApiClient({ fetch: fetcher });
    expect(api.runs.exportUrl("run/one", "markdown", "zh-CN")).toBe(
      "/api/read/run-exports/run%2Fone?format=markdown&lang=zh-CN",
    );
    expect(api.memories.exportUrl("project one", "json", "en")).toBe(
      "/api/read/memory-exports?format=json&lang=en&project_id=project+one",
    );
    expect(api.memories.exportUrl(undefined, "markdown", "zh-CN")).toBe(
      "/api/read/memory-exports?format=markdown&lang=zh-CN",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("sends CSRF only with config writes and never sends adapter credentials", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push([input, init]);
        return new Response(JSON.stringify({ revision: 2 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    const api = createApiClient({
      fetch: fetcher as typeof fetch,
      csrfToken: "csrf-test",
    });
    await api.workflows.saveDraft("one", {
      revision: 1,
      envelope: {} as never,
    });
    expect(new Headers(calls[0]?.[1]?.headers).get("x-csrf-token")).toBe(
      "csrf-test",
    );
    expect(JSON.stringify(calls)).not.toMatch(
      /adapter[_-]?credential|authorization/i,
    );
  });
  // request() 给所有非 GET 请求都加 Content-Type: application/json。
  // Fastify 对"声明了 JSON 却空 body"的请求直接 400，所以这些无入参的写操作
  // 必须送一个空对象，否则线上点了没反应。
  it.each([
    ["remove", (api: ReturnType<typeof createApiClient>) => api.roles.remove("one")],
    ["restore", (api: ReturnType<typeof createApiClient>) => api.roles.restore("one")],
    ["resetBuiltin", (api: ReturnType<typeof createApiClient>) => api.roles.resetBuiltin("one")],
  ])("sends a JSON body with %s so Fastify does not reject it", async (_name, call) => {
    const calls: RequestInit[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init) calls.push(init);
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const api = createApiClient({
      fetch: fetcher as typeof fetch,
      csrfToken: "csrf-test",
    });
    await call(api);
    expect(new Headers(calls[0]?.headers).get("content-type")).toBe("application/json");
    expect(calls[0]?.body).toBe("{}");
  });
});
