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
    this.#safetyBaselineVersion = options.safetyBaselineVersion ?? 1;
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
    this.assertReachable(adjacency);

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
        if (!this.isReachable(group.entry_stage_key, gateKey, adjacency)) {
          throw new Error(`POLICY_VIOLATION: mandatory gate ${gateKey} is not downstream of its iteration entry`);
        }
      }
    }

    for (const stage of stages) {
      if (stage.iteration_group_key !== undefined && !groupKeys.has(stage.iteration_group_key)) {
        throw new Error(`POLICY_VIOLATION: stage ${stage.key} references a missing iteration group`);
      }
      if (stage.mandatory_gate && stage.iteration_group_key === undefined) {
        throw new Error(`POLICY_VIOLATION: mandatory gate ${stage.key} has no iteration group`);
      }
      if (stage.iteration_group_key !== undefined) {
        const group = envelope.data.iteration_groups.find((candidate) => candidate.key === stage.iteration_group_key);
        if (group !== undefined && stage.key !== group.entry_stage_key && !group.gate_stage_keys.includes(stage.key)) {
          throw new Error(`POLICY_VIOLATION: stage ${stage.key} is not declared by iteration group ${group.key}`);
        }
      }
    }

    this.assertBuiltInBaseline(templateSlug, envelope, stageByKey, roleSlugByStage);
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

  private assertReachable(adjacency: ReadonlyMap<string, readonly string[]>): void {
    const indegree = new Map([...adjacency.keys()].map((key) => [key, 0]));
    for (const destinations of adjacency.values()) {
      for (const destination of destinations) indegree.set(destination, (indegree.get(destination) ?? 0) + 1);
    }
    const roots = [...indegree].filter(([, degree]) => degree === 0).map(([key]) => key);
    if (roots.length !== 1) throw new Error('POLICY_VIOLATION: workflow DAG must have exactly one reachable root');
    const reachable = new Set<string>();
    const visit = (key: string): void => {
      if (reachable.has(key)) return;
      reachable.add(key);
      for (const destination of adjacency.get(key) ?? []) visit(destination);
    };
    visit(roots[0] as string);
    if (reachable.size !== adjacency.size) throw new Error('POLICY_VIOLATION: workflow contains unreachable stages');
  }

  private isReachable(from: string, to: string, adjacency: ReadonlyMap<string, readonly string[]>): boolean {
    const pending = [from];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const key = pending.pop() as string;
      if (key === to) return true;
      if (visited.has(key)) continue;
      visited.add(key);
      pending.push(...(adjacency.get(key) ?? []));
    }
    return false;
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
    const requireDependency = (from: string, to: string, requireSuccess: boolean): void => {
      const present = envelope.data.edges.some((edge) => edge.from === from && edge.to === to
        && (!requireSuccess || edge.edge_type === 'on_success') && edge.condition === undefined);
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
      for (const gate of requiredGates) requireDependency(gate, 'operations', true);
      requireDependency('operations', 'memory-docs', true);
      return;
    }

    if (templateSlug === 'feature-development') {
      for (const key of ['research', 'implementation', 'code-review', 'testing', 'memory-docs']) requireStage(key);
      requireStage('architecture', { optional: true, condition: anyTrue(['run_input.changes.api', 'run_input.changes.schema', 'run_input.changes.module_boundary']) });
      requireStage('ui-design', { optional: true, condition: anyTrue(['run_input.user_visible_change']) });
      requireStage('security', { optional: true, condition: anyTrue(['run_input.changes.permissions', 'run_input.changes.secrets', 'run_input.changes.external_input', 'run_input.changes.dependencies']) });
      requireStage('operations', { optional: true, confirmation: true, condition: anyTrue(['run_input.changes.runtime', 'run_input.changes.migration', 'run_input.changes.release_artifact']) });
      requireDependency('operations', 'memory-docs', false);
      return;
    }

    if (templateSlug === 'bug-fix') {
      for (const key of ['research', 'implementation', 'code-review', 'testing', 'memory-docs']) requireStage(key);
      requireStage('architecture', { optional: true, condition: anyTrue(['run_input.root_cause_changes_module_boundary']) });
      requireStage('ui-design', { optional: true, condition: anyTrue(['run_input.user_visible_behavior_change']) });
      requireStage('security', { optional: true, condition: anyTrue(['run_input.security_sensitive']) });
      requireStage('operations', { optional: true, confirmation: true, condition: anyTrue(['run_input.requires_release', 'run_input.requires_migration']) });
      requireDependency('operations', 'memory-docs', false);
    }
  }
}
