// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomMcpPolicySchema } from '@bike4mind/common';

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
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  getMcpPresetHost: (id: string | undefined) => (id === 'acme-preset' ? 'mcp.acme.test' : undefined),
}));
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

  it('lists a catalog connection under a presets_only policy and drops a custom one', async () => {
    mocks.resolveCustomMcpContext.mockResolvedValue({ enabled: true, policies: [policy()] });
    mocks.listForUser.mockResolvedValue([
      { ...connection('catalog', 'mcp.acme.test'), presetId: 'acme-preset' },
      connection('custom', 'mcp.other.test'),
    ]);
    mocks.evaluateConnectionPolicy.mockImplementation((_ctx, { urlHost, presetRemoteHost }) => ({
      allowed: presetRemoteHost !== undefined && presetRemoteHost === urlHost,
    }));

    const offers = await customMcpToolHost.listConnections('u1');

    expect(offers.map(o => o.connectionId)).toEqual(['catalog']);
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

describe('customMcpToolHost.listConnections - platform connectors', () => {
  const platform = { ...connection('shared', 'mcp.example.com'), ownerType: 'platform' };
  const realPolicy = async (policy: Record<string, unknown>) => {
    const { evaluateConnectionPolicy } = await vi.importActual<typeof import('./customMcpAccess')>('./customMcpAccess');
    mocks.evaluateConnectionPolicy.mockImplementation(evaluateConnectionPolicy);
    return { policies: [CustomMcpPolicySchema.parse(policy)], platformBlockedHosts: [] };
  };

  const on = { platformConnectionIds: ['shared'] };

  beforeEach(() => {
    mocks.listForUser.mockResolvedValue([platform, connection('custom', 'mcp.other.test')]);
  });

  it('asks for no platform connector unless the caller names one the user switched on', async () => {
    mocks.resolveCustomMcpContext.mockResolvedValue({ enabled: true, ...(await realPolicy({ mode: 'any' })) });

    await customMcpToolHost.listConnections('u1');
    await customMcpToolHost.listConnections('u1', {});
    await customMcpToolHost.listConnections('u1', on);
    // A card awaiting approval was recorded from a tool the user was offered.
    await isCustomToolStillOffered('u1', 'shared', 'search');

    expect(mocks.listForUser.mock.calls).toEqual([
      ['u1', { platformIds: [] }],
      ['u1', { platformIds: [] }],
      ['u1', { platformIds: ['shared'] }],
      ['u1', { platformIds: ['shared'] }],
    ]);
  });

  it('offers one under the catalog-only mode, with the organization switches applied', async () => {
    mocks.resolveCustomMcpContext.mockResolvedValue({
      enabled: true,
      ...(await realPolicy({ mode: 'presets_only', allowUnauthenticated: true, allowWriteTools: false })),
    });

    const offers = await customMcpToolHost.listConnections('u1', on);

    expect(offers.map(o => o.connectionId)).toEqual(['shared']);
    expect(offers[0]).toMatchObject({ urlHost: 'mcp.example.com', allowWriteTools: false });
  });

  it('offers none to a member of an organization that switched connectors off', async () => {
    // The resolved switch and the policy each close it on their own.
    mocks.resolveCustomMcpContext.mockResolvedValue({ enabled: false, ...(await realPolicy({ mode: 'any' })) });
    expect(await customMcpToolHost.listConnections('u1', on)).toEqual([]);
    expect(await isCustomToolStillOffered('u1', 'shared', 'search')).toBe(false);

    mocks.resolveCustomMcpContext.mockResolvedValue({ enabled: true, ...(await realPolicy({ mode: 'off' })) });
    expect(await customMcpToolHost.listConnections('u1', on)).toEqual([]);
  });

  it('drops one whose host an organization blocks', async () => {
    mocks.resolveCustomMcpContext.mockResolvedValue({
      enabled: true,
      ...(await realPolicy({ mode: 'any', blockedHostPatterns: ['mcp.example.com'] })),
    });

    expect((await customMcpToolHost.listConnections('u1', on)).map(o => o.connectionId)).toEqual(['custom']);
  });
});

describe('customMcpToolHost.callTool', () => {
  it('delegates to invokeRemoteMcp with approved and the switched-on platform ids preserved', async () => {
    mocks.invokeRemoteMcp.mockResolvedValue({ result: { content: [] } });

    await customMcpToolHost.callTool({
      connectionId: 'c1',
      userId: 'u1',
      toolName: 'create',
      args: { a: 1 },
      approved: true,
      platformConnectionIds: ['c1'],
    });

    expect(mocks.invokeRemoteMcp).toHaveBeenCalledWith({
      action: 'callTool',
      connectionId: 'c1',
      userId: 'u1',
      toolName: 'create',
      args: { a: 1 },
      approved: true,
      platformConnectionIds: ['c1'],
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
