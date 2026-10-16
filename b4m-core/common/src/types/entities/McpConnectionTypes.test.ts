import { describe, expect, it } from 'vitest';
import {
  isValidMcpConnectionSlug,
  McpConnectionSlugSchema,
  MCP_CONNECTION_SECRET_PATHS,
  RESERVED_MCP_CONNECTION_SLUGS,
  toMcpConnectionPublic,
  type IMcpConnectionDocument,
} from './McpConnectionTypes';
import { McpServerName } from './McpServerTypes';

describe('McpConnectionSlugSchema', () => {
  it.each(['ab', 'linear', 'my_server_2', 'a2345678901234567890', 'a_b', 'x1_2_3'])('accepts %s', slug => {
    expect(isValidMcpConnectionSlug(slug)).toBe(true);
  });

  it.each([
    ['a', 'too short'],
    ['a23456789012345678901', 'too long'],
    ['2fast', 'leading digit'],
    ['_x', 'leading underscore'],
    ['Linear', 'uppercase'],
    ['my-server', 'hyphen'],
    ['my server', 'space'],
    ['', 'empty'],
    ['my__server', 'double underscore (the namespace separator)'],
    ['linear_', 'trailing underscore'],
    ['a_', 'trailing underscore at minimum length'],
    ['a_2345678901234567890', 'too long with underscores'],
  ])('rejects %s (%s)', slug => {
    expect(isValidMcpConnectionSlug(slug)).toBe(false);
  });

  it('reserves every built-in server name and the first-party names', () => {
    for (const name of Object.values(McpServerName)) expect(RESERVED_MCP_CONNECTION_SLUGS.has(name)).toBe(true);
    for (const name of ['mcp', 'b4m', 'bike4mind', 'slack', 'system']) {
      expect(isValidMcpConnectionSlug(name)).toBe(false);
    }
    expect(McpConnectionSlugSchema.safeParse('github').error?.issues[0]?.message).toBe('This slug is reserved');
  });
});

describe('toMcpConnectionPublic', () => {
  const now = new Date('2026-10-15T00:00:00Z');
  const doc: IMcpConnectionDocument = {
    id: 'conn-1',
    ownerType: 'user',
    ownerKey: 'user-1',
    userId: 'user-1',
    slug: 'linear',
    displayName: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    urlHost: 'mcp.linear.app',
    transport: 'auto',
    auth: {
      kind: 'oauth',
      oauth: {
        resource: 'https://mcp.linear.app/mcp',
        issuer: 'https://linear.app',
        authorizationServerUrl: 'https://linear.app',
        scopes: ['read'],
        clientMode: 'manual',
        manualClientIdEnc: 'SECRET-1',
        manualClientSecretEnc: 'SECRET-2',
        accessTokenEnc: 'SECRET-3',
        refreshTokenEnc: 'SECRET-4',
      },
      apiKey: { headerName: 'X-Api-Key', scheme: 'raw', valueEnc: 'SECRET-5', last4: 'wxyz' },
    },
    status: 'connected',
    tools: [],
    enabled: true,
    refreshLease: { holder: 'h', until: now },
    createdAt: now,
    updatedAt: now,
  };

  it('drops every *Enc field and the lease', () => {
    const view = toMcpConnectionPublic(doc);
    const serialized = JSON.stringify(view);

    expect(serialized).not.toMatch(/SECRET-/);
    expect(serialized).not.toMatch(/Enc"/);
    expect(view).not.toHaveProperty('refreshLease');
    expect(view).not.toHaveProperty('ownerKey');
    expect(MCP_CONNECTION_SECRET_PATHS).toHaveLength(5);
  });

  it('reports token presence and the key tail only', () => {
    const view = toMcpConnectionPublic(doc);
    expect(view.auth.oauth).toMatchObject({ hasAccessToken: true, hasRefreshToken: true, clientMode: 'manual' });
    expect(view.auth.apiKey).toEqual({ headerName: 'X-Api-Key', scheme: 'raw', last4: 'wxyz' });
  });

  it('omits auth sub-objects the connection does not have', () => {
    const view = toMcpConnectionPublic({ ...doc, auth: { kind: 'none' } });
    expect(view.auth).toEqual({ kind: 'none' });
  });
});
