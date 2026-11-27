// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const state = vi.hoisted(() => ({
  stage: 'production',
  sourceSecret: (): { value?: string } | undefined => undefined,
  adminOptions: undefined as unknown,
}));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: unknown) => {
    state.adminOptions = options;
    return { get: (handler: unknown) => handler };
  },
}));
vi.mock('sst', () => ({
  Resource: new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === 'App') return { stage: state.stage };
        if (key === 'IS_SOURCE_DEPLOYMENT') return state.sourceSecret();
        return undefined;
      },
    }
  ),
}));

import handler from '../deployment-info';

const declaredOptions = state.adminOptions;

const run = async () => {
  const { req, res } = createMocks({ method: 'GET' });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res._getJSONData();
};

const unlinked = () => {
  throw new Error('"IS_SOURCE_DEPLOYMENT" is not linked');
};

beforeEach(() => {
  state.stage = 'production';
  state.sourceSecret = () => ({ value: 'true' });
});

describe('GET /api/admin/deployment-info', () => {
  it('serves a JWT session with the settings:manage permission and no API-key scope', () => {
    expect(declaredOptions).toEqual({ auth: 'jwtOnly', adminPermissions: { GET: 'settings:manage' } });
  });

  it('is not a fork on a source deployment in production', async () => {
    expect(await run()).toEqual({ stage: 'production', isForkProduction: false });
  });

  it.each([
    ['the flag is false', () => ({ value: 'false' })],
    ['the flag has no value', () => ({})],
    ['the flag is missing', () => undefined],
  ])('is a fork in production when %s', async (_label, secret) => {
    state.sourceSecret = secret;
    expect(await run()).toEqual({ stage: 'production', isForkProduction: true });
  });

  it.each([
    ['dev', { value: 'true' }],
    ['staging', { value: 'false' }],
    ['pr6756', undefined],
  ])('is not a fork on the %s stage', async (stage, secret) => {
    state.stage = stage;
    state.sourceSecret = () => secret;
    expect(await run()).toEqual({ stage, isForkProduction: false });
  });

  it('is a fork in production when reading the secret throws', async () => {
    state.sourceSecret = unlinked;
    expect(await run()).toEqual({ stage: 'production', isForkProduction: true });
  });

  it('is not a fork outside production when reading the secret throws', async () => {
    state.stage = 'staging';
    state.sourceSecret = unlinked;
    expect(await run()).toEqual({ stage: 'staging', isForkProduction: false });
  });
});
