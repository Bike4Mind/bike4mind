// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ForbiddenError } from '@bike4mind/common';

const state = vi.hoisted(() => ({ switchOn: false }));

vi.mock('@server/middlewares/adminApi', async () => {
  const { makeChain } = await import('./chain');
  return { adminApi: (config?: unknown) => makeChain(config) };
});
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSettingByName: async () => state.switchOn,
}));
vi.mock('@server/tutorials/registry', async () => {
  const { FIXTURE_REGISTRY } = await import('@server/tutorials/__tests__/fixture');
  const CORE_TUTORIALS = [FIXTURE_REGISTRY];
  return { CORE_TUTORIALS, resolveCoreTutorial: (id: string) => CORE_TUTORIALS.find(t => t.id === id) ?? null };
});
vi.mock('@server/tutorials/content', async () => {
  const { FIXTURE_CONTENT } = await import('@server/tutorials/__tests__/fixture');
  return { CORE_TUTORIAL_CONTENT: [FIXTURE_CONTENT] };
});
vi.mock('@server/tutorials/models', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  tutorialModels: () => ({
    Progress: {},
    Override: { find: () => ({ lean: async () => [] }) },
    OverrideChange: { aggregate: async () => [] },
    Draft: {},
  }),
}));
vi.mock('@server/tutorials/coreDeps', () => ({ coreTutorialDepsFor: () => ({}) }));

import overrides from '../overrides';
import settings from '../settings';
import summary from '../summary';

type Route = (req: unknown, res: unknown) => Promise<void>;
const FULL = { id: 'a1', isAdmin: true };
const DELEGATED = { id: 'd1', isAdmin: false, adminPermissions: ['settings:manage'] };

const call = async (route: unknown, user: Record<string, unknown>, method = 'GET') => {
  const { req, res } = createMocks({ method: method as 'GET' });
  Object.assign(req, { user, logger: { info: vi.fn(), warn: vi.fn() } });
  const outcome = await (route as Route)(req, res).then(
    () => null,
    (e: unknown) => e
  );
  return { res, outcome };
};

beforeEach(() => {
  state.switchOn = false;
});

describe('core tutorial admin routes', () => {
  it.each([
    ['settings', settings],
    ['overrides', overrides],
    ['summary', summary],
  ])('%s is jwtOnly and requires settings:manage', (_name, route) => {
    const config = (route as unknown as { _config: { auth?: string; adminPermissions: Record<string, string> } })
      ._config;
    expect(config.auth).toBe('jwtOnly');
    expect(Object.values(config.adminPermissions)).toEqual(
      Object.values(config.adminPermissions).map(() => 'settings:manage')
    );
  });

  it.each([
    ['settings', settings],
    ['overrides', overrides],
    ['summary', summary],
  ])('%s refuses a delegated admin who is not isAdmin', async (_name, route) => {
    const { res, outcome } = await call(route, DELEGATED);
    expect(outcome).toBeInstanceOf(ForbiddenError);
    expect(res._getData()).toBe('');
  });

  it('summary lists the registry to a full admin while the switch is off', async () => {
    const { res, outcome } = await call(summary, FULL);
    expect(outcome).toBeNull();
    expect(res._getJSONData()).toEqual([{ id: 'fixture', title: 'Fixture tutorial', enabled: true }]);
  });

  it('overrides lists the fixture module to a full admin', async () => {
    const { res, outcome } = await call(overrides, FULL);
    expect(outcome).toBeNull();
    expect(JSON.stringify(res._getJSONData())).toContain('fixture');
  });
});
