import type {
  ArtifactSummary,
  MemorySummary,
  RoleDraft,
  RoleSummary,
  RunDetail,
  RunEvent,
  RunSummary,
  SystemDiagnostics,
  WorkflowDraft,
  WorkflowSummary,
} from "./types";
const MAX_JSON_BYTES = 2 * 1024 * 1024;
type Fetch = typeof fetch;
type ClientOptions = { fetch?: Fetch; csrfToken?: string };
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const csrf = () =>
  document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ??
  "";
export function createApiClient(options: ClientOptions = {}) {
  const fetcher = options.fetch ?? fetch;
  let csrfToken = options.csrfToken ?? csrf();
  const resolvedCsrfToken = async (): Promise<string> => {
    if (csrfToken && !csrfToken.startsWith("__PO_")) return csrfToken;
    const response = await fetcher("/api/read/session", {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    if (!response.ok)
      throw new ApiError(response.status, "Session unavailable");
    const session = (await response.json()) as { csrf_token?: unknown };
    if (typeof session.csrf_token !== "string" || !session.csrf_token)
      throw new ApiError(502, "Invalid session response");
    csrfToken = session.csrf_token;
    return csrfToken;
  };
  const request = async <T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> => {
    if (!path.startsWith("/api/config/") && !path.startsWith("/api/read/"))
      throw new Error("API_BOUNDARY_VIOLATION");
    const method = init.method ?? "GET",
      headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (method !== "GET" && method !== "HEAD") {
      headers.set("Content-Type", "application/json");
      headers.set("X-CSRF-Token", await resolvedCsrfToken());
    }
    const response = await fetcher(path, {
      ...init,
      method,
      headers,
      credentials: "same-origin",
    });
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAX_JSON_BYTES)
      throw new ApiError(502, "Response is too large");
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES)
      throw new ApiError(502, "Response is too large");
    let value: unknown = null;
    if (text)
      try {
        value = JSON.parse(text);
      } catch {
        throw new ApiError(502, "Invalid server response");
      }
    if (!response.ok) {
      const message =
        typeof value === "object" && value !== null && "error" in value
          ? String((value as { error: unknown }).error)
          : `Request failed (${response.status})`;
      throw new ApiError(response.status, message);
    }
    return value as T;
  };
  const query = (values: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(values)) if (v) p.set(k, v);
    return p.size ? `?${p}` : "";
  };
  return Object.freeze({
    workflows: Object.freeze({
      list: () => request<WorkflowSummary[]>("/api/read/workflows"),
      getDraft: (id: string, source: boolean | string = false) =>
        request<WorkflowDraft>(
          typeof source === "string"
            ? `/api/read/workflow-versions/${encodeURIComponent(source)}`
            : `/api/read/workflow-drafts/${encodeURIComponent(id)}${source ? "?source=published" : ""}`,
        ),
      getVersion: (versionId: string) =>
        request<WorkflowDraft>(
          `/api/read/workflow-versions/${encodeURIComponent(versionId)}`,
        ),
      saveDraft: async (
        id: string,
        d: Pick<WorkflowDraft, "revision" | "envelope">,
      ) => {
        const saved = await request<{ revision: number }>(
          `/api/config/workflow-drafts/${encodeURIComponent(id)}`,
          {
            method: "POST",
            body: JSON.stringify({
              expected_revision: d.revision,
              envelope: d.envelope,
            }),
          },
        );
        return {
          entity_id: id,
          revision: saved.revision,
          envelope: d.envelope,
          updated_at: new Date().toISOString(),
        };
      },
      publish: (
        id: string,
        envelope: WorkflowDraft["envelope"],
        description?: string,
        expectedRevision?: number,
      ) =>
        request(`/api/config/workflows/${encodeURIComponent(id)}/publish`, {
          method: "POST",
          body: JSON.stringify({
            envelope,
            description,
            expected_revision: expectedRevision,
          }),
        }),
    }),
    roles: Object.freeze({
      list: (includeRemoved = false) =>
        request<RoleSummary[]>(
          `/api/read/roles${includeRemoved ? "?include_removed=1" : ""}`,
        ),
      create: (input: {
        slug: string;
        display_name: string;
        responsibilities: string[];
        requested_capabilities: string[];
        body_markdown?: string;
      }) =>
        request<{ roleId: string; slug: string }>("/api/config/roles", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      remove: (id: string) =>
        request<{ removed: boolean }>(
          `/api/config/roles/${encodeURIComponent(id)}`,
          { method: "DELETE" },
        ),
      restore: (id: string) =>
        request<{ restored: boolean }>(
          `/api/config/roles/${encodeURIComponent(id)}/restore`,
          { method: "POST", body: "{}" },
        ),
      resetBuiltin: (id: string) =>
        request<{ versionNumber: number }>(
          `/api/config/roles/${encodeURIComponent(id)}/reset-builtin`,
          { method: "POST", body: "{}" },
        ),
      getDraft: (id: string, source: boolean | string = false) =>
        request<RoleDraft>(
          typeof source === "string"
            ? `/api/read/role-versions/${encodeURIComponent(source)}`
            : `/api/read/role-drafts/${encodeURIComponent(id)}${source ? "?source=published" : ""}`,
        ),
      getVersion: (versionId: string) =>
        request<WorkflowDraft>(
          `/api/read/workflow-versions/${encodeURIComponent(versionId)}`,
        ),
      saveDraft: async (
        id: string,
        d: Pick<RoleDraft, "revision" | "envelope">,
      ) => {
        const saved = await request<{ revision: number }>(
          `/api/config/role-drafts/${encodeURIComponent(id)}`,
          {
            method: "POST",
            body: JSON.stringify({
              expected_revision: d.revision,
              envelope: d.envelope,
            }),
          },
        );
        return {
          entity_id: id,
          revision: saved.revision,
          envelope: d.envelope,
          updated_at: new Date().toISOString(),
        };
      },
      publish: async (
        id: string,
        envelope: RoleDraft["envelope"],
        expectedRevision?: number,
        status?: "active" | "disabled" | "archived",
      ) => {
        const published = await request<Record<string, unknown>>(
          `/api/config/roles/${encodeURIComponent(id)}/publish`,
          {
            method: "POST",
            body: JSON.stringify({
              envelope,
              expected_revision: expectedRevision,
              status,
            }),
          },
        );
        const role = (await request<RoleSummary[]>("/api/read/roles")).find(
          (item) => item.id === id,
        );
        return {
          ...published,
          effectiveCapabilities: role?.effective_capabilities ?? [],
        };
      },
    }),
    runs: Object.freeze({
      list: (filters: Record<string, string | undefined> = {}) =>
        request<RunSummary[]>(`/api/read/runs${query(filters)}`),
      get: (id: string) =>
        request<RunDetail>(`/api/read/runs/${encodeURIComponent(id)}`),
    }),
    events: Object.freeze({
      list: (runId: string, after = 0) =>
        request<RunEvent[]>(
          `/api/read/events/${encodeURIComponent(runId)}?after=${after}`,
        ),
    }),
    artifacts: Object.freeze({
      list: (runId: string) =>
        request<ArtifactSummary[]>(
          `/api/read/artifacts?run_id=${encodeURIComponent(runId)}`,
        ),
      downloadUrl: (id: string) =>
        `/api/read/artifact-content/${encodeURIComponent(id)}`,
    }),
    memories: Object.freeze({
      list: (projectId?: string) =>
        request<MemorySummary[]>(
          `/api/read/memories${query({ project_id: projectId })}`,
        ),
    }),
    system: Object.freeze({
      diagnostics: () =>
        request<SystemDiagnostics>("/api/read/system/diagnostics"),
    }),
  });
}
export type ApiClient = ReturnType<typeof createApiClient>;
export const api = createApiClient();
