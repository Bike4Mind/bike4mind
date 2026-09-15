// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';

// Keep @bike4mind/common real: SettingKeySchema and the HTTP error classes under test are the actual
// ones. Mock only the infra + service + middleware seams - resolution itself is covered by
// resolveScopedSetting.test.ts, so this route's tests assert only that it wires the call correctly.
const resolveScopedSetting = vi.fn();

// vi.mock factories are hoisted above every top-level const, so the stub objects are declared
// inline here rather than referenced from outside - an outer const would still be in the
// temporal-dead-zone when this factory runs.
vi.mock('@bike4mind/database/infra', () => ({
  adminSettingsRepository: { name: 'admin-settings-stub' },
  scopedSettingsRepository: { name: 'scoped-settings-stub' },
}));
vi.mock('@bike4mind/services', () => ({
  scopedSettingsService: {
    resolveScopedSetting: (...args: unknown[]) => resolveScopedSetting(...args),
  },
}));
// The route builds itself at import time via .get(), so the chain captures the handler on itself
// under a `__get` key; the default export IS the chain, which is how a test gets hold of the handler.
vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, unknown> = {};
  chain.get = (routeHandler: unknown) => {
    chain.__get = routeHandler;
    return chain;
  };
  return {
    baseApi: (config?: unknown) => {
      chain.__config = config;
      return chain;
    },
  };
});

import { adminSettingsRepository, scopedSettingsRepository } from '@bike4mind/database/infra';
import handler from '../effective';

type RouteHandler = (req: unknown, res: unknown) => Promise<unknown>;

const route = handler as unknown as { __get: RouteHandler; __config?: unknown };

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** Invoke the handler and return whatever it passed to res.json. */
const invoke = async (req: { query?: unknown; isAdmin?: boolean } = {}) => {
  const json = vi.fn((x: unknown) => x);
  const { isAdmin = true, ...rest } = req;
  await route.__get({ user: { isAdmin }, logger, ...rest }, { json });
  return json.mock.calls[0]?.[0];
};

const expectStatus = (req: Parameters<typeof invoke>[0], statusCode: number) =>
  expect(invoke(req)).rejects.toMatchObject({ statusCode });

describe('admin/scoped-settings/effective authorization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses a non-admin', async () => {
    await expectStatus({ isAdmin: false, query: { settingName: 'PauseLakeConvergence' } }, 403);
    expect(resolveScopedSetting).not.toHaveBeenCalled();
  });

  it('requires the ADMIN scope so an under-scoped admin-owned key is 403d by apiKeyAuth', () => {
    expect(route.__config).toEqual({ requiredScopes: [ApiKeyScope.ADMIN] });
  });
});

describe('admin/scoped-settings/effective request validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects an unknown setting name', async () => {
    await expectStatus({ query: { settingName: 'NotASetting' } }, 400);
    expect(resolveScopedSetting).not.toHaveBeenCalled();
  });

  it('rejects a missing setting name', async () => {
    await expectStatus({ query: {} }, 400);
    expect(resolveScopedSetting).not.toHaveBeenCalled();
  });

  it.each([
    ['ownerId with no ownerType', { ownerId: 'user-1' }, 'ownerType'],
    ['ownerType with no ownerId', { ownerType: 'User' }, 'ownerId'],
  ])('rejects %s - the pair must arrive together', async (_label, ownerQuery, missingField) => {
    await expectStatus({ query: { settingName: 'PauseLakeConvergence', ...ownerQuery } }, 400);
    expect(resolveScopedSetting).not.toHaveBeenCalled();
    // The error names whichever half was actually missing, not always the same field.
    await expect(invoke({ query: { settingName: 'PauseLakeConvergence', ...ownerQuery } })).rejects.toThrow(
      new RegExp(missingField)
    );
  });
});

describe('admin/scoped-settings/effective resolution', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves a platform-only query (no scope fields) and returns value + source', async () => {
    resolveScopedSetting.mockResolvedValue({ value: 'gpt-4o', source: 'platform' });

    const response = await invoke({ query: { settingName: 'DefaultAPIModel' } });

    expect(resolveScopedSetting).toHaveBeenCalledWith(
      'DefaultAPIModel',
      { organizationId: undefined, owner: undefined, lakeId: undefined },
      { adminSettings: adminSettingsRepository, scopedSettings: scopedSettingsRepository },
      { logger }
    );
    expect(response).toEqual({
      settingName: 'DefaultAPIModel',
      scope: { organizationId: undefined, owner: undefined, lakeId: undefined },
      value: 'gpt-4o',
      source: 'platform',
    });
  });

  it('builds an organization + lake scope from the matching query params', async () => {
    resolveScopedSetting.mockResolvedValue({ value: true, source: 'lake' });

    await invoke({
      query: { settingName: 'PauseLakeConvergence', organizationId: 'org-1', lakeId: 'lake-1' },
    });

    expect(resolveScopedSetting).toHaveBeenCalledWith(
      'PauseLakeConvergence',
      { organizationId: 'org-1', owner: undefined, lakeId: 'lake-1' },
      expect.anything(),
      expect.anything()
    );
  });

  it('builds an owner scope from ownerId + ownerType together', async () => {
    resolveScopedSetting.mockResolvedValue({ value: 5, source: 'owner' });

    await invoke({
      query: { settingName: 'kbSearchDefaultResults', ownerId: 'org-7', ownerType: 'Organization' },
    });

    expect(resolveScopedSetting).toHaveBeenCalledWith(
      'kbSearchDefaultResults',
      { organizationId: undefined, owner: { id: 'org-7', type: 'Organization' }, lakeId: undefined },
      expect.anything(),
      expect.anything()
    );
  });

  // A sensitive key always resolves from the platform rung (it can never be scoped), so this is the
  // one path where resolveScopedSetting would otherwise hand back a decrypted plaintext secret -
  // proving redaction actually runs, not just that the route compiles against the real helper.
  it('redacts the value for a sensitive setting instead of returning it plaintext', async () => {
    resolveScopedSetting.mockResolvedValue({ value: 'sk-live-actualSecretValue', source: 'platform' });

    const response = await invoke({ query: { settingName: 'anthropicDemoKey' } });

    expect((response as { value: unknown }).value).not.toBe('sk-live-actualSecretValue');
  });

  it('omits ignoredOverrides from the response when the resolver reports none', async () => {
    resolveScopedSetting.mockResolvedValue({ value: 'gpt-4o', source: 'platform' });

    const response = await invoke({ query: { settingName: 'DefaultAPIModel' } });

    expect(response).not.toHaveProperty('ignoredOverrides');
  });

  // Lets an admin investigating "I set this lever and nothing happened" see a discarded override
  // instead of a source:"platform" indistinguishable from a lever that was never set.
  it('surfaces ignoredOverrides when the resolver reports a discarded narrower override', async () => {
    resolveScopedSetting.mockResolvedValue({
      value: 3,
      source: 'platform',
      ignoredOverrides: [{ scopeLevel: 'organization', scopeId: 'org-1', reason: 'unparseable' }],
    });

    const response = await invoke({ query: { settingName: 'kbSearchDefaultResults' } });

    expect(response).toEqual({
      settingName: 'kbSearchDefaultResults',
      scope: { organizationId: undefined, owner: undefined, lakeId: undefined },
      value: 3,
      source: 'platform',
      ignoredOverrides: [{ scopeLevel: 'organization', scopeId: 'org-1', reason: 'unparseable' }],
    });
  });
});
