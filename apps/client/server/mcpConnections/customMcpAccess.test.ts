// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomMcpPolicySchema, ForbiddenError, type CustomMcpPolicy } from '@bike4mind/common';

const state = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  orgIds: [] as string[],
  orgPolicies: {} as Record<string, Partial<CustomMcpPolicy>>,
  platformPolicy: {} as Partial<CustomMcpPolicy>,
  blockedHosts: [] as string[],
  privateNetworks: { cidrs: [] as string[], allowHttp: false },
  policyScopes: [] as unknown[],
}));

vi.mock('@server/middlewares/featureFlag', () => ({
  isFeatureEnabled: vi.fn(async (key: string) => state.flags[key] === true),
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  scopedSettingsRepository: {},
  organizationRepository: { findMembershipOrgIds: vi.fn(async () => state.orgIds) },
}));
vi.mock('@bike4mind/services', () => ({
  scopedSettingsService: {
    resolveScopedSettingValues: vi.fn(async () => ({
      customMcpBlockedHosts: { hosts: state.blockedHosts },
      customMcpAllowPrivateNetworks: state.privateNetworks,
    })),
    resolveScopedSetting: vi.fn(async (_key: string, scope: { organizationId?: string }) => {
      state.policyScopes.push(scope);
      const override = scope.organizationId ? state.orgPolicies[scope.organizationId] : undefined;
      return { value: CustomMcpPolicySchema.parse({ ...state.platformPolicy, ...override }), source: 'platform' };
    }),
  },
}));

const { assertCustomMcpEnabled, evaluateConnectionPolicy, resolveCustomMcpContext, resolveOwnHosts } =
  await import('./customMcpAccess');

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  state.flags = { EnableMCPServer: true, EnableCustomMcpConnectors: true };
  state.orgIds = [];
  state.orgPolicies = {};
  state.platformPolicy = { mode: 'any' };
  state.blockedHosts = [];
  state.privateNetworks = { cidrs: [], allowHttp: false };
  state.policyScopes = [];
  process.env = {
    ...ORIGINAL_ENV,
    APP_URL: 'https://app.example.com',
    NEXT_PUBLIC_CDN_URL: 'https://cdn.example.net/assets',
  };
  delete process.env.B4M_SELF_HOST;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('resolveOwnHosts', () => {
  it('collects the app and absolute CDN hosts and ignores relative or malformed values', () => {
    expect(
      resolveOwnHosts({ APP_URL: 'https://App.Example.com/', NEXT_PUBLIC_CDN_URL: 'https://cdn.example.net/x' })
    ).toEqual(['app.example.com', 'cdn.example.net']);
    expect(
      resolveOwnHosts({ APP_URL: 'https://app.example.com', NEXT_PUBLIC_CDN_URL: '/api/app-files/serve' })
    ).toEqual(['app.example.com']);
    expect(resolveOwnHosts({ APP_URL: 'not a url' })).toEqual([]);
  });
});

describe('resolveCustomMcpContext', () => {
  it('needs both platform flags and no org set to off', async () => {
    expect((await resolveCustomMcpContext('u1')).enabled).toBe(true);

    state.flags.EnableCustomMcpConnectors = false;
    expect((await resolveCustomMcpContext('u1')).enabled).toBe(false);

    state.flags = { EnableMCPServer: false, EnableCustomMcpConnectors: true };
    expect((await resolveCustomMcpContext('u1')).enabled).toBe(false);

    state.flags = { EnableMCPServer: true, EnableCustomMcpConnectors: true };
    state.orgIds = ['org-a', 'org-b'];
    state.orgPolicies = { 'org-b': { mode: 'off' } };
    expect((await resolveCustomMcpContext('u1')).enabled).toBe(false);
  });

  it('applies one policy per membership org, and the platform policy for a user in none', async () => {
    const solo = await resolveCustomMcpContext('u1');
    expect(solo.policies).toHaveLength(1);
    expect(state.policyScopes).toEqual([{ owner: { id: 'u1', type: 'User' } }]);

    state.policyScopes = [];
    state.orgIds = ['org-a', 'org-b'];
    state.orgPolicies = { 'org-a': { maxConnectionsPerUser: 5 }, 'org-b': { blockedHostPatterns: ['*.evil.com'] } };
    const member = await resolveCustomMcpContext('u1');
    expect(member.policies).toHaveLength(2);
    expect(member.organizationIds).toEqual(['org-a', 'org-b']);
    expect(member.maxConnectionsPerUser).toBe(5);
    expect(state.policyScopes).toEqual([
      { organizationId: 'org-a', owner: { id: 'org-a', type: 'Organization' } },
      { organizationId: 'org-b', owner: { id: 'org-b', type: 'Organization' } },
    ]);
    // Any org can close a host for its member.
    expect(evaluateConnectionPolicy(member, { urlHost: 'mcp.evil.com', authKind: 'api_key' })).toMatchObject({
      allowed: false,
      reason: 'org_blocked_host',
    });
  });

  it('passes the own hosts and the platform blocklist through', async () => {
    state.blockedHosts = ['bad.example.org'];
    const context = await resolveCustomMcpContext('u1');
    expect(context.network.ownHosts).toEqual(['app.example.com', 'cdn.example.net']);
    expect(evaluateConnectionPolicy(context, { urlHost: 'bad.example.org', authKind: 'none' })).toMatchObject({
      reason: 'platform_blocked_host',
    });
  });

  it('honours the private-network opt-in on self-host only', async () => {
    state.privateNetworks = { cidrs: ['10.20.0.0/16'], allowHttp: true };
    const hosted = await resolveCustomMcpContext('u1');
    expect(hosted.network).not.toHaveProperty('allowPrivateCidrs');
    expect(hosted.network).not.toHaveProperty('allowHttp');

    process.env.B4M_SELF_HOST = 'true';
    const selfHost = await resolveCustomMcpContext('u1');
    expect(selfHost.network).toMatchObject({ allowPrivateCidrs: ['10.20.0.0/16'], allowHttp: true });
  });
});

describe('assertCustomMcpEnabled', () => {
  it('throws 403 when off and returns the context when on', async () => {
    await expect(assertCustomMcpEnabled({ id: 'u1' })).resolves.toMatchObject({ enabled: true });
    state.flags.EnableCustomMcpConnectors = false;
    await expect(assertCustomMcpEnabled({ id: 'u1' })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
