import { describe, it, expect, vi } from 'vitest';
import { ToolBuilder, type ToolBuilderConfig } from './ToolBuilder';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() };

const makeBuilder = (mcpServers: Record<string, unknown>, getMcpClient: unknown): ToolBuilder =>
  new ToolBuilder({
    user: { id: 'user-1', _id: 'user-1' },
    db: { mcpServers },
    logger,
    storage: {},
    imageGenerateStorage: {},
    toolCreditsMap: new Map(),
    toolCreditModels: new Set(),
    subagentTelemetryData: [],
    sendStatusUpdate: vi.fn(),
    getMcpClient,
  } as unknown as ToolBuilderConfig);

const run = (builder: ToolBuilder) =>
  builder.buildMcpTools({
    enableMCPServer: true,
    requestedMcpServers: undefined,
    defaultAdminSettings: {},
    userMessage: '',
    logger,
    processStartTime: Date.now(),
    quest: { id: 'q1', sessionId: 's1' } as never,
  });

const emptyServer = (extra: Record<string, unknown> = {}) => ({
  id: 's1',
  name: 'notion',
  userId: 'user-1',
  enabled: true,
  envVariables: [],
  tools: [],
  toolSchemas: [],
  ...extra,
});

describe('ToolBuilder buildMcpTools - confirmed-empty fetch cache', () => {
  it('skips the live fetch for a confirmed-empty server whose marker is fresh', async () => {
    const getMcpClient = vi.fn();
    const update = vi.fn();
    const builder = makeBuilder(
      { find: vi.fn(async () => [emptyServer({ toolSchemasFetchedAt: new Date() })]), update },
      getMcpClient
    );

    const { mcpToolsByServer } = await run(builder);

    expect(mcpToolsByServer).toEqual({});
    expect(getMcpClient).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('records the marker after a successful empty fetch', async () => {
    const getTools = vi.fn(async () => []);
    const getMcpClient = vi.fn(async () => ({ getTools, callTool: vi.fn() }));
    const update = vi.fn();
    const builder = makeBuilder({ find: vi.fn(async () => [emptyServer()]), update }, getMcpClient);

    await run(builder);

    expect(getTools).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1', tools: [], toolSchemas: [], toolSchemasFetchedAt: expect.any(Date) })
    );
  });

  it('refetches once the marker ages past the TTL', async () => {
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const getTools = vi.fn(async () => []);
    const getMcpClient = vi.fn(async () => ({ getTools, callTool: vi.fn() }));
    const update = vi.fn();
    const builder = makeBuilder(
      { find: vi.fn(async () => [emptyServer({ toolSchemasFetchedAt: stale })]), update },
      getMcpClient
    );

    await run(builder);

    expect(getTools).toHaveBeenCalledTimes(1);
  });

  it('leaves the marker unset on a failed fetch so the next turn retries', async () => {
    const getTools = vi.fn(async () => {
      throw new Error('lambda cold start');
    });
    const getMcpClient = vi.fn(async () => ({ getTools, callTool: vi.fn() }));
    const update = vi.fn();
    const builder = makeBuilder({ find: vi.fn(async () => [emptyServer()]), update }, getMcpClient);

    await run(builder);
    await run(builder);

    expect(update).not.toHaveBeenCalled();
    expect(getTools).toHaveBeenCalledTimes(2);
  });
});
