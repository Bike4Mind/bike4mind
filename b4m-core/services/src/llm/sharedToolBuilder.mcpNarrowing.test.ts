/**
 * MCP tools must obey the same "offer nothing" request that native tools obey.
 *
 * Every narrowing lever the product exposes (`toolMode: 'fast'`, `skip_auto_offers`,
 * `disabledTools`) resolves down to `enabledTools` before it reaches the builder, so the empty
 * list is the only representation of "offer no tools" the builder ever sees. The MCP merge used
 * to run unconditionally after the native filter, which made that empty case unreachable for
 * anyone with a server connected (#2960).
 *
 * The distinction these tests pin is empty-vs-omitted, and it is load-bearing in BOTH directions:
 * collapsing them either way regresses a real call site. The subagent dispatch path in
 * `agentExecutor.ts` passes no `enabledTools` at all and relies on MCP tools arriving anyway
 * (its own `allowedTools` does the scoping), so an over-eager fix that treats "omitted" as
 * "empty" hands that path zero tools.
 *
 * Deps are build-only stubs: `buildSharedTools` materialises every tool's schema and `toolFn`
 * closure up front, but a tool only touches its backing adapters when the closure is EXECUTED.
 * These tests never execute one, so the stubs reject loudly rather than returning undefined.
 */
import { describe, it, expect } from 'vitest';
import { Logger } from '@bike4mind/observability';
import type { ICompletionBackend, ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { IUserDocument } from '@bike4mind/common';
import { buildSharedTools, type ToolBuilderDeps, type ToolBuilderCallbacks } from './sharedToolBuilder';

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

describe('buildSharedTools: an empty tool profile withholds MCP tools', () => {
  it('offers nothing at all when enabledTools is empty and MCP servers are connected', () => {
    // The regression case, stated exactly as the bug was: the caller asked for zero tools, and
    // three MCP tool schemas shipped anyway. Asserted as a full equality rather than a
    // `not.toContain` per tool so a newly added server cannot slip past the assertion.
    expect(build({ enabledTools: [], mcpToolsByServer })).toEqual([]);
  });

  it('withholds MCP tools from every connected server, not just the first', () => {
    const names = build({ enabledTools: [], mcpToolsByServer });
    expect(names).not.toContain('atlassian__jira_search');
    expect(names).not.toContain('slack__send_message');
  });

  it('still offers nothing when enabledTools is empty and no MCP server is connected', () => {
    // Pins that the native path survives `enabledTools` no longer defaulting to [].
    expect(build({ enabledTools: [] })).toEqual([]);
  });
});

describe('buildSharedTools: omitting enabledTools is NOT a request for zero tools', () => {
  it('offers MCP tools when the caller passes no enabledTools at all', () => {
    // The subagent dispatch call site (agentExecutor.ts) depends on this: it deliberately passes
    // no `enabledTools` because the dispatched agent's own allowedTools does the scoping. If this
    // ever collapses into the empty case, that path silently builds a zero-tool subagent.
    const names = build({ mcpToolsByServer });
    expect(names).toEqual(
      expect.arrayContaining(['atlassian__jira_search', 'atlassian__jira_create_issue', 'slack__send_message'])
    );
  });

  it('offers no native tools when enabledTools is omitted', () => {
    // Omitted means "this caller does not scope tools by name here", not "offer everything":
    // only the MCP tools it passed come back.
    expect(build({ mcpToolsByServer })).toHaveLength(3);
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

  it('drops nothing when the denylist is empty or absent', () => {
    expect(build({ enabledTools: ['dice_roll'], mcpToolsByServer, sessionDisabledTools: [] })).toHaveLength(4);
    expect(build({ enabledTools: ['dice_roll'], mcpToolsByServer })).toHaveLength(4);
  });
});
