import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({ getSignupVerdicts: vi.fn() }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = { use: () => chain, get: (handler: unknown) => handler };
    return chain;
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@server/users/signupTimeseries', () => ({ getSignupVerdicts: mocks.getSignupVerdicts }));
import handler from '../signup-verdicts';

const ID_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ID_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const run = async (query: Record<string, string>, isAdmin = true) => {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { user: { id: 'admin-1', isAdmin } });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
};

beforeEach(() => {
  mocks.getSignupVerdicts.mockReset().mockResolvedValue({ verdicts: { [ID_A]: null } });
});

describe('signup verdicts route', () => {
  it('rejects non-admins before classifying anything', async () => {
    const res = await run({ range: '7d', ids: ID_A }, false);
    expect(res._getStatusCode()).toBe(403);
    expect(mocks.getSignupVerdicts).not.toHaveBeenCalled();
  });

  it('classifies the requested ids under the chart range and offset, uncached', async () => {
    const res = await run({ range: '7d', tzOffset: '480', ids: `${ID_A},${ID_B},${ID_A}` });
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.getSignupVerdicts).toHaveBeenCalledWith({ range: '7d', tzOffsetMinutes: 480, userIds: [ID_A, ID_B] });
    expect(res._getJSONData()).toEqual({ verdicts: { [ID_A]: null } });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });

  it.each([
    ['an unknown range', { range: '1y', ids: ID_A }],
    ['a missing range', { ids: ID_A }],
    ['an id that is not an ObjectId', { range: '7d', ids: `${ID_A},not-an-id` }],
    ['no ids', { range: '7d', ids: '' }],
    [
      'more ids than the largest page',
      { range: '7d', ids: Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(24, '0')).join(',') },
    ],
  ])('rejects %s', async (_, query) => {
    const res = await run(query);
    expect(res._getStatusCode()).toBe(400);
    expect(mocks.getSignupVerdicts).not.toHaveBeenCalled();
  });
});
