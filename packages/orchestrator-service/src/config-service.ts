import { randomUUID } from 'node:crypto';
import {
  ContractValidator,
  RoleVersionEnvelopeSchema,
  WorkflowVersionEnvelopeSchema,
  type RoleVersionEnvelope,
  type WorkflowVersionEnvelope,
  type ConditionExpression,
} from '@project-orchestrator/contracts';
import { canonicalJson, type ContentStore } from '@project-orchestrator/content-store';
import { validateWorkflowGraph } from '@project-orchestrator/workflow-engine';
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
  readonly #repository: SqliteConfigRepository;
  readonly #contentStore: ContentStore;
  readonly #capabilityAllowlist: Set<string>;
  readonly #safetyBaselineVersion: number;

  constructor(
    repository: SqliteConfigRepository,
    contentStore: ContentStore,
    options: ConfigServiceOptions = {},
  ) {
    this.#repository = repository;
    this.#contentStore = contentStore;
    this.#capabilityAllowlist = new Set(options.capabilityAllowlist ?? DEFAULT_CAPABILITY_ALLOWLIST);
    const safetyBaselineVersion = options.safetyBaselineVersion ?? 1;
    if (safetyBaselineVersion !== 1) {
      throw new Error(`SAFETY_BASELINE_INCOMPATIBLE: unsupported baseline version ${safetyBaselineVersion}`);
    }
    this.#safetyBaselineVersion = safetyBaselineVersion;
  }

  saveWorkflowDraft(input: SaveDraftInput): SavedDraft {
    return Object.freeze({
      revision: this.#repository.saveWorkflowDraft(input.entityId, input.expectedRevision, input.envelope),
    });
  }

  saveRoleDraft(input: SaveDraftInput): SavedDraft {
    return Object.freeze({
      revision: this.#repository.saveRoleDraft(input.entityId, input.expectedRevision, input.envelope),
    });
  }

  publishRole(input: PublishRoleInput): PublishedVersion {
    const envelope = this.#validator.check(RoleVersionEnvelopeSchema, input.envelope) as RoleVersionEnvelope;
    canonicalJson(envelope);
    const role = this.#repository.getRole(input.roleId);
    if (role === undefined || role.status !== 'active') throw new Error(`NOT_FOUND: active role ${input.roleId}`);
    if (role.slug !== envelope.data.slug) throw new Error('POLICY_VIOLATION: role slug does not match parent');

    for (const capability of envelope.data.requested_capabilities) {
      if (NEVER_REQUESTABLE.has(capability) || envelope.data.forbidden_capabilities.includes(capability)) {
        throw new Error(`POLICY_VIOLATION: forbidden capability ${capability}`);
      }
    }
    const effectiveCapabilities = envelope.data.requested_capabilities
      .filter((capability) => this.#capabilityAllowlist.has(capability));
    const content = this.#contentStore.putCanonicalJson(envelope);
    const versionNumber = this.#repository.nextRoleVersion(input.roleId);
    const id = randomUUID();
    this.#repository.publishRole({
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
    const template = this.#repository.getWorkflowTemplate(input.workflowTemplateId);
    if (template === undefined || template.status !== 'active') {
      throw new Error(`NOT_FOUND: active workflow template ${input.workflowTemplateId}`);
    }
    if (template.slug !== envelope.data.slug) throw new Error('POLICY_VIOLATION: workflow slug does not match parent');
    const versionNumber = this.#repository.nextWorkflowVersion(input.workflowTemplateId);
    if (envelope.data.version !== versionNumber) throw new Error('POLICY_VIOLATION: workflow envelope version is not next');
    this.validateWorkflowPolicy(template.slug, envelope);

    const content = this.#contentStore.putCanonicalJson(envelope);
    const id = randomUUID();
    this.#repository.publishWorkflow({
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
    return this.#repository.listPublishedWorkflows(taskType);
  }

  private validateWorkflowPolicy(templateSlug: string, envelope: WorkflowVersionEnvelope): void {
    validateWorkflowGraph(envelope.data);
    const stages = envelope.data.stages;
    const stageByKey = new Map<string, (typeof stages)[number]>();
    const roleSlugByStage = new Map<string, string>();
    for (const stage of stages) {
      if (stageByKey.has(stage.key)) throw new Error(`POLICY_VIOLATION: duplicate stage key ${stage.key}`);
      stageByKey.set(stage.key, stage);
      const role = this.#repository.getPublishedRole(stage.role_version_id);
      if (role === undefined || role.status !== 'published' || role.roleStatus !== 'active') {
        throw new Error(`POLICY_VIOLATION: stage ${stage.key} references an inactive or missing role`);
      }
      roleSlugByStage.set(stage.key, role.slug);
    }

    this.assertBuiltInBaseline(templateSlug, envelope, stageByKey, roleSlugByStage);
  }

  private assertBuiltInBaseline(
    templateSlug: string,
    envelope: WorkflowVersionEnvelope,
    stages: ReadonlyMap<string, WorkflowVersionEnvelope['data']['stages'][number]>,
    roleSlugs: ReadonlyMap<string, string>,
  ): void {
    const requireStage = (
      key: string,
      options: { optional?: boolean; condition?: ConditionExpression; confirmation?: boolean } = {},
    ): void => {
      const stage = stages.get(key);
      if (stage === undefined || roleSlugs.get(key) !== key) {
        throw new Error(`SAFETY_BASELINE_INCOMPATIBLE: required ${key} stage is missing or uses the wrong role`);
      }
      if (stage.optional !== (options.optional ?? false)) {
        throw new Error(`SAFETY_BASELINE_INCOMPATIBLE: ${key} optional policy changed`);
      }
      if (canonicalJson(stage.condition ?? null) !== canonicalJson(options.condition ?? null)) {
        throw new Error(`SAFETY_BASELINE_INCOMPATIBLE: ${key} condition changed`);
      }
      if (options.confirmation === true && !stage.requires_confirmation) {
        throw new Error(`SAFETY_BASELINE_INCOMPATIBLE: ${key} confirmation was removed`);
      }
    };
    const anyTrue = (paths: string[]): ConditionExpression => ({
      op: 'any', items: paths.map((path) => ({ op: 'eq', path, value: true })),
    });
    const requireDependency = (from: string, to: string, edgeType: 'requires' | 'on_success'): void => {
      const present = envelope.data.edges.some((edge) => edge.from === from && edge.to === to
        && edge.edge_type === edgeType && edge.condition === undefined);
      if (!present) {
        throw new Error(`SAFETY_BASELINE_INCOMPATIBLE: required dependency ${from} -> ${to} is missing`);
      }
    };

    if (templateSlug === 'new-project') {
      for (const key of ['requirements', 'research', 'architecture', 'ui-design', 'implementation', 'code-review', 'testing', 'security', 'operations', 'memory-docs']) {
        requireStage(key, { confirmation: key === 'requirements' || key === 'operations' });
      }
      const group = envelope.data.iteration_groups.find((candidate) => candidate.key === 'delivery_loop');
      const requiredGates = ['code-review', 'testing', 'security'];
      if (group === undefined || group.entry_stage_key !== 'implementation'
        || requiredGates.some((gate) => !group.gate_stage_keys.includes(gate)) || group.max_iterations > 3) {
        throw new Error('SAFETY_BASELINE_INCOMPATIBLE: new-project delivery_loop was removed or weakened');
      }
      for (const gate of requiredGates) requireDependency(gate, 'operations', 'on_success');
      requireDependency('operations', 'memory-docs', 'on_success');
      return;
    }

    if (templateSlug === 'feature-development') {
      for (const key of ['research', 'implementation', 'code-review', 'testing', 'memory-docs']) requireStage(key);
      requireStage('architecture', { optional: true, condition: anyTrue(['/input/changes/api', '/input/changes/schema', '/input/changes/module_boundary']) });
      requireStage('ui-design', { optional: true, condition: anyTrue(['/input/user_visible_change']) });
      requireStage('security', { optional: true, condition: anyTrue(['/input/changes/permissions', '/input/changes/secrets', '/input/changes/external_input', '/input/changes/dependencies']) });
      requireStage('operations', { optional: true, confirmation: true, condition: anyTrue(['/input/changes/runtime', '/input/changes/migration', '/input/changes/release_artifact']) });
      for (const gate of ['code-review', 'testing', 'security']) {
        requireDependency('implementation', gate, 'requires');
        requireDependency(gate, 'operations', 'requires');
      }
      requireDependency('operations', 'memory-docs', 'requires');
      return;
    }

    if (templateSlug === 'bug-fix') {
      for (const key of ['research', 'implementation', 'code-review', 'testing', 'memory-docs']) requireStage(key);
      requireStage('architecture', { optional: true, condition: anyTrue(['/input/root_cause_changes_module_boundary']) });
      requireStage('ui-design', { optional: true, condition: anyTrue(['/input/user_visible_behavior_change']) });
      requireStage('security', { optional: true, condition: anyTrue(['/input/security_sensitive']) });
      requireStage('operations', { optional: true, confirmation: true, condition: anyTrue(['/input/requires_release', '/input/requires_migration']) });
      for (const gate of ['code-review', 'testing', 'security']) {
        requireDependency('implementation', gate, 'requires');
        requireDependency(gate, 'operations', 'requires');
      }
      requireDependency('operations', 'memory-docs', 'requires');
    }
  }
}
