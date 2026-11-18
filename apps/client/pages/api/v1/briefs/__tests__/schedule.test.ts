import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BriefScheduleSchema } from '@bike4mind/common';

const { contracts, userRepository } = vi.hoisted(() => ({
  contracts: [] as { operationId: string; auth: string; scopes?: readonly string[]; request?: unknown }[],
  userRepository: { getBriefSchedule: vi.fn(), setBriefSchedule: vi.fn() },
}));

vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: (contract: (typeof contracts)[number]) => {
    contracts.push(contract);
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain: Record<string, unknown> = Object.assign(
      async (req: { method: string }, res: unknown) => handlers[req.method]?.(req, res),
      {
        get: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.GET = fn), chain),
        put: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.PUT = fn), chain),
      }
    );
    return chain;
  },
}));
// The real dispatcher pulls in baseApi (and with it the whole auth/db graph).
vi.mock('@server/middlewares/dispatchByMethod', () => ({
  dispatchByMethod:
    (routes: Record<string, (req: unknown, res: { status: (code: number) => { end: () => void } }) => unknown>) =>
    (req: { method: string }, res: { status: (code: number) => { end: () => void } }) =>
      routes[req.method] ? routes[req.method](req, res) : res.status(405).end(),
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({ perUserRateLimit: () => vi.fn() }));
vi.mock('@bike4mind/database', () => ({ userRepository }));

import handler from '../schedule';

const call = async (method: 'GET' | 'PUT' | 'POST', validated?: Record<string, unknown>) => {
  const { req, res } = createMocks({ method });
  Object.assign(req, { user: { id: 'user-1' }, validated });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};

const schedule = { enabled: true, timeOfDay: '08:00', days: [1, 2, 3, 4, 5], timeZone: 'America/New_York' };

describe('/api/v1/briefs/schedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: new Date('2026-11-18T12:00:00Z'), toFake: ['Date'] });
  });

  it('is JWT-only with no scopes, and PUT validates against BriefScheduleSchema', () => {
    expect(contracts.map(c => [c.operationId, c.auth, c.scopes])).toEqual([
      ['getBriefSchedule', 'jwtOnly', undefined],
      ['putBriefSchedule', 'jwtOnly', undefined],
    ]);
    expect(contracts[1].request).toBe(BriefScheduleSchema);
  });

  it('GET returns null for a user who never saved a schedule', async () => {
    userRepository.getBriefSchedule.mockResolvedValue({ schedule: null, nextBriefAt: null });
    const res = await call('GET');
    expect(userRepository.getBriefSchedule).toHaveBeenCalledWith('user-1');
    expect(res._getJSONData()).toEqual({ schedule: null, nextBriefAt: null });
  });

  it.each([
    ['dropped', null],
    ['turned off', { ...schedule, enabled: false }],
  ])('GET reports no due time for a schedule a preferences write %s', async (_label, stored) => {
    userRepository.getBriefSchedule.mockResolvedValue({
      schedule: stored,
      nextBriefAt: new Date('2026-11-19T13:00:00Z'),
    });
    const res = await call('GET');
    expect(res._getJSONData()).toEqual({ schedule: stored, nextBriefAt: null });
  });

  it('GET reports the due time of an enabled schedule', async () => {
    const due = new Date('2026-11-19T13:00:00Z');
    userRepository.getBriefSchedule.mockResolvedValue({ schedule, nextBriefAt: due });
    const res = await call('GET');
    expect(res._getJSONData()).toEqual({ schedule, nextBriefAt: due.toISOString() });
  });

  it('PUT persists the schedule with its next due time in the schedule zone', async () => {
    const res = await call('PUT', schedule);
    const due = new Date('2026-11-18T13:00:00.000Z');
    expect(userRepository.setBriefSchedule).toHaveBeenCalledWith('user-1', schedule, due);
    expect(res._getJSONData()).toEqual({ schedule, nextBriefAt: due.toISOString() });
  });

  it('PUT with the schedule off keeps it and clears the due time', async () => {
    const off = { ...schedule, enabled: false };
    const res = await call('PUT', off);
    expect(userRepository.setBriefSchedule).toHaveBeenCalledWith('user-1', off, null);
    expect(res._getJSONData()).toEqual({ schedule: off, nextBriefAt: null });
  });

  it('405s a verb the path does not serve', async () => {
    const res = await call('POST');
    expect(res._getStatusCode()).toBe(405);
  });
});
