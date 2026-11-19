import { describe, it, expect, vi } from 'vitest';
import { ToolBuilder, type ToolBuilderConfig } from './ToolBuilder';
import { CUSTOM_MCP_DATA_NOTICE, type CustomMcpListOptions, type CustomMcpToolHost } from './customMcpTools';

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

const run = (
  builder: ToolBuilder,
  onPendingAction = vi.fn(async () => undefined),
  extra: {
    requestedMcpServers?: string[];
    disabledMcpConnections?: string[];
    enabledPlatformMcpConnections?: string[];
    disableUserIntegrations?: boolean;
  } = {}
) =>
  builder.buildMcpTools({
    enableMCPServer: true,
    requestedMcpServers: undefined,
    ...extra,
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

  it('offers no custom tool when user integrations are disabled, even with no promptMode', async () => {
    const host = { listConnections: vi.fn(async () => [connection]), callTool: vi.fn() };
    const { mcpToolsByServer, customMcpToolNames } = await run(builderWith(host as never), undefined, {
      disableUserIntegrations: true,
    });

    expect(mcpToolsByServer).toEqual({});
    expect(customMcpToolNames.size).toBe(0);
    expect(host.listConnections).not.toHaveBeenCalled();
  });

  it('still offers custom tools when the composer sends an empty built-in server list', async () => {
    const host = { listConnections: vi.fn(async () => [connection]), callTool: vi.fn() };
    const { mcpToolsByServer } = await run(builderWith(host as never), undefined, { requestedMcpServers: [] });

    expect(mcpToolsByServer.acme.map(t => t.name)).toEqual(['acme__search', 'acme__create']);
  });

  it('withholds a connector switched off in the composer and keeps the others', async () => {
    const other = { ...connection, connectionId: 'c2', slug: 'docs', displayName: 'Docs' };
    const host = { listConnections: vi.fn(async () => [connection, other]), callTool: vi.fn() };
    const { mcpToolsByServer, customMcpToolNames } = await run(builderWith(host as never), undefined, {
      requestedMcpServers: ['notion'],
      disabledMcpConnections: ['acme', 'not_a_connection'],
    });

    expect(Object.keys(mcpToolsByServer)).toEqual(['docs']);
    expect([...customMcpToolNames]).toEqual(['docs__search', 'docs__create']);
  });

  describe('platform connectors', () => {
    const shared = { ...connection, connectionId: 'p1', slug: 'shared', displayName: 'Shared' };
    // Lists a platform connector only when the request names it, as the server host does.
    const optInHost = () => ({
      listConnections: vi.fn(async (_userId: string, options?: CustomMcpListOptions) => [
        connection,
        ...(options?.platformConnectionIds?.includes(shared.connectionId) ? [shared] : []),
      ]),
      callTool: vi.fn(async () => ({ result: { content: [] } })),
    });

    it('offers none of its tools to a request that never switched it on, so a call by name finds no tool', async () => {
      const host = optInHost();
      const { mcpToolsByServer, customMcpToolNames } = await run(builderWith(host as never));

      expect(Object.keys(mcpToolsByServer)).toEqual(['acme']);
      expect([...customMcpToolNames].filter(name => name.startsWith('shared__'))).toEqual([]);
      expect(host.listConnections).toHaveBeenCalledWith('u1', { platformConnectionIds: [] });
      expect(host.callTool).not.toHaveBeenCalled();
    });

    it('offers its tools once switched on by id, and withholds them once switched off again', async () => {
      const host = optInHost();
      const on = await run(builderWith(host as never), undefined, { enabledPlatformMcpConnections: ['p1'] });
      expect(Object.keys(on.mcpToolsByServer)).toEqual(['acme', 'shared']);
      expect(on.mcpToolsByServer.shared.map(t => t.name)).toEqual(['shared__search', 'shared__create']);

      await on.mcpToolsByServer.shared.find(t => t.name === 'shared__search')!.toolFn({ q: 'x' });
      expect(host.callTool).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: 'p1', toolName: 'search', platformConnectionIds: ['p1'] })
      );

      for (const enabledPlatformMcpConnections of [[], ['shared']]) {
        const off = await run(builderWith(host as never), undefined, { enabledPlatformMcpConnections });
        expect(Object.keys(off.mcpToolsByServer)).toEqual(['acme']);
      }
    });
  });

  it('adds the connector-output-is-data notice to the tool prompt only when custom tools are offered', async () => {
    const build = async (hasCustomMcpTools: boolean) =>
      (
        await builderWith(undefined).buildToolPrompt({
          mcpTools: [{ name: 'acme__search' }],
          hasCustomMcpTools,
          sessionId: 's1',
          message: 'hi',
          logger,
          processStartTime: Date.now(),
        } as never)
      )?.context?.content;

    expect(await build(true)).toContain(CUSTOM_MCP_DATA_NOTICE);
    expect(await build(false)).not.toContain(CUSTOM_MCP_DATA_NOTICE);
  });

  it.each(['constructor', 'constructor_prod', 'acme_prod'])(
    'builds integration guidance for the valid custom slug %s',
    async slug => {
      const prompt = await builderWith(undefined).buildToolPrompt({
        mcpTools: [{ name: `${slug}__search` }],
        hasCustomMcpTools: true,
        sessionId: 's1',
        message: 'hi',
        logger,
        processStartTime: Date.now(),
      } as never);
      expect(prompt?.context?.content).toContain(`${slug}__search`);
      expect(prompt?.context?.content).toContain(`**${slug}**`);
      expect(prompt?.context?.content).toContain(CUSTOM_MCP_DATA_NOTICE);
    }
  );

  it('offers nothing custom without a host', async () => {
    const { mcpToolsByServer } = await run(builderWith(undefined));
    expect(mcpToolsByServer).toEqual({});
  });
});
