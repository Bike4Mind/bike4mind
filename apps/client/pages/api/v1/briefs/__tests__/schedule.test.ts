import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BriefScheduleSchema } from '@bike4mind/common';

const { contracts, userRepository, assistantBriefRepository } = vi.hoisted(() => ({
  contracts: [] as { operationId: string; auth: string; scopes?: readonly string[]; request?: unknown }[],
  userRepository: { getBriefSchedule: vi.fn(), setBriefSchedule: vi.fn(), pullNextBriefAtForward: vi.fn() },
  assistantBriefRepository: { findEarliestPendingReminderAt: vi.fn() },
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
vi.mock('@bike4mind/database', () => ({ userRepository, assistantBriefRepository }));

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
    vi.resetAllMocks();
    let stored: { schedule: typeof schedule | null; nextBriefAt: Date | null } = { schedule: null, nextBriefAt: null };
    userRepository.setBriefSchedule.mockImplementation(async (_id, value: typeof schedule, due: Date | null) => {
      stored = { schedule: value, nextBriefAt: due };
    });
    userRepository.getBriefSchedule.mockImplementation(async () => stored);
    userRepository.pullNextBriefAtForward.mockImplementation(async (_id, due: Date) => {
      if (stored.schedule?.enabled && (!stored.nextBriefAt || due < stored.nextBriefAt)) stored.nextBriefAt = due;
    });
    vi.useFakeTimers({ now: new Date('2026-11-18T12:00:00Z'), toFake: ['Date'] });
    assistantBriefRepository.findEarliestPendingReminderAt.mockResolvedValue(null);
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

  it('PUT keeps the due time at an approved reminder that comes before the next slot', async () => {
    const reminder = new Date('2026-11-18T12:30:00.000Z');
    assistantBriefRepository.findEarliestPendingReminderAt.mockResolvedValue(reminder);
    const res = await call('PUT', schedule);
    expect(userRepository.pullNextBriefAtForward).toHaveBeenCalledWith('user-1', reminder);
    expect(res._getJSONData()).toEqual({ schedule, nextBriefAt: reminder.toISOString() });
  });

  it('PUT ignores a reminder later than the next slot, and any reminder when the schedule is off', async () => {
    assistantBriefRepository.findEarliestPendingReminderAt.mockResolvedValue(new Date('2026-11-19T09:00:00.000Z'));
    await call('PUT', schedule);
    expect(userRepository.setBriefSchedule).toHaveBeenCalledWith(
      'user-1',
      schedule,
      new Date('2026-11-18T13:00:00.000Z')
    );
    const off = { ...schedule, enabled: false };
    await call('PUT', off);
    expect(userRepository.setBriefSchedule).toHaveBeenLastCalledWith('user-1', off, null);
  });

  it('PUT with the schedule off keeps it and clears the due time', async () => {
    const off = { ...schedule, enabled: false };
    const res = await call('PUT', off);
    expect(userRepository.setBriefSchedule).toHaveBeenCalledWith('user-1', off, null);
    expect(res._getJSONData()).toEqual({ schedule: off, nextBriefAt: null });
  });

  it('keeps a reminder approved while the schedule replacement is held', async () => {
    const reminder = new Date('2026-11-18T12:30:00Z');
    let stored = new Date('2026-11-18T13:00:00Z');
    let approved = false;
    assistantBriefRepository.findEarliestPendingReminderAt.mockImplementation(async () => (approved ? reminder : null));
    userRepository.setBriefSchedule.mockImplementation(async (_id, _schedule, due: Date) => {
      // An approval pulls the old due time forward immediately before this held write commits.
      approved = true;
      stored = reminder;
      stored = due;
    });
    userRepository.pullNextBriefAtForward.mockImplementation(async (_id, due: Date) => {
      if (due < stored) stored = due;
    });
    userRepository.getBriefSchedule.mockImplementation(async () => ({ schedule, nextBriefAt: stored }));
    const res = await call('PUT', schedule);
    expect(stored).toEqual(reminder);
    expect(res._getJSONData()).toEqual({ schedule, nextBriefAt: reminder.toISOString() });
  });

  it('does not replace a schedule when the initial reminder lookup fails', async () => {
    assistantBriefRepository.findEarliestPendingReminderAt.mockRejectedValueOnce(new Error('lookup unavailable'));
    await expect(call('PUT', schedule)).rejects.toThrow('lookup unavailable');
    expect(userRepository.setBriefSchedule).not.toHaveBeenCalled();
  });

  it('retains a known earlier reminder when the post-write lookup fails', async () => {
    const reminder = new Date('2026-11-18T12:05:00Z');
    let stored = reminder;
    let written = false;
    assistantBriefRepository.findEarliestPendingReminderAt.mockImplementation(async () => {
      if (written) throw new Error('lookup unavailable');
      return reminder;
    });
    userRepository.setBriefSchedule.mockImplementation(async (_id, _schedule, due: Date) => {
      stored = due;
      written = true;
    });
    userRepository.pullNextBriefAtForward.mockImplementation(async (_id, due: Date) => {
      if (due < stored) stored = due;
    });
    await expect(call('PUT', schedule)).rejects.toThrow('lookup unavailable');
    expect(stored).toEqual(reminder);
  });

  it('bounds retry after an unseen approval races a write whose post-read fails', async () => {
    assistantBriefRepository.findEarliestPendingReminderAt
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('lookup unavailable'));
    await expect(call('PUT', schedule)).rejects.toThrow('lookup unavailable');
    expect((await userRepository.getBriefSchedule('user-1')).nextBriefAt).toEqual(new Date('2026-11-18T12:15:00Z'));
  });

  it('405s a verb the path does not serve', async () => {
    const res = await call('POST');
    expect(res._getStatusCode()).toBe(405);
  });
});
