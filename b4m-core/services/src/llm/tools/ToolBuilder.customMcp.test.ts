import { describe, it, expect, vi } from 'vitest';
import { ToolBuilder, type ToolBuilderConfig } from './ToolBuilder';
import { CUSTOM_MCP_DATA_NOTICE, type CustomMcpToolHost } from './customMcpTools';

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
  extra: { requestedMcpServers?: string[]; disableUserIntegrations?: boolean } = {}
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
