// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scopedSettingsService } from '@bike4mind/services';
import { CustomMcpPolicySchema, ForbiddenError, type CustomMcpPolicy } from '@bike4mind/common';

const state = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  orgIds: [] as string[],
  orgPolicies: {} as Record<string, Partial<CustomMcpPolicy>>,
  platformPolicy: {} as Partial<CustomMcpPolicy>,
  blockedHosts: [] as string[],
  privateNetworks: { cidrs: [] as string[], allowHttp: false },
  policyScopes: [] as unknown[],
  privateNetworksEntry: {} as DroppedInfo,
  blockedHostsEntry: {} as DroppedInfo,
  policyEntry: {} as DroppedInfo,
}));

type DroppedInfo = { platformRejected?: true; ignoredOverrides?: { scopeLevel: string; scopeId: string }[] };

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
    resolveScopedSettingEntries: vi.fn(async (keys: readonly string[], scope: { organizationId?: string }) => {
      if (keys.includes('customMcpPolicy')) {
        state.policyScopes.push(scope);
        const override = scope.organizationId ? state.orgPolicies[scope.organizationId] : undefined;
        return {
          customMcpPolicy: {
            value: CustomMcpPolicySchema.parse({ ...state.platformPolicy, ...override }),
            source: 'platform',
            stored: true,
            ...state.policyEntry,
          },
        };
      }
      return {
        customMcpBlockedHosts: {
          value: { hosts: state.blockedHosts },
          source: 'platform',
          stored: true,
          ...state.blockedHostsEntry,
        },
        customMcpAllowPrivateNetworks: {
          value: state.privateNetworks,
          source: 'platform',
          stored: true,
          ...state.privateNetworksEntry,
        },
      };
    }),
  },
}));

const {
  assertCustomMcpEnabled,
  evaluateConnectionPolicy,
  resetDroppedOverrideWarnings,
  resolveCustomMcpContext,
  resolveOwnHosts,
} = await import('./customMcpAccess');

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  state.flags = { EnableMCPServer: true, EnableCustomMcpConnectors: true };
  state.orgIds = [];
  state.orgPolicies = {};
  state.platformPolicy = { mode: 'any' };
  state.blockedHosts = [];
  state.privateNetworks = { cidrs: [], allowHttp: false };
  state.policyScopes = [];
  state.privateNetworksEntry = {};
  state.blockedHostsEntry = {};
  state.policyEntry = {};
  resetDroppedOverrideWarnings();
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
  describe('dropped stored override', () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => warn.mockRestore());

    it('does not warn when the stored value is valid or nothing is stored', async () => {
      state.privateNetworks = { cidrs: ['10.0.0.0/8'], allowHttp: false };
      await resolveCustomMcpContext('u1');
      state.privateNetworks = { cidrs: [], allowHttp: false };
      await resolveCustomMcpContext('u1');
      expect(warn).not.toHaveBeenCalled();
    });

    it('resolves to the default and warns with the setting key when the stored value was refused', async () => {
      state.privateNetworksEntry = { platformRejected: true };
      const context = await resolveCustomMcpContext('u1');
      expect(context.network.allowPrivateCidrs).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("'customMcpAllowPrivateNetworks'");
      expect(warn.mock.calls[0][0]).toContain('platform scope');
      expect(warn.mock.calls[0][0]).toContain('coded default');
    });

    it('warns with the scope id for a narrower override that was skipped, naming the real fallback', async () => {
      state.privateNetworksEntry = { ignoredOverrides: [{ scopeLevel: 'organization', scopeId: 'org-a' }] };
      await resolveCustomMcpContext('u1');
      expect(warn.mock.calls[0][0]).toContain('organization scope org-a');
      expect(warn.mock.calls[0][0]).toContain('next wider scope');
      expect(warn.mock.calls[0][0]).not.toContain('default');
    });

    it('warns about a dropped customMcpPolicy override too', async () => {
      state.orgIds = ['org-a'];
      state.policyEntry = { ignoredOverrides: [{ scopeLevel: 'organization', scopeId: 'org-a' }] };
      await resolveCustomMcpContext('u1');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("'customMcpPolicy' at organization scope org-a");
    });

    it('fails closed when an org policy failed validation, rather than falling back to the platform value', async () => {
      state.orgIds = ['org-a'];
      state.policyEntry = { ignoredOverrides: [{ scopeLevel: 'organization', scopeId: 'org-a' }] };
      const context = await resolveCustomMcpContext('u1');
      expect(context).toMatchObject({ enabled: false, disabledReason: 'org_policy_invalid' });
      await expect(assertCustomMcpEnabled({ id: 'u1' })).rejects.toMatchObject({
        statusCode: 403,
        additionalInfo: { code: 'policy_blocked', reason: 'org_policy_invalid' },
      });
    });

    it('warns once per process for each key and scope', async () => {
      state.privateNetworksEntry = { ignoredOverrides: [{ scopeLevel: 'organization', scopeId: 'org-a' }] };
      await resolveCustomMcpContext('u1');
      await resolveCustomMcpContext('u2');
      expect(warn).toHaveBeenCalledTimes(1);
      state.privateNetworksEntry = { ignoredOverrides: [{ scopeLevel: 'organization', scopeId: 'org-b' }] };
      await resolveCustomMcpContext('u1');
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('fails closed when the platform blocklist failed validation, rather than running with none', async () => {
      state.blockedHostsEntry = { platformRejected: true };
      const context = await resolveCustomMcpContext('u1');
      expect(context).toMatchObject({ enabled: false, disabledReason: 'platform_blocklist_invalid' });
      await expect(assertCustomMcpEnabled({ id: 'u1' })).rejects.toMatchObject({
        statusCode: 403,
        additionalInfo: { code: 'policy_blocked', reason: 'platform_blocklist_invalid' },
      });
    });
  });

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

describe('evaluateConnectionPolicy - API keys over plain http', () => {
  const policies = [CustomMcpPolicySchema.parse({ mode: 'any' })];
  const network = { ownHosts: [], allowHttp: true, allowPrivateCidrs: ['10.20.0.0/16'] };
  const verdict = (url: string, authKind: 'api_key' | 'none' = 'api_key', net: typeof network | undefined = network) =>
    evaluateConnectionPolicy(
      { policies, platformBlockedHosts: [], network: net },
      { urlHost: new URL(url).hostname, authKind, url }
    );

  it('refuses an API key over http to a hostname, or to an address outside the private CIDRs', () => {
    expect(verdict('http://mcp.internal.example:8080/mcp')).toMatchObject({
      allowed: false,
      reason: 'api_key_over_http',
    });
    expect(verdict('http://10.30.0.5:8080/mcp')).toMatchObject({ reason: 'api_key_over_http' });
  });

  it('allows it to an IP literal inside the private CIDRs, over https, without a key, or without the opt-in', () => {
    expect(verdict('http://10.20.0.5:8080/mcp')).toEqual({ allowed: true });
    expect(verdict('https://mcp.internal.example/mcp')).toEqual({ allowed: true });
    expect(verdict('http://mcp.internal.example:8080/mcp', 'none')).toEqual({ allowed: true });
    expect(verdict('http://mcp.internal.example:8080/mcp', 'api_key', { ...network, allowHttp: false })).toEqual({
      allowed: true,
    });
  });
});

describe('assertCustomMcpEnabled', () => {
  it('throws 403 when off and returns the context when on', async () => {
    await expect(assertCustomMcpEnabled({ id: 'u1' })).resolves.toMatchObject({ enabled: true });
    state.flags.EnableCustomMcpConnectors = false;
    await expect(assertCustomMcpEnabled({ id: 'u1' })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('security-setting resolution', () => {
  it('requests strict reads for host settings and every membership policy', async () => {
    vi.mocked(scopedSettingsService.resolveScopedSettingEntries).mockClear();
    state.orgIds = ['org-1', 'org-2'];
    await resolveCustomMcpContext('user-1');
    const calls = vi.mocked(scopedSettingsService.resolveScopedSettingEntries).mock.calls;
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call[3]).toEqual({ readFailureMode: 'throw' });
    expect(calls.map(call => call[0])).toEqual([
      ['customMcpBlockedHosts', 'customMcpAllowPrivateNetworks'],
      ['customMcpPolicy'],
      ['customMcpPolicy'],
    ]);
  });

  it('propagates a security-setting read failure', async () => {
    vi.mocked(scopedSettingsService.resolveScopedSettingEntries).mockRejectedValueOnce(
      new Error('settings unavailable')
    );
    await expect(resolveCustomMcpContext('user-1')).rejects.toThrow('settings unavailable');
  });
});
