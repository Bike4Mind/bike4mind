// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveCustomMcpContext: vi.fn(),
  evaluateConnectionPolicy: vi.fn(),
  listForUser: vi.fn(),
  invokeRemoteMcp: vi.fn(),
}));

vi.mock('./customMcpAccess', () => ({
  resolveCustomMcpContext: mocks.resolveCustomMcpContext,
  evaluateConnectionPolicy: mocks.evaluateConnectionPolicy,
}));
vi.mock('@bike4mind/database', () => ({ mcpConnectionRepository: { listForUser: mocks.listForUser } }));
vi.mock('./invokeRemoteMcp', () => ({ invokeRemoteMcp: mocks.invokeRemoteMcp }));

import { customMcpToolHost, isCustomToolStillOffered } from './customMcpToolHost';

const tool = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: 'd',
  inputSchema: {},
  enabled: true,
  state: 'active',
  ...extra,
});

const connection = (
  id: string,
  urlHost: string,
  tools = [tool('search', { annotations: { readOnlyHint: true } })]
) => ({
  id,
  slug: id,
  displayName: id.toUpperCase(),
  urlHost,
  displayUrl: `https://${urlHost}/mcp`,
  auth: { kind: 'none' },
  tools,
});

const policy = (overrides: Record<string, boolean> = {}) => ({
  allowWriteTools: true,
  requireApprovalForAll: false,
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.evaluateConnectionPolicy.mockReturnValue({ allowed: true });
});

describe('customMcpToolHost.listConnections', () => {
  it('reports nothing when custom connectors are not enabled, without reading connections', async () => {
    mocks.resolveCustomMcpContext.mockResolvedValue({ enabled: false, policies: [] });

    expect(await customMcpToolHost.listConnections('u1')).toEqual([]);
    expect(mocks.listForUser).not.toHaveBeenCalled();
  });

  it('drops a connection a policy blocks and keeps the rest', async () => {
    mocks.resolveCustomMcpContext.mockResolvedValue({ enabled: true, policies: [policy()] });
    mocks.listForUser.mockResolvedValue([connection('acme', 'mcp.acme.test'), connection('evil', 'mcp.evil.test')]);
    mocks.evaluateConnectionPolicy.mockImplementation((_ctx, { urlHost }) => ({
      allowed: urlHost !== 'mcp.evil.test',
    }));

    const offers = await customMcpToolHost.listConnections('u1');

    expect(offers.map(o => o.connectionId)).toEqual(['acme']);
    expect(offers[0]).toMatchObject({ slug: 'acme', displayName: 'ACME', urlHost: 'mcp.acme.test' });
  });

  it('forbids writes when any policy forbids them and requires approval when any policy does', async () => {
    mocks.resolveCustomMcpContext.mockResolvedValue({
      enabled: true,
      policies: [policy({ allowWriteTools: true }), policy({ allowWriteTools: false, requireApprovalForAll: false })],
    });
    mocks.listForUser.mockResolvedValue([connection('acme', 'mcp.acme.test')]);
    expect((await customMcpToolHost.listConnections('u1'))[0]).toMatchObject({
      allowWriteTools: false,
      requireApprovalForAll: false,
    });

    mocks.resolveCustomMcpContext.mockResolvedValue({
      enabled: true,
      policies: [policy({ requireApprovalForAll: false }), policy({ requireApprovalForAll: true })],
    });
    expect((await customMcpToolHost.listConnections('u1'))[0]).toMatchObject({
      allowWriteTools: true,
      requireApprovalForAll: true,
    });
  });
});

describe('customMcpToolHost.callTool', () => {
  it('delegates to invokeRemoteMcp with approved preserved', async () => {
    mocks.invokeRemoteMcp.mockResolvedValue({ result: { content: [] } });

    await customMcpToolHost.callTool({
      connectionId: 'c1',
      userId: 'u1',
      toolName: 'create',
      args: { a: 1 },
      approved: true,
    });

    expect(mocks.invokeRemoteMcp).toHaveBeenCalledWith({
      action: 'callTool',
      connectionId: 'c1',
      userId: 'u1',
      toolName: 'create',
      args: { a: 1 },
      approved: true,
    });
  });
});

describe('isCustomToolStillOffered', () => {
  beforeEach(() => {
    mocks.resolveCustomMcpContext.mockResolvedValue({ enabled: true, policies: [policy()] });
    mocks.listForUser.mockResolvedValue([
      connection('c1', 'mcp.acme.test', [tool('create'), tool('off', { enabled: false })]),
    ]);
  });

  it('is true for an enabled, active tool on a listed connection', async () => {
    expect(await isCustomToolStillOffered('u1', 'c1', 'create')).toBe(true);
  });

  it.each([
    ['an unknown connection', 'other', 'create'],
    ['an unknown tool', 'c1', 'missing'],
    ['a disabled tool', 'c1', 'off'],
  ])('is false for %s', async (_label, connectionId, toolName) => {
    expect(await isCustomToolStillOffered('u1', connectionId, toolName)).toBe(false);
  });

  it('is false for a write once a policy forbids write tools', async () => {
    mocks.resolveCustomMcpContext.mockResolvedValue({ enabled: true, policies: [policy({ allowWriteTools: false })] });

    expect(await isCustomToolStillOffered('u1', 'c1', 'create')).toBe(false);
  });

  it('is false when custom connectors are disabled', async () => {
    mocks.resolveCustomMcpContext.mockResolvedValue({ enabled: false, policies: [] });

    expect(await isCustomToolStillOffered('u1', 'c1', 'create')).toBe(false);
  });
});
