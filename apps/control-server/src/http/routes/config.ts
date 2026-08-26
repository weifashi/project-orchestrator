import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { ConfigService } from "@project-orchestrator/orchestrator-service";

type SaveDraftBody = { expected_revision: number; envelope: unknown };
type PublishBody = {
  envelope: unknown;
  description?: string;
  expected_revision: number;
  status?: "active" | "disabled" | "archived";
};
type CreateRoleBody = {
  slug?: unknown;
  display_name?: unknown;
  responsibilities?: unknown;
  requested_capabilities?: unknown;
  body_markdown?: unknown;
};
export type ConfigHandlers = {
  saveWorkflowDraft: (entityId: string, body: SaveDraftBody) => unknown;
  publishWorkflow: (entityId: string, body: PublishBody) => unknown;
  saveRoleDraft: (entityId: string, body: SaveDraftBody) => unknown;
  publishRole: (entityId: string, body: PublishBody) => unknown;
  createRole: (body: CreateRoleBody) => unknown;
  removeRole: (roleId: string) => unknown;
  restoreRole: (roleId: string) => unknown;
  resetRoleToBuiltin: (roleId: string) => unknown;
};

const stringList = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value)) throw new Error(`CONFIG_INVALID: ${field}`);
  return value.map((item) => {
    if (typeof item !== "string" || item.trim() === "")
      throw new Error(`CONFIG_INVALID: ${field}`);
    return item.trim();
  });
};

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`CONFIG_INVALID: ${field}`);
  return value.trim();
};

const wildcard = (params: unknown): string =>
  String((params as { "*": string })["*"]);
const routeId = (params: unknown): string =>
  String((params as { id: string }).id);

export function createConfigHandlers(
  service: ConfigService,
  db?: Database.Database,
): ConfigHandlers {
  const assertRevision = (
    table: "workflow_drafts" | "role_drafts",
    parent: string,
    id: string,
    expected: number,
  ): void => {
    if (!Number.isSafeInteger(expected) || expected < 0)
      throw new Error("CONFIG_INVALID: expected revision");
    if (db === undefined) return;
    const row = db
      .prepare(`SELECT revision FROM ${table} WHERE ${parent}=?`)
      .get(id) as { revision: number } | undefined;
    if ((row?.revision ?? 0) !== expected) throw new Error("REVISION_CONFLICT");
  };
  return {
    saveWorkflowDraft: (entityId, body) =>
      service.saveWorkflowDraft({
        entityId,
        expectedRevision: body.expected_revision,
        envelope: body.envelope,
      }),
    publishWorkflow: (workflowTemplateId, body) => {
      const publish = () => {
        assertRevision(
          "workflow_drafts",
          "workflow_template_id",
          workflowTemplateId,
          body.expected_revision,
        );
        const result = service.publishWorkflow({
          workflowTemplateId,
          envelope: body.envelope,
          ...(body.description === undefined
            ? {}
            : { description: body.description }),
        });
        db?.prepare(
          "DELETE FROM workflow_drafts WHERE workflow_template_id=?",
        ).run(workflowTemplateId);
        return result;
      };
      return db === undefined ? publish() : db.transaction(publish).immediate();
    },
    saveRoleDraft: (entityId, body) =>
      service.saveRoleDraft({
        entityId,
        expectedRevision: body.expected_revision,
        envelope: body.envelope,
      }),
    publishRole: (roleId, body) => {
      const publish = () => {
        assertRevision(
          "role_drafts",
          "role_id",
          roleId,
          body.expected_revision,
        );
        if (body.status !== undefined)
          db?.prepare(
            "UPDATE roles SET status='active',updated_at=? WHERE id=? AND status='disabled'",
          ).run(new Date().toISOString(), roleId);
        const result = service.publishRole({ roleId, envelope: body.envelope });
        db?.prepare("DELETE FROM role_drafts WHERE role_id=?").run(roleId);
        if (body.status === "disabled" || body.status === "archived")
          db?.prepare(
            "UPDATE roles SET status=?,updated_at=? WHERE id=?",
          ).run(body.status, new Date().toISOString(), roleId);
        return result;
      };
      return db === undefined ? publish() : db.transaction(publish).immediate();
    },
    createRole: (body) => {
      const input = {
        slug: requiredString(body.slug, "slug"),
        displayName: requiredString(body.display_name, "display_name"),
        responsibilities: stringList(body.responsibilities, "responsibilities"),
        requestedCapabilities: stringList(
          body.requested_capabilities ?? [],
          "requested_capabilities",
        ),
        ...(typeof body.body_markdown === "string"
          ? { bodyMarkdown: body.body_markdown }
          : {}),
      };
      const create = () => service.createRole(input);
      return db === undefined ? create() : db.transaction(create).immediate();
    },
    removeRole: (roleId) => service.removeRole(roleId),
    restoreRole: (roleId) => service.restoreRole(roleId),
    resetRoleToBuiltin: (roleId) => {
      const reset = () => service.resetRoleToBuiltin(roleId);
      return db === undefined ? reset() : db.transaction(reset).immediate();
    },
  };
}

export function registerConfigRoutes(
  app: FastifyInstance,
  handlers: ConfigHandlers,
): void {
  app.post("/api/config/workflow-drafts/*", async (request) =>
    handlers.saveWorkflowDraft(
      wildcard(request.params),
      request.body as SaveDraftBody,
    ),
  );
  app.post("/api/config/workflows/:id/publish", async (request) =>
    handlers.publishWorkflow(
      routeId(request.params),
      request.body as PublishBody,
    ),
  );
  app.post("/api/config/role-drafts/*", async (request) =>
    handlers.saveRoleDraft(
      wildcard(request.params),
      request.body as SaveDraftBody,
    ),
  );
  app.post("/api/config/roles/:id/publish", async (request) =>
    handlers.publishRole(routeId(request.params), request.body as PublishBody),
  );
  app.post("/api/config/roles", async (request) =>
    handlers.createRole((request.body ?? {}) as CreateRoleBody),
  );
  app.delete("/api/config/roles/:id", async (request) =>
    handlers.removeRole(routeId(request.params)),
  );
  app.post("/api/config/roles/:id/restore", async (request) =>
    handlers.restoreRole(routeId(request.params)),
  );
  app.post("/api/config/roles/:id/reset-builtin", async (request) =>
    handlers.resetRoleToBuiltin(routeId(request.params)),
  );
}
