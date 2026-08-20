import type { FastifyInstance } from 'fastify';
import type { ConfigService } from '@project-orchestrator/orchestrator-service';

type SaveDraftBody = { expected_revision: number; envelope: unknown };
type PublishBody = { envelope: unknown; description?: string };
export type ConfigHandlers = {
  saveWorkflowDraft: (entityId: string, body: SaveDraftBody) => unknown;
  publishWorkflow: (entityId: string, body: PublishBody) => unknown;
  saveRoleDraft: (entityId: string, body: SaveDraftBody) => unknown;
  publishRole: (entityId: string, body: PublishBody) => unknown;
};

const wildcard = (params: unknown): string => String((params as { '*': string })['*']);
const routeId = (params: unknown): string => String((params as { id: string }).id);

export function createConfigHandlers(service: ConfigService): ConfigHandlers {
  return {
    saveWorkflowDraft: (entityId, body) => service.saveWorkflowDraft({
      entityId, expectedRevision: body.expected_revision, envelope: body.envelope,
    }),
    publishWorkflow: (workflowTemplateId, body) => service.publishWorkflow({
      workflowTemplateId, envelope: body.envelope,
      ...(body.description === undefined ? {} : { description: body.description }),
    }),
    saveRoleDraft: (entityId, body) => service.saveRoleDraft({
      entityId, expectedRevision: body.expected_revision, envelope: body.envelope,
    }),
    publishRole: (roleId, body) => service.publishRole({ roleId, envelope: body.envelope }),
  };
}

export function registerConfigRoutes(app: FastifyInstance, handlers: ConfigHandlers): void {
  app.post('/api/config/workflow-drafts/*', async (request) => (
    handlers.saveWorkflowDraft(wildcard(request.params), request.body as SaveDraftBody)
  ));
  app.post('/api/config/workflows/:id/publish', async (request) => (
    handlers.publishWorkflow(routeId(request.params), request.body as PublishBody)
  ));
  app.post('/api/config/role-drafts/*', async (request) => (
    handlers.saveRoleDraft(wildcard(request.params), request.body as SaveDraftBody)
  ));
  app.post('/api/config/roles/:id/publish', async (request) => (
    handlers.publishRole(routeId(request.params), request.body as PublishBody)
  ));
}
