import { describe, it, expect, vi } from 'vitest';
import { ToolBuilder, type ToolBuilderConfig } from './ToolBuilder';
import type { CustomMcpToolHost } from './customMcpTools';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() };

const connection = {
  connectionId: 'c1',
  slug: 'acme',
  displayName: 'Acme',
  urlHost: 'mcp.acme.test',
  allowWriteTools: true,
  requireApprovalForAll: false,
  tools: [
    {
      name: 'search',
      description: 'd',
      inputSchema: {},
      enabled: true,
      state: 'active',
      annotations: { readOnlyHint: true },
    },
    { name: 'hidden', description: 'd', inputSchema: {}, enabled: true, state: 'pending_review' },
    { name: 'create', description: 'd', inputSchema: {}, enabled: true, state: 'active' },
  ],
};

const builderWith = (customMcp: CustomMcpToolHost | undefined, builtIns: unknown[] = []) =>
  new ToolBuilder({
    user: { id: 'u1', _id: 'u1' },
    db: { mcpServers: { find: vi.fn(async () => builtIns) } },
    logger,
    storage: {},
    imageGenerateStorage: {},
    toolCreditsMap: new Map(),
    toolCreditModels: new Set(),
    subagentTelemetryData: [],
    sendStatusUpdate: vi.fn(),
    getMcpClient: vi.fn(),
    customMcp,
  } as unknown as ToolBuilderConfig);

const run = (builder: ToolBuilder, onPendingAction = vi.fn(async () => undefined)) =>
  builder.buildMcpTools({
    enableMCPServer: true,
    requestedMcpServers: undefined,
    defaultAdminSettings: {},
    userMessage: '',
    logger,
    processStartTime: Date.now(),
    quest: { id: 'q1', sessionId: 's1' } as never,
    onPendingAction,
  });

describe('ToolBuilder buildMcpTools - custom connectors', () => {
  it('offers namespaced active tools and omits unreviewed ones', async () => {
    const host = { listConnections: vi.fn(async () => [connection]), callTool: vi.fn() };
    const { mcpToolsByServer, customMcpToolNames } = await run(builderWith(host as never));

    expect(mcpToolsByServer.acme.map(t => t.name)).toEqual(['acme__search', 'acme__create']);
    expect([...customMcpToolNames]).toEqual(['acme__search', 'acme__create']);
  });

  it('a write call records a pending action through the callback and never reaches the host', async () => {
    const host = { listConnections: vi.fn(async () => [connection]), callTool: vi.fn() };
    const onPendingAction = vi.fn(async () => undefined);
    const { mcpToolsByServer } = await run(builderWith(host as never), onPendingAction);

    await mcpToolsByServer.acme.find(t => t.name === 'acme__create')!.toolFn({ title: 'x' });

    expect(onPendingAction).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'c1', toolName: 'create', args: { title: 'x' } })
    );
    expect(host.callTool).not.toHaveBeenCalled();
  });

  it('a failing custom host drops custom tools only', async () => {
    const host = {
      listConnections: vi.fn(async () => {
        throw new Error('settings down');
      }),
      callTool: vi.fn(),
    };
    const builtIn = {
      id: 's1',
      name: 'notion',
      userId: 'u1',
      enabled: true,
      envVariables: [],
      tools: [],
      toolSchemas: [{ name: 'find', description: 'd', input_schema: { type: 'object', properties: {} } }],
    };
    const { mcpToolsByServer } = await run(builderWith(host as never, [builtIn]));

    expect(Object.keys(mcpToolsByServer)).toEqual(['notion']);
  });

  it('offers nothing custom without a host', async () => {
    const { mcpToolsByServer } = await run(builderWith(undefined));
    expect(mcpToolsByServer).toEqual({});
  });
});
