import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import {
  ForbiddenError,
  MODERATION_PAGE_READ,
  meetsAdminPermissionRequirement,
  missingAdminPermissionMessage,
  type AdminPermissionRequirement,
} from '@bike4mind/common';

const mocks = vi.hoisted(() => ({ getSignupVerdicts: vi.fn() }));
const h = vi.hoisted(() => ({ options: null as unknown }));
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: { adminPermissions: Partial<Record<string, AdminPermissionRequirement>> }) => {
    h.options = options;
    const chain = {
      use: () => chain,
      get: (fn: (req: unknown, res: unknown) => Promise<unknown>) => async (req: unknown, res: unknown) => {
        const requirement = options.adminPermissions.GET;
        const { user } = req as { user?: Parameters<typeof meetsAdminPermissionRequirement>[0] };
        if (requirement && !meetsAdminPermissionRequirement(user, requirement)) {
          throw new ForbiddenError(missingAdminPermissionMessage(requirement));
        }
        return fn(req, res);
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@server/users/signupTimeseries', () => ({ getSignupVerdicts: mocks.getSignupVerdicts }));
import handler from '../signup-verdicts';

const ID_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ID_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const AS_OF = () => new Date(Date.now() - 5 * 60 * 1000).toISOString();

const FULL_ADMIN = { id: 'admin-1', isAdmin: true };

const run = async (query: Record<string, string>, user: unknown = FULL_ADMIN) => {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { user });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
};

beforeEach(() => {
  mocks.getSignupVerdicts.mockReset().mockResolvedValue({ verdicts: { [ID_A]: null } });
});

describe('signup verdicts route', () => {
  it('declares MODERATION_PAGE_READ for GET', () => {
    expect(h.options).toEqual(expect.objectContaining({ adminPermissions: { GET: MODERATION_PAGE_READ } }));
  });

  it('refuses a delegate without a moderation read permission before classifying anything', async () => {
    const delegate = { id: 'admin-2', isAdmin: false, adminPermissions: ['credits:adjust'] };

    await expect(run({ range: '7d', asOf: AS_OF(), ids: ID_A }, delegate)).rejects.toThrow(
      missingAdminPermissionMessage(MODERATION_PAGE_READ)
    );
    expect(mocks.getSignupVerdicts).not.toHaveBeenCalled();
  });

  it.each(['support:read', 'users:moderate'])('admits a delegate holding %s', async permission => {
    const res = await run(
      { range: '7d', asOf: AS_OF(), ids: ID_A },
      { id: 'admin-2', isAdmin: false, adminPermissions: [permission] }
    );

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.getSignupVerdicts).toHaveBeenCalledTimes(1);
  });

  it("classifies the requested ids at the chart's instant, range and offset, uncached", async () => {
    const asOf = AS_OF();
    const res = await run({ range: '7d', tzOffset: '480', asOf, ids: `${ID_A},${ID_B},${ID_A}` });
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.getSignupVerdicts).toHaveBeenCalledWith(
      { range: '7d', tzOffsetMinutes: 480, userIds: [ID_A, ID_B] },
      new Date(asOf)
    );
    expect(res._getJSONData()).toEqual({ verdicts: { [ID_A]: null } });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });

  it.each([
    ['an unknown range', { range: '1y', ids: ID_A }, 'range'],
    ['a missing range', { ids: ID_A }, 'range'],
    ['an offset out of bounds', { range: '7d', tzOffset: '9999', ids: ID_A }, 'tzOffset'],
    ['a missing asOf', { range: '7d', asOf: undefined, ids: ID_A }, 'asOf'],
    ['an asOf in the future', { range: '7d', asOf: new Date(Date.now() + 3_600_000).toISOString(), ids: ID_A }, 'asOf'],
    [
      'an asOf over a day old',
      { range: '7d', asOf: new Date(Date.now() - 2 * 86_400_000).toISOString(), ids: ID_A },
      'asOf',
    ],
    ['an id that is not an ObjectId', { range: '7d', ids: `${ID_A},not-an-id` }, 'ids'],
    ['no ids', { range: '7d', ids: '' }, 'ids'],
    [
      'more ids than the largest page',
      { range: '7d', ids: Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(24, '0')).join(',') },
      'ids',
    ],
  ])('rejects %s and names the field', async (_, query, field) => {
    const params = Object.fromEntries(
      Object.entries({ asOf: AS_OF(), ...query }).filter(([, value]) => value !== undefined)
    ) as Record<string, string>;
    const res = await run(params);
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().message).toMatch(new RegExp(`^${field} `));
    expect(mocks.getSignupVerdicts).not.toHaveBeenCalled();
  });
});
