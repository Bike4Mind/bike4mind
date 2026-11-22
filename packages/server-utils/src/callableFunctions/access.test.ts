// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '@bike4mind/common';

type Scope = { organizationId?: string; owner: { id: string; type: string } };

const state = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  orgIds: [] as string[],
  platformValue: false,
  orgOverrides: {} as Record<string, boolean>,
  readError: null as Error | null,
  scopes: [] as Scope[],
  options: [] as unknown[],
}));

vi.mock('../middlewares/featureFlag', () => ({
  isFeatureEnabled: vi.fn(async (key: string) => state.flags[key] === true),
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  scopedSettingsRepository: {},
  organizationRepository: { findMembershipOrgIds: vi.fn(async () => state.orgIds) },
}));
vi.mock('@bike4mind/services', () => ({
  scopedSettingsService: {
    scopeForCaller: (caller: { userId: string; organizationId?: string }): Scope =>
      caller.organizationId
        ? { organizationId: caller.organizationId, owner: { id: caller.organizationId, type: 'Organization' } }
        : { owner: { id: caller.userId, type: 'User' } },
    resolveScopedSetting: vi.fn(async (key: string, scope: Scope, _db: unknown, options: unknown) => {
      expect(key).toBe('EnableCallableFunctions');
      state.scopes.push(scope);
      state.options.push(options);
      // Like the real resolver: a read failure throws only when asked to, and otherwise falls back.
      if (state.readError) {
        if ((options as { readFailureMode?: string } | undefined)?.readFailureMode === 'throw') throw state.readError;
        return { value: state.platformValue, source: 'platform' };
      }
      const override = scope.organizationId ? state.orgOverrides[scope.organizationId] : undefined;
      return { value: override ?? state.platformValue, source: override === undefined ? 'platform' : 'organization' };
    }),
  },
}));

const { assertCallableFunctionsEnabled, resolveCallableFunctionsEnabled } = await import('./access');

const user = { id: 'user-1' };

beforeEach(() => {
  state.flags = { EnableArtifacts: true };
  state.orgIds = [];
  state.platformValue = false;
  state.orgOverrides = {};
  state.readError = null;
  state.scopes = [];
  state.options = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('resolveCallableFunctionsEnabled', () => {
  it('is off when artifacts are off, without reading the setting', async () => {
    state.flags = { EnableArtifacts: false };
    state.platformValue = true;
    await expect(resolveCallableFunctionsEnabled(user)).resolves.toBe(false);
    expect(state.scopes).toEqual([]);
  });

  it('uses the value at the person scope when they belong to no organization', async () => {
    await expect(resolveCallableFunctionsEnabled(user)).resolves.toBe(false);
    state.platformValue = true;
    await expect(resolveCallableFunctionsEnabled(user)).resolves.toBe(true);
    expect(state.scopes.at(-1)).toEqual({ owner: { id: 'user-1', type: 'User' } });
  });

  it('is on for a member of one organization with an override on while the platform value is off', async () => {
    state.orgIds = ['org-a'];
    state.orgOverrides = { 'org-a': true };
    await expect(resolveCallableFunctionsEnabled(user)).resolves.toBe(true);
    expect(state.scopes).toEqual([{ organizationId: 'org-a', owner: { id: 'org-a', type: 'Organization' } }]);
    expect(state.options).toEqual([{ readFailureMode: 'throw' }]);
  });

  it('is on when any one of two organizations resolves on', async () => {
    state.orgIds = ['org-a', 'org-b'];
    state.orgOverrides = { 'org-b': true };
    await expect(resolveCallableFunctionsEnabled(user)).resolves.toBe(true);
    expect(state.scopes.map(scope => scope.organizationId)).toEqual(['org-a', 'org-b']);
  });

  it('is off when every organization resolves off', async () => {
    state.orgIds = ['org-a', 'org-b'];
    state.platformValue = true;
    state.orgOverrides = { 'org-a': false, 'org-b': false };
    await expect(resolveCallableFunctionsEnabled(user)).resolves.toBe(false);
  });

  it('rejects when the setting cannot be read', async () => {
    state.orgIds = ['org-a'];
    // The fallback would answer with this value, turning a failed read into "on".
    state.platformValue = true;
    state.readError = new Error('overlay unavailable');
    await expect(resolveCallableFunctionsEnabled(user)).rejects.toThrow('overlay unavailable');
  });
});

describe('assertCallableFunctionsEnabled', () => {
  it('throws ForbiddenError when off and resolves when on', async () => {
    await expect(assertCallableFunctionsEnabled(user)).rejects.toBeInstanceOf(ForbiddenError);
    state.platformValue = true;
    await expect(assertCallableFunctionsEnabled(user)).resolves.toBeUndefined();
  });
});
