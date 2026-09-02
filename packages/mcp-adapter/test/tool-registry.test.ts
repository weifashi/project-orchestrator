import { describe, expect, it } from 'vitest';
import { AgentToolNames } from '@project-orchestrator/contracts';
import { createToolRegistry } from '../src/tool-registry.js';

describe('MCP tool registry', () => {
  it('registers the exact twenty model-visible tools and no Web or confirmation decision tool', () => {
    const registry = createToolRegistry({ invoke: async () => ({ ok: true }) });
    expect(registry.map((tool) => tool.name)).toEqual([...AgentToolNames]);
    expect(registry).toHaveLength(20);
    expect(registry.map((tool) => tool.name)).not.toContain('submit_confirmation');
    expect(registry.map((tool) => tool.name).some((name) => name.startsWith('web_'))).toBe(false);
  });

  it('keeps lease, credential, principal, and confirmation fields out of every visible schema', () => {
    const registry = createToolRegistry({ invoke: async () => ({ ok: true }) });
    const serialized = JSON.stringify(registry.map((tool) => tool.inputSchema));
    for (const forbidden of ['lease_token', 'lease_epoch', 'credential', 'principal', 'decision', 'nonce']) {
      expect(serialized).not.toMatch(new RegExp(`"${forbidden}"\\s*:`));
    }
  });

  it('rejects a direct lease token in model JSON', async () => {
    let called = false;
    const registry = createToolRegistry({ invoke: async () => { called = true; return {}; } });
    const complete = registry.find((tool) => tool.name === 'complete_stage')!;
    const result = await complete.invoke({ run_id: 'run-1', request_id: 'request-1', lease_token: 'forged' });
    expect(result.isError).toBe(true);
    expect(called).toBe(false);
  });

  it('classifies only create and claim as bootstrap writes', () => {
    const registry = createToolRegistry({ invoke: async () => ({ ok: true }) });
    expect(registry.filter((tool) => tool.classification === 'bootstrap').map((tool) => tool.name))
      .toEqual(['create_run', 'claim_run']);
    expect(registry.filter((tool) => tool.classification === 'leased')).toHaveLength(18);
  });

  it('returns a bounded stable error instead of arbitrary thrown content', async () => {
    const registry = createToolRegistry({ invoke: async () => { throw new Error(`BAD_REQUEST: ${'x'.repeat(30_000)}`); } });
    const tool = registry[0]!;
    const result = await tool.invoke({
      request_id: 'request-1', workflow_slug: 'new-project', objective: 'test', input: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text.length).toBeLessThanOrEqual(4096);
    expect(result.content[0]?.text).toBe('BAD_REQUEST');
  });
});
