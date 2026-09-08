// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Keep @bike4mind/common real: the settingsMap, SettingKeySchema and HTTP error classes under test
// are the actual ones. Mock only the infra + service + middleware seams.
const find = vi.fn();
const writeScopedOverride = vi.fn();
const clearScopedOverride = vi.fn();

vi.mock('@bike4mind/database/infra', () => ({
  scopedSettingsRepository: { find: (...args: unknown[]) => find(...args) },
}));
vi.mock('@bike4mind/services', () => ({
  scopedSettingsService: {
    writeScopedOverride: (...args: unknown[]) => writeScopedOverride(...args),
    clearScopedOverride: (...args: unknown[]) => clearScopedOverride(...args),
  },
}));
// The route builds itself at import time via .get().put().delete(), so the chain captures each
// handler on itself under a `__<method>` key; the default export IS the chain, which is how a test
// gets hold of one method's handler. Assigning into a registry declared in this file would run
// before that declaration (the route is imported before the test body executes).
vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, unknown> = {};
  for (const method of ['get', 'put', 'delete']) {
    chain[method] = (routeHandler: unknown) => {
      chain[`__${method}`] = routeHandler;
      return chain;
    };
  }
  return { baseApi: () => chain };
});

import handler from '../index';

type RouteHandler = (req: unknown, res: unknown) => Promise<unknown>;

const routes = handler as unknown as Record<string, RouteHandler>;

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** Invoke one method's handler and return whatever it passed to res.json. */
const invoke = async (
  method: 'get' | 'put' | 'delete',
  req: { body?: unknown; query?: unknown; isAdmin?: boolean } = {}
) => {
  const json = vi.fn((x: unknown) => x);
  const { isAdmin = true, ...rest } = req;
  await routes[`__${method}`]({ user: { isAdmin }, logger, ...rest }, { json });
  return json.mock.calls[0]?.[0];
};

const expectStatus = (method: 'get' | 'put' | 'delete', req: Parameters<typeof invoke>[1], statusCode: number) =>
  expect(invoke(method, req)).rejects.toMatchObject({ statusCode });

const lakePause = {
  settingName: 'PauseLakeConvergence',
  scopeLevel: 'lake',
  scopeId: 'lake-1',
  value: true,
};

describe('admin/scoped-settings authorization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses a non-admin on every method', async () => {
    await expectStatus('get', { isAdmin: false }, 403);
    await expectStatus('put', { isAdmin: false, body: lakePause }, 403);
    await expectStatus(
      'delete',
      { isAdmin: false, query: { settingName: 'PauseLakeConvergence', scopeLevel: 'lake', scopeId: 'lake-1' } },
      403
    );
    expect(writeScopedOverride).not.toHaveBeenCalled();
    expect(clearScopedOverride).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
  });
});

describe('admin/scoped-settings request validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects the platform rung - the platform value has its own writer', async () => {
    await expectStatus('put', { body: { ...lakePause, scopeLevel: 'platform' } }, 400);
    expect(writeScopedOverride).not.toHaveBeenCalled();
  });

  it('rejects an unknown setting name', async () => {
    await expectStatus('put', { body: { ...lakePause, settingName: 'NotASetting' } }, 400);
    expect(writeScopedOverride).not.toHaveBeenCalled();
  });

  it('rejects an empty scopeId', async () => {
    await expectStatus('put', { body: { ...lakePause, scopeId: '' } }, 400);
    expect(writeScopedOverride).not.toHaveBeenCalled();
  });

  it('rejects a missing value before it can reach the write service', async () => {
    await expectStatus(
      'put',
      { body: { settingName: 'PauseLakeConvergence', scopeLevel: 'lake', scopeId: 'l1' } },
      400
    );
    expect(writeScopedOverride).not.toHaveBeenCalled();
  });

  it.each([
    ['an object', { nested: true }],
    ['an array', [1, 2]],
    ['null', null],
    // JSON has no Infinity literal, but 1e999 parses to one, and String(Infinity) would be stored.
    ['a non-finite number', Number.POSITIVE_INFINITY],
  ])('rejects %s as a value', async (_label, value) => {
    await expectStatus('put', { body: { ...lakePause, value } }, 400);
    expect(writeScopedOverride).not.toHaveBeenCalled();
  });

  // Blank is not empty to a number setting: z.coerce.number('') is 0, in range for the two
  // `min: 0` settings, so without the route guard the overlay stores "" and resolves it as 0.
  it.each([
    ['empty', ''],
    ['whitespace', '   '],
  ])('rejects a %s string value', async (_label, value) => {
    const body = { settingName: 'kbSearchMinRelevancePct', scopeLevel: 'organization', scopeId: 'org-1', value };
    await expectStatus('put', { body }, 400);
    expect(writeScopedOverride).not.toHaveBeenCalled();
  });

  it('rejects a DELETE with an incomplete address', async () => {
    await expectStatus('delete', { query: { settingName: 'PauseLakeConvergence', scopeLevel: 'lake' } }, 400);
    expect(clearScopedOverride).not.toHaveBeenCalled();
  });
});

/**
 * The write service owns these rules; what is under test here is only that its plain-Error
 * rejections come back as a readable 400 rather than the 500 `errorHandler` gives a plain Error -
 * a 500 also logs at `error` level and trips the LiveOps CloudWatch filter, so an admin typing an
 * out-of-range number would page someone.
 */
describe('admin/scoped-settings service rejection translation', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [
      'a platform-only setting',
      { settingName: 'DefaultAPIModel', scopeLevel: 'organization', scopeId: 'org-1', value: 'gpt-4o' },
      "[scopedSettings] 'DefaultAPIModel' is not settable at scope level 'organization'",
    ],
    [
      'a sensitive setting',
      { settingName: 'anthropicDemoKey', scopeLevel: 'organization', scopeId: 'org-1', value: 'sk-test' },
      "[scopedSettings] 'anthropicDemoKey' is sensitive and cannot be scoped",
    ],
    [
      'an out-of-range number',
      { settingName: 'kbSearchMinRelevancePct', scopeLevel: 'organization', scopeId: 'org-1', value: 500 },
      "[scopedSettings] value for 'kbSearchMinRelevancePct' failed validation: 500",
    ],
    [
      'an owner rung with no ownerType',
      { settingName: 'kbSearchDefaultResults', scopeLevel: 'owner', scopeId: 'user-1', value: 5 },
      "[scopedSettings] ownerType is required when writing an owner-scoped override for 'kbSearchDefaultResults'",
    ],
    [
      'a non-owner rung carrying an ownerType',
      { ...lakePause, ownerType: 'User' },
      "[scopedSettings] ownerType is only meaningful at the owner scope, not 'lake'",
    ],
  ])('answers 400 with the service message for %s', async (_label, body, message) => {
    writeScopedOverride.mockRejectedValue(new Error(message));
    await expectStatus('put', { body }, 400);
    await expect(invoke('put', { body })).rejects.toThrow(message);
  });

  it('leaves a failure that is not a write-service rejection as a server error', async () => {
    const driverFailure = Object.assign(new Error('connection timed out'), { name: 'MongoServerError' });
    writeScopedOverride.mockRejectedValue(driverFailure);

    await expect(invoke('put', { body: lakePause })).rejects.toBe(driverFailure);
  });
});

describe('admin/scoped-settings writes', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['a boolean', true, 'true'],
    ['a boolean off', false, 'false'],
    ['a number', 42, '42'],
  ])('stringifies %s on the way to the write service', async (_label, value, settingValue) => {
    writeScopedOverride.mockResolvedValue(undefined);

    const response = await invoke('put', { body: { ...lakePause, value } });

    // The overlay stores this string verbatim and the resolver re-parses it, so the stored
    // representation is the contract the round trip depends on.
    expect(writeScopedOverride).toHaveBeenCalledWith(
      'PauseLakeConvergence',
      { scopeLevel: 'lake', scopeId: 'lake-1', ownerType: undefined },
      settingValue,
      { scopedSettings: expect.anything() },
      { logger }
    );
    expect(response).toMatchObject({
      settingName: 'PauseLakeConvergence',
      scopeLevel: 'lake',
      scopeId: 'lake-1',
      settingValue,
    });
  });

  it('carries ownerType through on an owner-rung write', async () => {
    writeScopedOverride.mockResolvedValue(undefined);

    await invoke('put', {
      body: {
        settingName: 'kbSearchDefaultResults',
        scopeLevel: 'owner',
        scopeId: 'org-7',
        ownerType: 'Organization',
        value: 5,
      },
    });

    expect(writeScopedOverride).toHaveBeenCalledWith(
      'kbSearchDefaultResults',
      { scopeLevel: 'owner', scopeId: 'org-7', ownerType: 'Organization' },
      '5',
      expect.anything(),
      expect.anything()
    );
  });

  it('clears the override at the address given in the query', async () => {
    clearScopedOverride.mockResolvedValue(undefined);

    const response = await invoke('delete', {
      query: { settingName: 'PauseLakeConvergence', scopeLevel: 'lake', scopeId: 'lake-1' },
    });

    expect(clearScopedOverride).toHaveBeenCalledWith(
      'PauseLakeConvergence',
      { scopeLevel: 'lake', scopeId: 'lake-1' },
      { scopedSettings: expect.anything() },
      { logger }
    );
    expect(response).toEqual({ cleared: true });
  });
});

describe('admin/scoped-settings inventory', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns every live override row', async () => {
    const rows = [
      { settingName: 'PauseLakeConvergence', scopeLevel: 'lake', scopeId: 'lake-1', settingValue: 'true' },
      { settingName: 'kbSearchDefaultResults', scopeLevel: 'owner', scopeId: 'user-1', settingValue: '7' },
    ];
    find.mockResolvedValue(rows);

    expect(await invoke('get')).toBe(rows);
    expect(find).toHaveBeenCalledWith({});
  });
});
