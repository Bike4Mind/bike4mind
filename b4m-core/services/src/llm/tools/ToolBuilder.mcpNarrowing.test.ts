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

const build = (offerOnlyNamedTools: boolean): string[] => {
  const tools = makeBuilder().buildTools({
    enabledTools: [],
    offerOnlyNamedTools,
    mcpToolsByServer: { slack: [mcpTool('slack__send_message')] },
    quest: { id: 'quest-1', sessionId: 'session-1' } as never,
    saveQuest: vi.fn(),
    llm: { complete: vi.fn() } as unknown as ICompletionBackend,
    config: {},
  });

  return (tools ?? []).map(tool => tool.toolSchema.name);
};

describe('ToolBuilder MCP narrowing', () => {
  it('forwards offerOnlyNamedTools to withhold unnamed MCP tools', () => {
    expect(build(true)).not.toContain('slack__send_message');
  });

  it('keeps MCP tools on the default path', () => {
    expect(build(false)).toContain('slack__send_message');
  });
});
