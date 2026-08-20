import { randomUUID } from 'node:crypto';
import {
  ContractValidator,
  RoleVersionEnvelopeSchema,
  WorkflowVersionEnvelopeSchema,
  type RoleVersionEnvelope,
  type WorkflowVersionEnvelope,
} from '@project-orchestrator/contracts';
import { canonicalJson, type ContentStore } from '@project-orchestrator/content-store';
import {
  type PublishedWorkflowRecord,
  type SqliteConfigRepository,
} from '@project-orchestrator/sqlite-store';

export type SaveDraftInput = { entityId: string; expectedRevision: number; envelope: unknown };
export type SavedDraft = Readonly<{ revision: number }>;
export type PublishRoleInput = { roleId: string; envelope: unknown };
export type PublishWorkflowInput = { workflowTemplateId: string; envelope: unknown; description?: string };
export type PublishedVersion = Readonly<{
  id: string;
  slug: string;
  versionNumber: number;
  contentObjectId: string;
  contentHash: string;
}>;

export type ConfigServiceOptions = {
  capabilityAllowlist?: readonly string[];
  safetyBaselineVersion?: number;
};

const DEFAULT_CAPABILITY_ALLOWLIST = [
  'read-workspace',
  'write-workspace',
  'network-read',
  'execute-tests',
  'managed-side-effect',
] as const;

const NEVER_REQUESTABLE = new Set(['production-shell', 'raw-production-credentials', 'secret-read']);

export class ConfigService {
  readonly #validator = new ContractValidator();
  readonly #capabilityAllowlist: Set<string>;
  readonly #safetyBaselineVersion: number;

  constructor(
    readonly repository: SqliteConfigRepository,
    readonly contentStore: ContentStore,
    options: ConfigServiceOptions = {},
  ) {
    this.#capabilityAllowlist = new Set(options.capabilityAllowlist ?? DEFAULT_CAPABILITY_ALLOWLIST);
    this.#safetyBaselineVersion = options.safetyBaselineVersion ?? 1;
  }

  saveWorkflowDraft(input: SaveDraftInput): SavedDraft {
    return Object.freeze({
      revision: this.repository.saveWorkflowDraft(input.entityId, input.expectedRevision, input.envelope),
    });
  }

  saveRoleDraft(input: SaveDraftInput): SavedDraft {
    return Object.freeze({
      revision: this.repository.saveRoleDraft(input.entityId, input.expectedRevision, input.envelope),
    });
  }

  publishRole(input: PublishRoleInput): PublishedVersion {
    const envelope = this.#validator.check(RoleVersionEnvelopeSchema, input.envelope) as RoleVersionEnvelope;
    canonicalJson(envelope);
    const role = this.repository.getRole(input.roleId);
    if (role === undefined || role.status !== 'active') throw new Error(`NOT_FOUND: active role ${input.roleId}`);
    if (role.slug !== envelope.data.slug) throw new Error('POLICY_VIOLATION: role slug does not match parent');

    for (const capability of envelope.data.requested_capabilities) {
      if (NEVER_REQUESTABLE.has(capability) || envelope.data.forbidden_capabilities.includes(capability)) {
        throw new Error(`POLICY_VIOLATION: forbidden capability ${capability}`);
      }
    }
    const effectiveCapabilities = envelope.data.requested_capabilities
      .filter((capability) => this.#capabilityAllowlist.has(capability));
    const content = this.contentStore.putCanonicalJson(envelope);
    const versionNumber = this.repository.nextRoleVersion(input.roleId);
    const id = randomUUID();
    this.repository.publishRole({
      id,
      roleId: input.roleId,
      versionNumber,
      contentObjectId: content.id,
      skillHash: content.sha256,
      inputSchemaEnvelope: envelope.data.input_schema,
      outputSchemaEnvelope: envelope.data.output_schema,
      requestedCapabilities: [...envelope.data.requested_capabilities],
      effectiveCapabilities,
      forbiddenCapabilities: [...envelope.data.forbidden_capabilities],
      completionContractEnvelope: envelope.data.completion_contract,
    });
    return Object.freeze({
      id, slug: role.slug, versionNumber, contentObjectId: content.id, contentHash: content.sha256,
    });
  }

  publishWorkflow(input: PublishWorkflowInput): PublishedVersion {
    const envelope = this.#validator.check(WorkflowVersionEnvelopeSchema, input.envelope) as WorkflowVersionEnvelope;
    canonicalJson(envelope);
    const template = this.repository.getWorkflowTemplate(input.workflowTemplateId);
    if (template === undefined || template.status !== 'active') {
      throw new Error(`NOT_FOUND: active workflow template ${input.workflowTemplateId}`);
    }
    if (template.slug !== envelope.data.slug) throw new Error('POLICY_VIOLATION: workflow slug does not match parent');
    const versionNumber = this.repository.nextWorkflowVersion(input.workflowTemplateId);
    if (envelope.data.version !== versionNumber) throw new Error('POLICY_VIOLATION: workflow envelope version is not next');
    this.validateWorkflowPolicy(envelope);

    const content = this.contentStore.putCanonicalJson(envelope);
    const id = randomUUID();
    this.repository.publishWorkflow({
      id,
      workflowTemplateId: input.workflowTemplateId,
      versionNumber,
      description: input.description ?? '',
      safetyBaselineVersion: this.#safetyBaselineVersion,
      contentObjectId: content.id,
      contentHash: content.sha256,
    });
    return Object.freeze({
      id, slug: template.slug, versionNumber, contentObjectId: content.id, contentHash: content.sha256,
    });
  }

  listPublishedTemplates(taskType?: string): PublishedWorkflowRecord[] {
    return this.repository.listPublishedWorkflows(taskType);
  }

  readPublishedContent(contentObjectId: string): Uint8Array {
    return this.contentStore.read(contentObjectId);
  }

  private validateWorkflowPolicy(envelope: WorkflowVersionEnvelope): void {
    const stages = envelope.data.stages;
    const stageByKey = new Map<string, (typeof stages)[number]>();
    for (const stage of stages) {
      if (stageByKey.has(stage.key)) throw new Error(`POLICY_VIOLATION: duplicate stage key ${stage.key}`);
      stageByKey.set(stage.key, stage);
      const role = this.repository.getPublishedRole(stage.role_version_id);
      if (role === undefined || role.status !== 'published' || role.roleStatus !== 'active') {
        throw new Error(`POLICY_VIOLATION: stage ${stage.key} references an inactive or missing role`);
      }
    }

    const adjacency = new Map<string, string[]>();
    for (const key of stageByKey.keys()) adjacency.set(key, []);
    for (const edge of envelope.data.edges) {
      const from = stageByKey.get(edge.from);
      const to = stageByKey.get(edge.to);
      if (from === undefined || to === undefined) throw new Error('POLICY_VIOLATION: edge references missing stage');
      if (to.mandatory_gate && edge.condition !== undefined) {
        throw new Error(`POLICY_VIOLATION: mandatory gate ${to.key} has a conditional dependency`);
      }
      adjacency.get(edge.from)?.push(edge.to);
    }
    this.assertAcyclic(adjacency);

    const groupKeys = new Set<string>();
    for (const group of envelope.data.iteration_groups) {
      if (groupKeys.has(group.key)) throw new Error(`POLICY_VIOLATION: duplicate iteration group ${group.key}`);
      groupKeys.add(group.key);
      if (group.max_iterations > 3) throw new Error('POLICY_VIOLATION: max_iterations exceeds 3');
      const entry = stageByKey.get(group.entry_stage_key);
      if (entry?.iteration_group_key !== group.key) throw new Error('POLICY_VIOLATION: iteration entry is missing');
      for (const gateKey of group.gate_stage_keys) {
        const gate = stageByKey.get(gateKey);
        if (gate === undefined || !gate.mandatory_gate || gate.optional || gate.condition !== undefined
          || gate.iteration_group_key !== group.key) {
          throw new Error(`POLICY_VIOLATION: mandatory gate ${gateKey} is missing or bypassable`);
        }
      }
    }

    for (const stage of stages) {
      if (stage.mandatory_gate && (stage.iteration_group_key === undefined || !groupKeys.has(stage.iteration_group_key))) {
        throw new Error(`POLICY_VIOLATION: mandatory gate ${stage.key} has no iteration group`);
      }
    }
  }

  private assertAcyclic(adjacency: ReadonlyMap<string, readonly string[]>): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (key: string): void => {
      if (visiting.has(key)) throw new Error('POLICY_VIOLATION: workflow dependency cycle');
      if (visited.has(key)) return;
      visiting.add(key);
      for (const next of adjacency.get(key) ?? []) visit(next);
      visiting.delete(key);
      visited.add(key);
    };
    for (const key of adjacency.keys()) visit(key);
  }
}
