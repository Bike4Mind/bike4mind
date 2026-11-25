import { describe, expect, it } from 'vitest';
import {
  isValidMcpConnectionSlug,
  McpConnectionSlugSchema,
  MCP_CONNECTION_SECRET_PATHS,
  RESERVED_MCP_CONNECTION_SLUGS,
  toMcpConnectionPublic,
  toMcpDisplayUrl,
  toMcpPlatformConnectionMemberView,
  effectiveMcpConnectionStatus,
  mcpConnectionOwnerProblem,
  MCP_CONNECTION_STATUSES,
  PLATFORM_MCP_OWNER,
  type IMcpConnectionDocument,
  type IMcpConnectionSummary,
} from './McpConnectionTypes';
import { CALLABLE_FUNCTION_TOOL_CONNECTION_ID } from './CallableFunctionTypes';
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
    ['foo__bar', 'would make foo__bar__baz ambiguous with slug foo and tool bar__baz'],
    ['github__x', 'would parse as server github'],
    ['abc_', 'trailing underscore'],
    ['linear_', 'trailing underscore'],
    ['a_', 'trailing underscore at minimum length'],
    ['a_2345678901234567890', 'too long with underscores'],
  ])('rejects %s (%s)', slug => {
    expect(isValidMcpConnectionSlug(slug)).toBe(false);
  });

  it('keeps the function namespace outside valid connector slugs without reserving legacy fn', () => {
    expect(isValidMcpConnectionSlug('fn')).toBe(true);
    expect(isValidMcpConnectionSlug(CALLABLE_FUNCTION_TOOL_CONNECTION_ID)).toBe(false);
  });

  it('reserves every built-in server name and the first-party names', () => {
    for (const name of Object.values(McpServerName)) expect(RESERVED_MCP_CONNECTION_SLUGS.has(name)).toBe(true);
    for (const name of ['mcp', 'b4m', 'bike4mind', 'slack', 'system']) {
      expect(isValidMcpConnectionSlug(name)).toBe(false);
    }
    expect(McpConnectionSlugSchema.safeParse('github').error?.issues[0]?.message).toBe('This slug is reserved');
    for (const name of ['github', 'atlassian', 'notion', 'linkedin']) {
      expect(RESERVED_MCP_CONNECTION_SLUGS.has(name)).toBe(true);
    }
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
        hasAccessToken: true,
        hasRefreshToken: true,
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

  it('reports token presence from the markers and only the key tail', () => {
    const view = toMcpConnectionPublic(doc);
    expect(view.auth.oauth).toEqual({
      issuer: doc.auth.oauth!.issuer,
      scopes: doc.auth.oauth!.scopes,
      clientMode: 'manual',
      expiresAt: doc.auth.oauth!.expiresAt,
      grantedScope: doc.auth.oauth!.grantedScope,
      hasAccessToken: true,
      hasRefreshToken: true,
    });
    expect(view.auth.apiKey).toEqual({ headerName: 'X-Api-Key', scheme: 'raw', last4: 'wxyz' });
  });

  it('reports blocked_by_policy only when given a blocking verdict', () => {
    expect(toMcpConnectionPublic(doc).status).toBe('connected');
    expect(toMcpConnectionPublic(doc, { allowed: true }).status).toBe('connected');
    expect(toMcpConnectionPublic(doc, { allowed: false }).status).toBe('blocked_by_policy');
  });

  it('reads presence from the markers, not the ciphertext a default read never has', () => {
    const { accessTokenEnc: _a, refreshTokenEnc: _r, ...oauth } = doc.auth.oauth!;
    expect(toMcpConnectionPublic({ ...doc, auth: { kind: 'oauth', oauth } }).auth.oauth).toMatchObject({
      hasAccessToken: true,
      hasRefreshToken: true,
    });
    const unmarked = { ...doc.auth.oauth!, hasAccessToken: undefined, hasRefreshToken: undefined };
    expect(toMcpConnectionPublic({ ...doc, auth: { kind: 'oauth', oauth: unmarked } }).auth.oauth).toMatchObject({
      hasAccessToken: false,
      hasRefreshToken: false,
    });
  });

  it('omits auth sub-objects the connection does not have', () => {
    const view = toMcpConnectionPublic({ ...doc, auth: { kind: 'none' } });
    expect(view.auth).toEqual({ kind: 'none' });
  });
});

describe('toMcpPlatformConnectionMemberView', () => {
  const now = new Date('2026-10-15T00:00:00Z');
  const tool = {
    name: 'search',
    description: 'Searches',
    descriptionRawHash: 'raw',
    versionHash: 'v1',
    enabled: true,
    approval: 'default' as const,
    state: 'active' as const,
    firstSeenAt: now,
  };
  const doc: IMcpConnectionSummary = {
    id: 'conn-9',
    ...PLATFORM_MCP_OWNER,
    userId: 'admin-1',
    slug: 'docs',
    displayName: 'Docs',
    urlEnc: 'SECRET-0',
    displayUrl: 'https://mcp.example.com/team/...WXYZ/mcp',
    urlHost: 'mcp.example.com',
    transport: 'auto',
    auth: { kind: 'api_key', apiKey: { headerName: 'X-Api-Key', scheme: 'raw', valueEnc: 'SECRET-1', last4: 'wxyz' } },
    status: 'connected',
    lastError: { code: 'timeout', message: 'The server did not answer', at: now },
    serverInfo: { name: 'docs-server', version: '1.2.3' },
    tools: [tool],
    toolsFingerprint: 'fp',
    enabled: true,
    lastUsedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  it('is exactly the fields a Tools-menu row needs', () => {
    expect(toMcpPlatformConnectionMemberView(doc, { allowed: true })).toEqual({
      id: 'conn-9',
      ownerType: 'platform',
      slug: 'docs',
      displayName: 'Docs',
      urlHost: 'mcp.example.com',
      status: 'connected',
      tools: [tool],
      enabled: true,
    });
  });

  it('names no creator, URL path, key detail, error or last use', () => {
    const serialized = JSON.stringify(toMcpPlatformConnectionMemberView(doc, { allowed: true }));
    for (const hidden of ['admin-1', 'WXYZ', 'wxyz', 'X-Api-Key', 'SECRET', 'did not answer', 'docs-server']) {
      expect(serialized).not.toContain(hidden);
    }
    for (const field of ['userId', 'displayUrl', 'auth', 'lastError', 'lastUsedAt', 'serverInfo', 'createdAt']) {
      expect(serialized).not.toContain(`"${field}"`);
    }
  });

  it('reports blocked_by_policy when the viewer policy denies the host', () => {
    expect(toMcpPlatformConnectionMemberView(doc, { allowed: false }).status).toBe('blocked_by_policy');
  });

  it('carries only the tools the admin reviewed and switched on', () => {
    const tools = [
      tool,
      { ...tool, name: 'draft_unreviewed', description: 'Awaiting review', state: 'pending_review' as const },
      { ...tool, name: 'drop_switched_off', description: 'Switched off', enabled: false },
    ];
    const view = toMcpPlatformConnectionMemberView({ ...doc, tools }, { allowed: true });

    expect(view.tools).toEqual([tool]);
    for (const hidden of ['draft_unreviewed', 'Awaiting review', 'drop_switched_off', 'Switched off']) {
      expect(JSON.stringify(view)).not.toContain(hidden);
    }
  });

  it('carries the description the admin wrote, and none when it is absent or empty', () => {
    const described = { ...doc, description: 'Searches the team handbook.' };
    expect(toMcpPlatformConnectionMemberView(described, { allowed: true }).description).toBe(
      'Searches the team handbook.'
    );
    expect(toMcpConnectionPublic(described).description).toBe('Searches the team handbook.');
    const serializedKeys = (view: object) => Object.keys(JSON.parse(JSON.stringify(view)) as object);
    for (const source of [doc, { ...doc, description: '' }]) {
      expect(serializedKeys(toMcpPlatformConnectionMemberView(source, { allowed: true }))).not.toContain('description');
      expect(serializedKeys(toMcpConnectionPublic(source))).not.toContain('description');
    }
  });
});

describe('mcpConnectionOwnerProblem for a platform connection', () => {
  const platform = { ...PLATFORM_MCP_OWNER, userId: 'admin-1', auth: { kind: 'api_key' } };

  it('accepts an API key or no sign-in under the fixed owner key', () => {
    expect(mcpConnectionOwnerProblem(platform)).toBeNull();
    expect(mcpConnectionOwnerProblem({ ...platform, auth: { kind: 'none' } })).toBeNull();
  });

  it.each([
    ['another owner key', { ownerKey: 'admin-1' }],
    ['an organization', { organizationId: 'org-1' }],
    ['a definition', { definitionId: 'def-1' }],
    ['a refresh lease', { refreshLease: { holder: 'h', until: new Date() } }],
    ['OAuth sign-in', { auth: { kind: 'oauth' } }],
  ])('refuses %s', (_label, overrides) => {
    expect(mcpConnectionOwnerProblem({ ...platform, ...overrides })).toEqual(expect.any(String));
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
