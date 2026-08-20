import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api/client";
describe("boundary-safe Web API client", () => {
  it("exposes only named config and read operations", () => {
    const api = createApiClient({ fetch: vi.fn() });
    expect(Object.keys(api.workflows).sort()).toEqual([
      "getDraft",
      "list",
      "publish",
      "saveDraft",
    ]);
    expect(Object.keys(api.roles).sort()).toEqual([
      "getDraft",
      "list",
      "publish",
      "saveDraft",
    ]);
    expect(Object.keys(api.runs).sort()).toEqual(["get", "list"]);
    expect(Object.keys(api.events)).toEqual(["list"]);
    expect(Object.keys(api.artifacts).sort()).toEqual(["downloadUrl", "list"]);
    expect(Object.keys(api.system)).toEqual(["diagnostics"]);
    expect(api).not.toHaveProperty("post");
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
});
