import { describe, expect, it, vi } from 'vitest';
import type { ICompletionBackend, ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { ToolBuilder, type ToolBuilderConfig } from './ToolBuilder';

const mcpTool = (name: string): { name: string } & ICompletionOptionTools => ({
  name,
  toolFn: vi.fn(),
  toolSchema: {
    name,
    description: `${name} test tool`,
    parameters: { type: 'object', properties: {} },
  },
  _isMcpTool: true,
});

const makeBuilder = (): ToolBuilder =>
  new ToolBuilder({
    user: { id: 'user-1', _id: 'user-1' },
    db: { apiKeys: {}, adminSettings: {}, sessions: {} },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() },
    storage: {},
    imageGenerateStorage: {},
    toolCreditsMap: new Map(),
    subagentTelemetryData: [],
    sendStatusUpdate: vi.fn(),
  } as unknown as ToolBuilderConfig);

const build = (options: { offerOnlyNamedTools?: boolean; sessionDisabledTools?: string[] } = {}): string[] => {
  const tools = makeBuilder().buildTools({
    enabledTools: [],
    mcpToolsByServer: { slack: [mcpTool('slack__send_message'), mcpTool('slack__list_channels')] },
    quest: { id: 'quest-1', sessionId: 'session-1' } as never,
    saveQuest: vi.fn(),
    llm: { complete: vi.fn() } as unknown as ICompletionBackend,
    config: {},
    ...options,
  });

  return (tools ?? []).map(tool => tool.toolSchema.name);
};

describe('ToolBuilder MCP narrowing', () => {
  it('forwards offerOnlyNamedTools to withhold unnamed MCP tools', () => {
    expect(build({ offerOnlyNamedTools: true })).not.toContain('slack__send_message');
  });

  it('keeps MCP tools on the default path', () => {
    expect(build({ offerOnlyNamedTools: false })).toContain('slack__send_message');
  });

  // The static guard (packages/scripts/src/checkMcpDenylistWired.test.ts) proves each call site
  // still spells `sessionDisabledTools`, but not that this wrapper forwards it: substituting
  // `sessionDisabledTools: undefined` at ToolBuilder.ts left both cases above green.
  it('forwards sessionDisabledTools so the denylist reaches an MCP tool by name', () => {
    const names = build({ sessionDisabledTools: ['slack__send_message'] });
    expect(names).not.toContain('slack__send_message');
    // The sibling on the same server proves the denial is per tool and that the forward did not
    // simply drop every MCP tool.
    expect(names).toContain('slack__list_channels');
  });

  it('keeps both MCP tools when the denylist is empty', () => {
    expect(build({ sessionDisabledTools: [] })).toEqual(
      expect.arrayContaining(['slack__send_message', 'slack__list_channels'])
    );
  });
});
