/**
 * MCP tools must obey the same narrowing the caller applied to everything else.
 *
 * MCP tools are merged into the outgoing list AFTER the native `enabledTools` filter and were
 * never subject to it, so no narrowing lever could reach them: a caller asking for a minimal tool
 * profile still paid for every schema its servers expose (#2960).
 *
 * The gate is `offerOnlyNamedTools`, an EXPLICIT caller signal. The distinction these tests pin is
 * that it is not inferred from `enabledTools` being empty, and that matters in both directions:
 * an empty list is the ordinary chat payload (the web client defaults to `toolMode: 'smart'` with
 * an empty `tools` array), and the subagent dispatch path in `agentExecutor.ts` passes no
 * `enabledTools` at all. Inferring intent from either shape strips MCP tools from a caller that
 * never asked for that.
 *
 * Deps are build-only stubs: `buildSharedTools` materialises every tool's schema and `toolFn`
 * closure up front, but a tool only touches its backing adapters when the closure is EXECUTED.
 * These tests never execute one, so the stubs reject loudly rather than returning undefined.
 */
import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';
import type { ICompletionBackend, ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { IUserDocument } from '@bike4mind/common';
import { buildSharedTools, type ToolBuilderDeps, type ToolBuilderCallbacks } from './sharedToolBuilder';
import { createDelegateToAgentTool } from './tools/implementation/delegateToAgent';

// The `deps.agentStore` branch (sharedToolBuilder.ts:478-486) is where parentTools - the array
// captured by the delegate tool's closure, never part of the array buildSharedTools returns -
// gets its own denylist pass. None of the tests above reach it: with no agentStore, the early
// `if (!deps.agentStore) return tools;` fires first. Mocked rather than exercised for real: a real
// createDelegateToAgentTool call needs a working subagent LLM backend, which is out of scope for
// a build-only test.
vi.mock('./tools/implementation/delegateToAgent', () => ({
  createDelegateToAgentTool: vi.fn(() => ({
    toolFn: () => {
      throw new Error('delegate_to_agent stub was called - this test is build-only.');
    },
    toolSchema: { name: 'delegate_to_agent', description: 'stub', parameters: { type: 'object', properties: {} } },
  })),
}));

vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getLlmByModel: vi.fn(() => ({ complete: vi.fn(), currentModel: '' })),
}));

const rejectIfExecuted = (surface: string) => () => {
  throw new Error(`${surface} was called - these tests are build-only and must never execute a tool.`);
};

const fakeStorage = {
  upload: rejectIfExecuted('storage.upload'),
  getSignedUrl: rejectIfExecuted('storage.getSignedUrl'),
  getPublicUrl: rejectIfExecuted('storage.getPublicUrl'),
} as unknown as ToolBuilderDeps['storage'];

const deps: ToolBuilderDeps = {
  userId: 'test-user',
  user: { _id: 'test-user', id: 'test-user' } as unknown as IUserDocument,
  logger: new Logger(),
  db: {
    apiKeys: {
      findByUserIdAndType: rejectIfExecuted('db.apiKeys.findByUserIdAndType'),
      findByUserIdAndTypes: rejectIfExecuted('db.apiKeys.findByUserIdAndTypes'),
    },
    adminSettings: {
      findBySettingName: rejectIfExecuted('db.adminSettings.findBySettingName'),
      findBySettingNames: rejectIfExecuted('db.adminSettings.findBySettingNames'),
      findAll: rejectIfExecuted('db.adminSettings.findAll'),
    },
  } as unknown as ToolBuilderDeps['db'],
  storage: fakeStorage,
  imageGenerateStorage: fakeStorage,
  llm: { complete: rejectIfExecuted('llm.complete') } as unknown as ICompletionBackend,
};

const callbacks: ToolBuilderCallbacks = {
  onStatusUpdate: async () => {},
  onToolStart: async () => {},
  onToolFinish: async () => {},
};

/**
 * Shaped like `generateMcpToolsFromCache` output: the `server__tool` namespaced name appears both
 * at the top level and on the schema, and `_isMcpTool` marks it for the adapters.
 */
const mcpTool = (serverName: string, toolName: string): { name: string } & ICompletionOptionTools => ({
  name: `${serverName}__${toolName}`,
  toolFn: rejectIfExecuted(`${serverName}__${toolName}`),
  toolSchema: {
    name: `${serverName}__${toolName}`,
    description: `${toolName} via ${serverName}`,
    parameters: { type: 'object', properties: {} },
  },
  _isMcpTool: true,
});

const mcpToolsByServer = {
  atlassian: [mcpTool('atlassian', 'jira_search'), mcpTool('atlassian', 'jira_create_issue')],
  slack: [mcpTool('slack', 'send_message')],
};

const build = (options: Parameters<typeof buildSharedTools>[2]) =>
  (buildSharedTools(deps, callbacks, options) ?? []).map(tool => tool.toolSchema.name);

const mcpNames = (names: string[]) => names.filter(name => name.includes('__'));

describe('buildSharedTools: offerOnlyNamedTools withholds unnamed MCP tools', () => {
  it('offers nothing at all when the caller named no tools and MCP servers are connected', () => {
    // The regression case, stated exactly as the bug was: the caller asked for zero tools, and
    // three MCP tool schemas shipped anyway. Asserted as a full equality rather than a
    // `not.toContain` per tool so a newly added server cannot slip past the assertion.
    expect(build({ enabledTools: [], offerOnlyNamedTools: true, mcpToolsByServer })).toEqual([]);
  });

  it('withholds MCP tools from every connected server, not just the first', () => {
    const names = build({ enabledTools: [], offerOnlyNamedTools: true, mcpToolsByServer });
    expect(names).not.toContain('atlassian__jira_search');
    expect(names).not.toContain('slack__send_message');
  });

  it('keeps an MCP tool the caller named while withholding its unnamed siblings', () => {
    // "Only what I named" is per tool, not all-or-nothing: naming an MCP tool by its namespaced
    // id must still reach the model.
    const names = build({
      enabledTools: ['dice_roll', 'atlassian__jira_search'],
      offerOnlyNamedTools: true,
      mcpToolsByServer,
    });
    expect(names).toEqual(expect.arrayContaining(['dice_roll', 'atlassian__jira_search']));
    expect(names).not.toContain('atlassian__jira_create_issue');
    expect(names).not.toContain('slack__send_message');
  });
});

describe('buildSharedTools: the gate is never inferred from the shape of enabledTools', () => {
  it('offers MCP tools when enabledTools is empty but the caller did not set the flag', () => {
    // The load-bearing one. `tools: []` is the DEFAULT web payload (toolMode 'smart' with no
    // keyword match), not a request for silence - treating it as one strips MCP from normal chat.
    const names = build({ enabledTools: [], mcpToolsByServer });
    expect(names).toEqual(
      expect.arrayContaining(['atlassian__jira_search', 'atlassian__jira_create_issue', 'slack__send_message'])
    );
  });

  it('offers MCP tools when the caller passes no enabledTools at all', () => {
    // The subagent dispatch call site (agentExecutor.ts) depends on this: it deliberately passes
    // no `enabledTools` because the dispatched agent's own allowedTools does the scoping.
    const names = build({ mcpToolsByServer });
    expect(mcpNames(names)).toEqual(
      expect.arrayContaining(['atlassian__jira_search', 'atlassian__jira_create_issue', 'slack__send_message'])
    );
  });
});

describe('buildSharedTools: a non-empty tool profile is unchanged', () => {
  it('still offers every MCP tool alongside the named native tools', () => {
    // The non-regression guard. The fix must make "I asked for no tools" reachable without
    // making MCP tools harder to reach in the case that already worked.
    const names = build({ enabledTools: ['dice_roll'], mcpToolsByServer });
    expect(names).toEqual(
      expect.arrayContaining([
        'dice_roll',
        'atlassian__jira_search',
        'atlassian__jira_create_issue',
        'slack__send_message',
      ])
    );
  });

  it('withholds agent-only MCP servers from the returned list but keeps the rest', () => {
    const names = build({ enabledTools: ['dice_roll'], mcpToolsByServer, agentOnlyMcpServers: ['atlassian'] });
    expect(names).toEqual(expect.arrayContaining(['dice_roll', 'slack__send_message']));
    expect(names).not.toContain('atlassian__jira_search');
  });

  it('routes agent-only servers to the delegation pool even under offerOnlyNamedTools', () => {
    // Exempt on purpose: agent-only tools are already withheld from the main model's schemas, so
    // they cost the caller nothing - dropping them here would remove delegation reach instead.
    //
    // Asserted through the log rather than the return value because both outcomes look identical
    // from outside: an agent-only tool never appears in the returned array whether it was routed
    // to the delegation pool or dropped. This line is the only observable that separates them
    // without an agentStore, so it is deliberately matched loosely (the count, not the wording).
    const info = vi.fn();
    const names = (
      buildSharedTools(
        { ...deps, logger: { ...new Logger(), info, debug: () => {} } as unknown as Logger },
        callbacks,
        {
          enabledTools: [],
          offerOnlyNamedTools: true,
          mcpToolsByServer,
          agentOnlyMcpServers: ['atlassian'],
        }
      ) ?? []
    ).map(tool => tool.toolSchema.name);

    expect(names).toEqual([]);
    expect(info.mock.calls.flat().join(' ')).toMatch(/2 agent-only MCP tools/);
  });
});

describe('buildSharedTools: the session denylist reaches MCP tools by name', () => {
  it('subtracts one named MCP tool and keeps its siblings on the same server', () => {
    // Denial is per tool, not per server: forbidding jira_create_issue must not cost the session
    // the read-only jira_search on the same connection.
    const names = build({
      enabledTools: ['dice_roll'],
      mcpToolsByServer,
      sessionDisabledTools: ['atlassian__jira_create_issue'],
    });
    expect(names).not.toContain('atlassian__jira_create_issue');
    expect(names).toEqual(expect.arrayContaining(['atlassian__jira_search', 'slack__send_message', 'dice_roll']));
  });

  it('subtracts a denied MCP tool even when the caller passes no enabledTools', () => {
    // The subagent dispatch shape: no native tool list, MCP tools only. The denylist still has to
    // bite, otherwise "omitted enabledTools" becomes a way to bypass it.
    const names = build({ mcpToolsByServer, sessionDisabledTools: ['slack__send_message'] });
    expect(names).not.toContain('slack__send_message');
    expect(names).toEqual(expect.arrayContaining(['atlassian__jira_search']));
  });

  it('outranks an explicit name: a denied tool stays denied even when the caller names it', () => {
    const names = build({
      enabledTools: ['atlassian__jira_search'],
      offerOnlyNamedTools: true,
      mcpToolsByServer,
      sessionDisabledTools: ['atlassian__jira_search'],
    });
    expect(names).toEqual([]);
  });

  it('drops nothing when the denylist is empty or absent', () => {
    // Counted by namespace rather than by total so an unrelated auto-added native tool cannot
    // silently absorb a dropped MCP tool and keep the count green.
    expect(mcpNames(build({ enabledTools: ['dice_roll'], mcpToolsByServer, sessionDisabledTools: [] }))).toHaveLength(
      3
    );
    expect(mcpNames(build({ enabledTools: ['dice_roll'], mcpToolsByServer }))).toHaveLength(3);
  });
});

describe('buildSharedTools: the denylist also reaches parentTools, which the returned array cannot', () => {
  // `agentStore` truthy is the only way past the early return at sharedToolBuilder.ts:478-480,
  // so this is the sole place in this suite that reaches the parentTools filter at :486.
  const agentStore = { hasAgent: () => false } as unknown as ToolBuilderDeps['agentStore'];

  it('keeps a session-denied MCP tool out of parentTools, not just out of the returned array', () => {
    buildSharedTools(
      { ...deps, agentStore, apiKeyTable: {} as ToolBuilderDeps['apiKeyTable'], model: 'm' },
      callbacks,
      {
        enabledTools: ['dice_roll'],
        mcpToolsByServer,
        sessionDisabledTools: ['atlassian__jira_create_issue'],
      }
    );

    const parentTools = (vi.mocked(createDelegateToAgentTool).mock.calls.at(-1)?.[0]?.parentTools ??
      []) as ICompletionOptionTools[];
    const names = parentTools.map(t => t.toolSchema.name);
    expect(names).not.toContain('atlassian__jira_create_issue');
    expect(names).toEqual(expect.arrayContaining(['dice_roll', 'atlassian__jira_search', 'slack__send_message']));
  });

  it('keeps a session-denied NATIVE tool out of parentTools even though the returned array still carries it', () => {
    // Native tools aren't checked against the denylist by the "filter to enabled tools" step
    // above (only `isToolOfferable` is) - the caller's own post-build pass is what strips a
    // denied native tool from the RETURNED array. That pass can't reach parentTools (a separate
    // reference captured by the closure), so this line is what keeps a dispatched subagent from
    // getting a native tool the session forbade before that external pass ever runs.
    const tools = buildSharedTools(
      { ...deps, agentStore, apiKeyTable: {} as ToolBuilderDeps['apiKeyTable'], model: 'm' },
      callbacks,
      {
        enabledTools: ['dice_roll', 'current_datetime'],
        sessionDisabledTools: ['current_datetime'],
      }
    );

    expect((tools ?? []).map(t => t.toolSchema.name)).toContain('current_datetime');

    const parentTools = (vi.mocked(createDelegateToAgentTool).mock.calls.at(-1)?.[0]?.parentTools ??
      []) as ICompletionOptionTools[];
    expect(parentTools.map(t => t.toolSchema.name)).not.toContain('current_datetime');
  });

  it('routes an agent-only MCP tool into parentTools for delegation, denylist still applied', () => {
    buildSharedTools(
      { ...deps, agentStore, apiKeyTable: {} as ToolBuilderDeps['apiKeyTable'], model: 'm' },
      callbacks,
      {
        enabledTools: ['dice_roll'],
        mcpToolsByServer,
        agentOnlyMcpServers: ['atlassian'],
        sessionDisabledTools: ['atlassian__jira_create_issue'],
      }
    );

    const parentTools = (vi.mocked(createDelegateToAgentTool).mock.calls.at(-1)?.[0]?.parentTools ??
      []) as ICompletionOptionTools[];
    const names = parentTools.map(t => t.toolSchema.name);
    expect(names).toContain('atlassian__jira_search');
    expect(names).not.toContain('atlassian__jira_create_issue');
  });
});
