import type { ConditionExpression, WorkflowStage } from '@project-orchestrator/contracts';
import type { SqliteConfigRepository, WorkflowTaskType } from '@project-orchestrator/sqlite-store';
import type { ConfigService } from './config-service.js';

export const BUILTIN_ROLE_SLUGS = [
  'requirements', 'research', 'architecture', 'ui-design', 'implementation',
  'code-review', 'testing', 'security', 'operations', 'memory-docs',
] as const;

const ROLE_DETAILS: Record<typeof BUILTIN_ROLE_SLUGS[number], {
  displayName: string;
  responsibility: string;
  requestedCapabilities: string[];
}> = {
  requirements: { displayName: 'Requirements', responsibility: 'Confirm requirements and acceptance criteria without deciding for the user.', requestedCapabilities: ['read-workspace'] },
  research: { displayName: 'Research', responsibility: 'Read the existing project and report evidence, constraints, and unknowns.', requestedCapabilities: ['read-workspace', 'network-read'] },
  architecture: { displayName: 'Architecture', responsibility: 'Produce architecture, interface, data, ADR, and implementation plans without implementing.', requestedCapabilities: ['read-workspace'] },
  'ui-design': { displayName: 'UI Design', responsibility: 'Produce reviewable HTML interaction prototypes before implementation.', requestedCapabilities: ['read-workspace', 'write-workspace'] },
  implementation: { displayName: 'Implementation', responsibility: 'Implement the approved plan and report changed files without self-certifying tests.', requestedCapabilities: ['read-workspace', 'write-workspace'] },
  'code-review': { displayName: 'Code Review', responsibility: 'Review every changed line, original rule, risk, and business impact.', requestedCapabilities: ['read-workspace'] },
  testing: { displayName: 'Testing', responsibility: 'Independently run checks and preserve raw commands, output, and evidence.', requestedCapabilities: ['read-workspace', 'execute-tests'] },
  security: { displayName: 'Security', responsibility: 'Check permissions, secrets, external input, dependencies, and safety policy.', requestedCapabilities: ['read-workspace', 'network-read'] },
  operations: { displayName: 'Operations', responsibility: 'Build, release, smoke-test, and record rollback with confirmation for production effects.', requestedCapabilities: ['read-workspace', 'managed-side-effect'] },
  'memory-docs': { displayName: 'Memory and Documentation', responsibility: 'Deduplicate, redact, and archive decisions, rules, delivery evidence, and lessons.', requestedCapabilities: ['read-workspace', 'write-workspace'] },
};

function genericEnvelope(slug: string, kind: string) {
  return { schema_id: `project-orchestrator/${slug}-${kind}`, schema_version: 1, data: {} };
}

function condition(paths: string[]): ConditionExpression {
  return {
    op: 'any',
    items: paths.map((path) => ({ op: 'eq', path, value: true })),
  };
}

function stage(
  key: string,
  roleVersionId: string,
  options: Partial<WorkflowStage> = {},
): WorkflowStage {
  return {
    key,
    role_version_id: roleVersionId,
    optional: false,
    mandatory_gate: false,
    failure_policy: 'fail',
    max_attempts: 1,
    requires_confirmation: false,
    ...options,
  };
}

type TemplateDefinition = {
  slug: string;
  name: string;
  taskType: WorkflowTaskType;
  stages: WorkflowStage[];
  edges: Array<{ from: string; to: string; edge_type: 'requires' | 'on_success' }>;
  iterationGroups: Array<{
    key: string; entry_stage_key: string; gate_stage_keys: string[];
    aggregation_policy: 'collect_all'; max_iterations: number;
  }>;
};

function newProject(roles: ReadonlyMap<string, string>): TemplateDefinition {
  const role = (slug: string) => roles.get(slug) as string;
  return {
    slug: 'new-project', name: 'New Project', taskType: 'new_project',
    stages: [
      stage('requirements', role('requirements'), { requires_confirmation: true }),
      stage('research', role('research')),
      stage('architecture', role('architecture')),
      stage('ui-design', role('ui-design')),
      stage('implementation', role('implementation'), { iteration_group_key: 'delivery_loop', failure_policy: 'trigger_iteration' }),
      stage('code-review', role('code-review'), { iteration_group_key: 'delivery_loop', mandatory_gate: true, failure_policy: 'trigger_iteration' }),
      stage('testing', role('testing'), { iteration_group_key: 'delivery_loop', mandatory_gate: true, failure_policy: 'trigger_iteration' }),
      stage('security', role('security'), { iteration_group_key: 'delivery_loop', mandatory_gate: true, failure_policy: 'trigger_iteration' }),
      stage('operations', role('operations'), { requires_confirmation: true }),
      stage('memory-docs', role('memory-docs')),
    ],
    edges: [
      { from: 'requirements', to: 'research', edge_type: 'on_success' },
      { from: 'research', to: 'architecture', edge_type: 'on_success' },
      { from: 'research', to: 'ui-design', edge_type: 'on_success' },
      { from: 'architecture', to: 'implementation', edge_type: 'on_success' },
      { from: 'ui-design', to: 'implementation', edge_type: 'on_success' },
      { from: 'implementation', to: 'code-review', edge_type: 'on_success' },
      { from: 'implementation', to: 'testing', edge_type: 'on_success' },
      { from: 'implementation', to: 'security', edge_type: 'on_success' },
      { from: 'code-review', to: 'operations', edge_type: 'on_success' },
      { from: 'testing', to: 'operations', edge_type: 'on_success' },
      { from: 'security', to: 'operations', edge_type: 'on_success' },
      { from: 'operations', to: 'memory-docs', edge_type: 'on_success' },
    ],
    iterationGroups: [{
      key: 'delivery_loop', entry_stage_key: 'implementation',
      gate_stage_keys: ['code-review', 'testing', 'security'], aggregation_policy: 'collect_all', max_iterations: 3,
    }],
  };
}

function featureDevelopment(roles: ReadonlyMap<string, string>): TemplateDefinition {
  const role = (slug: string) => roles.get(slug) as string;
  return {
    slug: 'feature-development', name: 'Feature Development', taskType: 'feature',
    stages: [
      stage('research', role('research')),
      stage('architecture', role('architecture'), { optional: true, condition: condition([
        'run_input.changes.api', 'run_input.changes.schema', 'run_input.changes.module_boundary',
      ]) }),
      stage('ui-design', role('ui-design'), { optional: true, condition: condition(['run_input.user_visible_change']) }),
      stage('implementation', role('implementation')),
      stage('code-review', role('code-review')),
      stage('testing', role('testing')),
      stage('security', role('security'), { optional: true, condition: condition([
        'run_input.changes.permissions', 'run_input.changes.secrets', 'run_input.changes.external_input', 'run_input.changes.dependencies',
      ]) }),
      stage('operations', role('operations'), { optional: true, requires_confirmation: true, condition: condition([
        'run_input.changes.runtime', 'run_input.changes.migration', 'run_input.changes.release_artifact',
      ]) }),
      stage('memory-docs', role('memory-docs')),
    ],
    edges: [
      { from: 'research', to: 'architecture', edge_type: 'requires' },
      { from: 'research', to: 'ui-design', edge_type: 'requires' },
      { from: 'research', to: 'implementation', edge_type: 'requires' },
      { from: 'architecture', to: 'implementation', edge_type: 'requires' },
      { from: 'ui-design', to: 'implementation', edge_type: 'requires' },
      { from: 'implementation', to: 'code-review', edge_type: 'requires' },
      { from: 'implementation', to: 'testing', edge_type: 'requires' },
      { from: 'implementation', to: 'security', edge_type: 'requires' },
      { from: 'code-review', to: 'operations', edge_type: 'requires' },
      { from: 'testing', to: 'operations', edge_type: 'requires' },
      { from: 'security', to: 'operations', edge_type: 'requires' },
      { from: 'operations', to: 'memory-docs', edge_type: 'requires' },
    ],
    iterationGroups: [],
  };
}

function bugFix(roles: ReadonlyMap<string, string>): TemplateDefinition {
  const role = (slug: string) => roles.get(slug) as string;
  return {
    slug: 'bug-fix', name: 'Bug Fix', taskType: 'bugfix',
    stages: [
      stage('research', role('research')),
      stage('architecture', role('architecture'), { optional: true, condition: condition(['run_input.root_cause_changes_module_boundary']) }),
      stage('ui-design', role('ui-design'), { optional: true, condition: condition(['run_input.user_visible_behavior_change']) }),
      stage('implementation', role('implementation')),
      stage('code-review', role('code-review')),
      stage('testing', role('testing')),
      stage('security', role('security'), { optional: true, condition: condition(['run_input.security_sensitive']) }),
      stage('operations', role('operations'), { optional: true, requires_confirmation: true, condition: condition([
        'run_input.requires_release', 'run_input.requires_migration',
      ]) }),
      stage('memory-docs', role('memory-docs')),
    ],
    edges: [
      { from: 'research', to: 'architecture', edge_type: 'requires' },
      { from: 'research', to: 'ui-design', edge_type: 'requires' },
      { from: 'research', to: 'implementation', edge_type: 'requires' },
      { from: 'architecture', to: 'implementation', edge_type: 'requires' },
      { from: 'ui-design', to: 'implementation', edge_type: 'requires' },
      { from: 'implementation', to: 'code-review', edge_type: 'requires' },
      { from: 'implementation', to: 'testing', edge_type: 'requires' },
      { from: 'implementation', to: 'security', edge_type: 'requires' },
      { from: 'code-review', to: 'operations', edge_type: 'requires' },
      { from: 'testing', to: 'operations', edge_type: 'requires' },
      { from: 'security', to: 'operations', edge_type: 'requires' },
      { from: 'operations', to: 'memory-docs', edge_type: 'requires' },
    ],
    iterationGroups: [],
  };
}

export function seedBuiltins(service: ConfigService, repository: SqliteConfigRepository): void {
  const roleVersionIds = new Map<string, string>();
  for (const slug of BUILTIN_ROLE_SLUGS) {
    const detail = ROLE_DETAILS[slug];
    let role = repository.listRoles().find((candidate) => candidate.slug === slug);
    if (role === undefined) {
      repository.createRole({ id: `builtin-role-${slug}`, slug, name: detail.displayName });
      role = repository.getRole(`builtin-role-${slug}`);
    }
    if (role === undefined) throw new Error(`Failed to create built-in role ${slug}`);
    let versionId = role.currentVersionId;
    if (versionId === undefined) {
      versionId = service.publishRole({
        roleId: role.id,
        envelope: {
          schema_id: 'project-orchestrator/role-version', schema_version: 1,
          data: {
            slug,
            display_name: detail.displayName,
            responsibilities: [detail.responsibility],
            requested_capabilities: detail.requestedCapabilities,
            forbidden_capabilities: ['production-shell', 'raw-production-credentials'],
            input_schema: genericEnvelope(slug, 'input'),
            output_schema: genericEnvelope(slug, 'output'),
            completion_contract: genericEnvelope(slug, 'completion'),
            body_markdown: `# ${detail.displayName}\n\n${detail.responsibility}`,
          },
        },
      }).id;
    }
    roleVersionIds.set(slug, versionId);
  }

  for (const definition of [newProject(roleVersionIds), featureDevelopment(roleVersionIds), bugFix(roleVersionIds)]) {
    let template = repository.listWorkflowTemplates().find((candidate) => candidate.slug === definition.slug);
    if (template === undefined) {
      repository.createWorkflowTemplate({
        id: `builtin-workflow-${definition.slug}`,
        slug: definition.slug,
        name: definition.name,
        taskType: definition.taskType,
      });
      template = repository.getWorkflowTemplate(`builtin-workflow-${definition.slug}`);
    }
    if (template === undefined) throw new Error(`Failed to create built-in workflow ${definition.slug}`);
    if (template.currentVersionId === undefined) {
      service.publishWorkflow({
        workflowTemplateId: template.id,
        description: `Built-in ${definition.name} workflow`,
        envelope: {
          schema_id: 'project-orchestrator/workflow-version', schema_version: 1,
          data: {
            slug: definition.slug,
            version: 1,
            stages: definition.stages,
            edges: definition.edges,
            iteration_groups: definition.iterationGroups,
          },
        },
      });
    }
  }
}
