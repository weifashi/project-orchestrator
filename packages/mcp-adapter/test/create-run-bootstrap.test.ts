import { describe, expect, it } from 'vitest';
import { createConservativeCapabilities, SessionGuard } from '@project-orchestrator/adapter-core';
import { AdapterRuntime } from '../src/server.js';

describe('create_run bootstrap', () => {
  it('adds the adapter-owned workspace snapshot without asking the model for project ids', async () => {
    let sent: unknown;
    const runtime = new AdapterRuntime({
      capabilities: createConservativeCapabilities('codex', '0.1.0'),
      sessionGuard: new SessionGuard({ sessionId: 'root-session' }),
      workspace: () => ({
        repositoryHead: 'abc123', stagedPatch: '', unstagedPatch: '',
        untrackedManifest: [], submoduleManifest: [],
      }),
      send: async (request) => {
        sent = request;
        return { run_id: 'run-1' };
      },
    });

    await expect(runtime.invoke('create_run', {
      request_id: 'request-1', workflow_slug: 'new-project', objective: 'TTPOS 2.28.6 新项目流程', input: {},
    })).resolves.toEqual({ run_id: 'run-1' });

    expect(sent).toEqual({
      kind: 'tool', tool: 'create_run',
      payload: {
        request_id: 'request-1', workflow_slug: 'new-project', objective: 'TTPOS 2.28.6 新项目流程', input: {},
        workspace: {
          repository_head: 'abc123', staged_patch: '', unstaged_patch: '',
          untracked_manifest: [], submodule_manifest: [],
        },
      },
    });
  });
});
