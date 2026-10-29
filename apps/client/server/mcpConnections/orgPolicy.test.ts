// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomMcpPolicySchema, type CustomMcpPolicy, type OrgCustomMcpPolicyView } from '@bike4mind/common';

const state = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  overrides: [] as { settingValue: string }[],
  ignoredOverrides: undefined as unknown[] | undefined,
  resolvedPolicy: {} as Partial<CustomMcpPolicy>,
  blockedHosts: [] as string[],
  blocklistRejected: false,
  connections: [] as Record<string, unknown>[],
}));

const writeScopedOverride = vi.hoisted(() => vi.fn());
const clearScopedOverride = vi.hoisted(() => vi.fn());
const listMemberConnections = vi.hoisted(() => vi.fn(async () => state.connections));

vi.mock('@server/middlewares/featureFlag', () => ({
  isFeatureEnabled: vi.fn(async (key: string) => state.flags[key] === true),
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  scopedSettingsRepository: { findOverrides: vi.fn(async () => state.overrides) },
  mcpConnectionRepository: { listMemberConnections },
}));
vi.mock('@bike4mind/services', () => ({
  scopedSettingsService: {
    writeScopedOverride,
    clearScopedOverride,
    resolveScopedSettingEntries: vi.fn(async (keys: readonly string[]) =>
      keys.includes('customMcpPolicy')
        ? {
            customMcpPolicy: {
              value: CustomMcpPolicySchema.parse(state.resolvedPolicy),
              source: 'organization',
              ...(state.ignoredOverrides ? { ignoredOverrides: state.ignoredOverrides } : {}),
            },
          }
        : {
            customMcpBlockedHosts: {
              value: { hosts: state.blockedHosts },
              source: 'platform',
              platformRejected: state.blocklistRejected,
            },
          }
    ),
  },
}));

const { scopedSettingsService } = await import('@bike4mind/services');
const resolveEntries = vi.mocked(scopedSettingsService.resolveScopedSettingEntries);

const viewOf = (policy: Partial<CustomMcpPolicy> = {}): OrgCustomMcpPolicyView => ({
  policy: CustomMcpPolicySchema.parse(policy),
  overridden: true,
  invalidOverride: false,
  platformEnabled: true,
});

const {
  currentOrgMemberIds,
  getOrgCustomMcpPolicy,
  listOrgMemberConnections,
  resetOrgCustomMcpPolicy,
  setOrgCustomMcpPolicy,
} = await import('./orgPolicy');

const connection = (userId: string, urlHost: string) => ({
  id: `conn-${userId}`,
  ownerType: 'user',
  ownerKey: userId,
  userId,
  organizationId: 'org-1',
  slug: 'conn',
  displayName: 'Conn',
  displayUrl: `https://${urlHost}/mcp`,
  urlHost,
  transport: 'streamable_http',
  auth: { kind: 'api_key', apiKey: { headerName: 'Authorization', last4: '1234' } },
  status: 'connected',
  tools: [],
  enabled: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

beforeEach(() => {
  vi.clearAllMocks();
  state.flags = { EnableMCPServer: true, EnableCustomMcpConnectors: true };
  state.overrides = [];
  state.ignoredOverrides = undefined;
  state.resolvedPolicy = {};
  state.blockedHosts = [];
  state.blocklistRejected = false;
  state.connections = [];
});

describe('getOrgCustomMcpPolicy', () => {
  it('reports the resolved policy, whether the org overrides it, and the platform switch', async () => {
    state.resolvedPolicy = { mode: 'off', requireApprovalForAll: true };
    state.overrides = [{ settingValue: '{"mode":"off"}' }];

    await expect(getOrgCustomMcpPolicy('org-1')).resolves.toEqual({
      policy: CustomMcpPolicySchema.parse({ mode: 'off', requireApprovalForAll: true }),
      overridden: true,
      invalidOverride: false,
      platformEnabled: true,
    });
  });

  it('propagates a failed policy read and requests strict resolution', async () => {
    resolveEntries.mockRejectedValueOnce(new Error('policy unavailable'));
    await expect(getOrgCustomMcpPolicy('org-1')).rejects.toThrow('policy unavailable');
    expect(resolveEntries).toHaveBeenLastCalledWith(
      ['customMcpPolicy'],
      expect.objectContaining({ organizationId: 'org-1' }),
      expect.anything(),
      { readFailureMode: 'throw' }
    );
  });

  it('flags an inherited policy, a refused stored override and a platform switch that is off', async () => {
    state.flags.EnableCustomMcpConnectors = false;
    state.ignoredOverrides = [{ scopeLevel: 'organization', scopeId: 'org-1' }];

    await expect(getOrgCustomMcpPolicy('org-1')).resolves.toMatchObject({
      overridden: false,
      invalidOverride: true,
      platformEnabled: false,
    });
  });
});

describe('setOrgCustomMcpPolicy', () => {
  it('stores the whole parsed policy at the org rung', async () => {
    const stored = await setOrgCustomMcpPolicy('org-1', { mode: 'off', requireApprovalForAll: true });

    const expected = JSON.stringify(CustomMcpPolicySchema.parse({ mode: 'off', requireApprovalForAll: true }));
    expect(stored).toBe(expected);
    expect(writeScopedOverride).toHaveBeenCalledWith(
      'customMcpPolicy',
      { scopeLevel: 'organization', scopeId: 'org-1' },
      expected,
      expect.anything()
    );
  });

  it('refuses a policy the schema refuses and writes nothing', async () => {
    await expect(setOrgCustomMcpPolicy('org-1', { maxConnectionsPerUser: 500 })).rejects.toThrow();
    expect(writeScopedOverride).not.toHaveBeenCalled();
  });

  it('reset clears the org override', async () => {
    await resetOrgCustomMcpPolicy('org-1');
    expect(clearScopedOverride).toHaveBeenCalledWith(
      'customMcpPolicy',
      { scopeLevel: 'organization', scopeId: 'org-1' },
      expect.anything()
    );
  });
});

describe('currentOrgMemberIds', () => {
  it('is the owner plus every row that confers membership', () => {
    expect(
      currentOrgMemberIds({
        userId: 'owner',
        users: [
          { userId: 'reader', permissions: ['read'] },
          { userId: 'writer', permissions: ['write'] },
          { userId: 'no-permissions', permissions: [] },
          { userId: 'owner', permissions: ['read'] },
        ],
      })
    ).toEqual(['owner', 'reader', 'writer']);
  });
});

describe('listOrgMemberConnections', () => {
  const org = { id: 'org-1', userId: 'owner', users: [{ userId: 'member', permissions: ['read'] }] };

  it('asks only for current members, so a member who left is not listed', async () => {
    await listOrgMemberConnections(org, viewOf({ mode: 'any' }));
    expect(listMemberConnections).toHaveBeenCalledWith('org-1', ['owner', 'member']);
  });

  it.each([{ platformEnabled: false }, { invalidOverride: true }])(
    'reports disabled connections for %j',
    async flags => {
      state.connections = [connection('member', 'mcp.ok.example')];
      const listed = await listOrgMemberConnections(org, { ...viewOf({ mode: 'any' }), ...flags });
      expect(listed[0]?.status).toBe('blocked_by_policy');
    }
  );

  it('fails closed when the stored platform blocklist is invalid', async () => {
    state.blocklistRejected = true;
    state.connections = [connection('member', 'mcp.ok.example')];
    const listed = await listOrgMemberConnections(org, viewOf({ mode: 'any' }));
    expect(listed[0]?.status).toBe('blocked_by_policy');
  });

  it('propagates a failed platform blocklist read instead of reporting allowed connections', async () => {
    resolveEntries.mockRejectedValueOnce(new Error('settings unavailable'));
    await expect(listOrgMemberConnections(org, viewOf({ mode: 'any' }))).rejects.toThrow('settings unavailable');
    expect(resolveEntries).toHaveBeenLastCalledWith(
      ['customMcpBlockedHosts'],
      expect.objectContaining({ organizationId: 'org-1' }),
      expect.anything(),
      { readFailureMode: 'throw' }
    );
  });

  it("reports each connection's status under the org policy and the platform blocklist", async () => {
    state.blockedHosts = ['*.blocked.example'];
    state.connections = [
      connection('owner', 'mcp.ok.example'),
      connection('member', 'mcp.blocked.example'),
      connection('member', 'mcp.org-blocked.example'),
    ];
    const listed = await listOrgMemberConnections(
      org,
      viewOf({ mode: 'any', blockedHostPatterns: ['mcp.org-blocked.example'] })
    );
    expect(listed.map(c => c.status)).toEqual(['connected', 'blocked_by_policy', 'blocked_by_policy']);

    const off = await listOrgMemberConnections(org, viewOf({ mode: 'off' }));
    expect(off.every(c => c.status === 'blocked_by_policy')).toBe(true);
  });
});
