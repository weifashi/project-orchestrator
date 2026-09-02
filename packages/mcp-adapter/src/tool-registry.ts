import {
  AgentToolNames,
  ContractValidator,
  MODEL_VISIBLE_TOOL_SCHEMAS,
  type AgentToolName,
} from '@project-orchestrator/contracts';

export type ToolClassification = 'bootstrap' | 'leased';
export type ToolResult = Readonly<{
  content: ReadonlyArray<Readonly<{ type: 'text'; text: string }>>;
  isError?: boolean;
}>;
export type ToolDefinition = Readonly<{
  name: AgentToolName;
  description: string;
  classification: ToolClassification;
  inputSchema: Record<string, unknown>;
  invoke: (input: unknown) => Promise<ToolResult>;
}>;

const descriptions: Record<AgentToolName, string> = {
  create_run: 'Create an immutable Run snapshot for this project from a published workflow slug (new-project, feature-development, or bug-fix).',
  claim_run: 'Claim or recover a Run for this authenticated installation.',
  heartbeat_run: 'Extend the current Run lease.',
  begin_stage: 'Begin one ready stage attempt.',
  query_project_index: 'Query the immutable lightweight source index frozen when this Run entered Research.',
  complete_stage: 'Submit a successful structured stage result.',
  fail_stage: 'Freeze a failed stage attempt with evidence.',
  retry_stage: 'Retry a failed or interrupted stage inside a running Run.',
  skip_stage: 'Skip an optional stage when policy permits.',
  request_confirmation: 'Create a trusted confirmation request; this does not approve it.',
  record_artifact: 'Ingest an artifact into immutable local storage.',
  record_workspace_checkpoint: 'Record a workspace fingerprint and change manifest.',
  record_memory: 'Store a scoped, redacted memory with provenance.',
  append_agent_note: 'Append a bounded note whose principal is channel-derived.',
  prepare_side_effect: 'Prepare an exact managed side effect and confirmation intent.',
  execute_side_effect: 'Execute one previously confirmed managed side effect.',
  reconcile_side_effect: 'Reconcile an unknown side-effect result before retrying.',
  pause_run: 'Pause a nonterminal Run and release its lease.',
  cancel_run: 'Cancel a nonterminal Run and unfinished stages.',
  finalize_run: 'Ask the server to recompute all completion gates.',
};

function stableMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'TOOL_FAILED';
  return /^[A-Z][A-Z0-9_]*/.exec(raw)?.[0] ?? 'TOOL_FAILED';
}

function boundedSuccess(result: unknown): string {
  const serialized = JSON.stringify(result ?? null);
  if (serialized.length <= 4096) return serialized;
  const record = result !== null && typeof result === 'object' ? result as Record<string, unknown> : {};
  const ids = Object.fromEntries(Object.entries(record).filter(([key, value]) =>
    (key === 'summary' || key.endsWith('_id') || key.endsWith('_ids')) && JSON.stringify(value).length < 1024));
  return JSON.stringify({ summary: 'Result stored; use object ids to retrieve large content.', ...ids }).slice(0, 4096);
}

export function createToolRegistry(input: {
  invoke: (name: AgentToolName, payload: Record<string, unknown>) => Promise<unknown>;
}): ToolDefinition[] {
  const validator = new ContractValidator();
  return AgentToolNames.map((name) => Object.freeze({
    name,
    description: descriptions[name],
    classification: name === 'create_run' || name === 'claim_run' ? 'bootstrap' : 'leased',
    inputSchema: MODEL_VISIBLE_TOOL_SCHEMAS[name] as Record<string, unknown>,
    invoke: async (untrusted: unknown): Promise<ToolResult> => {
      try {
        const payload = validator.check(MODEL_VISIBLE_TOOL_SCHEMAS[name], untrusted) as Record<string, unknown>;
        const result = await input.invoke(name, payload);
        return { content: [{ type: 'text', text: boundedSuccess(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: stableMessage(error) }] };
      }
    },
  }));
}
