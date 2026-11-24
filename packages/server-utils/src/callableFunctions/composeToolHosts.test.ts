// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { CustomMcpConnectionOffer, CustomMcpToolHost } from '@bike4mind/services/llm';
import { composeToolHosts } from './composeToolHosts';

const offer = (connectionId: string): CustomMcpConnectionOffer => ({
  connectionId,
  slug: connectionId,
  displayName: connectionId,
  urlHost: connectionId,
  allowWriteTools: true,
  requireApprovalForAll: false,
  tools: [],
});

const host = (connectionId: string, owns?: string): CustomMcpToolHost => ({
  listConnections: vi.fn(async () => [offer(connectionId)]),
  callTool: vi.fn(async () => ({ result: { content: [{ type: 'text', text: connectionId }] } })),
  ...(owns ? { ownsConnection: (id: string) => id === owns } : {}),
});

const call = (composed: CustomMcpToolHost, connectionId: string) =>
  composed.callTool({ connectionId, userId: 'u1', toolName: 't', args: {}, approved: false });

describe('composeToolHosts', () => {
  it('lists in argument order and passes the list options to every host', async () => {
    const functions = host('fn', 'fn');
    const connectors = host('conn-1');
    const composed = composeToolHosts(functions, connectors);

    const offers = await composed.listConnections('u1', { headless: true });
    expect(offers.map(o => o.connectionId)).toEqual(['fn', 'conn-1']);
    expect(functions.listConnections).toHaveBeenCalledWith('u1', { headless: true });
    expect(connectors.listConnections).toHaveBeenCalledWith('u1', { headless: true });
  });

  it('routes a call to the host that owns its connection id, and any other id to the host that owns none', async () => {
    const functions = host('fn', 'fn');
    const connectors = host('conn-1');
    const composed = composeToolHosts(connectors, functions);

    await call(composed, 'fn');
    expect(functions.callTool).toHaveBeenCalledTimes(1);
    expect(connectors.callTool).not.toHaveBeenCalled();

    await call(composed, 'conn-1');
    expect(connectors.callTool).toHaveBeenCalledTimes(1);
    expect(functions.callTool).toHaveBeenCalledTimes(1);
  });

  it('logs and skips a host whose listing fails, keeping the other hosts offered', async () => {
    const functions = host('fn', 'fn');
    vi.mocked(functions.listConnections).mockRejectedValueOnce(new Error('registry down'));
    const offers = await composeToolHosts(functions, host('conn-1')).listConnections('u1');
    expect(offers.map(o => o.connectionId)).toEqual(['conn-1']);
  });

  it('with the MCP server off lists only the hosts that list without it', async () => {
    const functions = { ...host('fn', 'fn'), listsWithoutMcpServer: true };
    const connectors = host('conn-1');
    const composed = composeToolHosts(functions, connectors);
    expect(composed.listsWithoutMcpServer).toBe(true);
    expect(composeToolHosts(connectors).listsWithoutMcpServer).toBe(false);

    const offers = await composed.listConnections('u1', { mcpServerOff: true });
    expect(offers.map(o => o.connectionId)).toEqual(['fn']);
    expect(connectors.listConnections).not.toHaveBeenCalled();
  });

  it('throws for a connection no host serves', async () => {
    await expect(call(composeToolHosts(host('fn', 'fn')), 'conn-1')).rejects.toThrow(/No tool host/);
  });
});
