import { describe, it, expect, vi } from 'vitest';
import { EVAL_MODE_DENIED_TOOLS, listAllToolNames } from './buildEvalContext';
import { generateCliTools } from '../utils/toolsAdapter.js';
import { PermissionManager } from '../utils/PermissionManager.js';
import { ToolCatalog } from '../tools/gateway/toolCatalog.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { ApiClient } from '../auth/ApiClient.js';

describe('eval tool listings', () => {
  it('accounts for decide in the deny list or the trust list', async () => {
    // generateCliTools offers `decide` whenever the deployment reports a
    // decision model, and the trust list is what keeps every other offered
    // tool from reaching the throwing showPermissionPrompt. A tool in neither
    // list aborts the task instead of running.
    const denied = EVAL_MODE_DENIED_TOOLS.includes('decide');
    const trusted = (await listAllToolNames()).includes('decide');
    expect(denied || trusted).toBe(true);
  });

  it('denies decide rather than trusting it', () => {
    // Evals must not spend credits on a server-side model they do not control;
    // deny (like web_search/web_fetch) keeps it out of the offered set entirely.
    expect(EVAL_MODE_DENIED_TOOLS).toContain('decide');
  });
});

describe('eval tool filtering', () => {
  it('never offers decide even when the deployment reports a decision model', async () => {
    const apiClient = {
      get: vi.fn(async () => ({ models: [{ id: 'gpt-6-luna' }] })),
    } as unknown as ApiClient;

    const { tools } = await generateCliTools(
      'eval-user',
      {} as never, // llm: not exercised while tool schemas are built
      'test-model',
      new PermissionManager(new ToolCatalog()),
      vi.fn(async () => ({ action: 'allow-once' as const })),
      { currentAgent: null },
      {} as ConfigStore,
      apiClient,
      { deniedTools: [...EVAL_MODE_DENIED_TOOLS] },
      undefined // showUserQuestion
    );

    expect(tools.map(t => t.toolSchema.name)).not.toContain('decide');
  });
});
