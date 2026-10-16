import { describe, expect, it } from 'vitest';
import {
  isValidMcpConnectionSlug,
  McpConnectionSlugSchema,
  MCP_CONNECTION_SECRET_PATHS,
  RESERVED_MCP_CONNECTION_SLUGS,
  toMcpConnectionPublic,
  toMcpDisplayUrl,
  effectiveMcpConnectionStatus,
  MCP_CONNECTION_STATUSES,
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
    urlEnc: 'SECRET-0',
    displayUrl: 'https://mcp.linear.app/mcp',
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
    expect(view).not.toHaveProperty('url');
    expect(view.displayUrl).toBe('https://mcp.linear.app/mcp');
    expect(MCP_CONNECTION_SECRET_PATHS).toContain('urlEnc');
  });

  it('reports token presence and the key tail only', () => {
    const view = toMcpConnectionPublic(doc);
    expect(view.auth.oauth).toMatchObject({ hasAccessToken: true, hasRefreshToken: true, clientMode: 'manual' });
    expect(view.auth.apiKey).toEqual({ headerName: 'X-Api-Key', scheme: 'raw', last4: 'wxyz' });
  });

  it('reports blocked_by_policy only when given a blocking verdict', () => {
    expect(toMcpConnectionPublic(doc).status).toBe('connected');
    expect(toMcpConnectionPublic(doc, { allowed: true }).status).toBe('connected');
    expect(toMcpConnectionPublic(doc, { allowed: false }).status).toBe('blocked_by_policy');
  });

  it('omits auth sub-objects the connection does not have', () => {
    const view = toMcpConnectionPublic({ ...doc, auth: { kind: 'none' } });
    expect(view.auth).toEqual({ kind: 'none' });
  });
});

describe('toMcpDisplayUrl', () => {
  it.each([
    ['https://mcp.linear.app/mcp', 'https://mcp.linear.app/mcp'],
    ['https://mcp.example.com/mcp?api_key=s3cr3t&x=1', 'https://mcp.example.com/mcp'],
    ['https://mcp.example.com:8443/v1/sse', 'https://mcp.example.com:8443/v1/sse'],
    ['https://hooks.example.com/u/abcdefghijklmnopqrstWXYZ/mcp', 'https://hooks.example.com/u/...WXYZ/mcp'],
    ['https://example.com/1234567890123456789', 'https://example.com/1234567890123456789'],
    ['https://example.com/12345678901234567890', 'https://example.com/...7890'],
    ['https://example.com', 'https://example.com/'],
  ])('%s -> %s', (url, expected) => {
    expect(toMcpDisplayUrl(url)).toBe(expected);
  });
});

describe('effectiveMcpConnectionStatus', () => {
  it('is never stored', () => {
    expect(MCP_CONNECTION_STATUSES).not.toContain('blocked_by_policy');
  });

  it.each(MCP_CONNECTION_STATUSES)('a blocking verdict overrides %s', status => {
    expect(effectiveMcpConnectionStatus({ status }, { allowed: false })).toBe('blocked_by_policy');
    expect(effectiveMcpConnectionStatus({ status }, { allowed: true })).toBe(status);
  });
});
