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
export type ConfigHandlers = {
  saveWorkflowDraft: (entityId: string, body: SaveDraftBody) => unknown;
  publishWorkflow: (entityId: string, body: PublishBody) => unknown;
  saveRoleDraft: (entityId: string, body: SaveDraftBody) => unknown;
  publishRole: (entityId: string, body: PublishBody) => unknown;
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
}
