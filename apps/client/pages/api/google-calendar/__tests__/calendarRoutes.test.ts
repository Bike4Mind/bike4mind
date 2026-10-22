import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFreebusy = vi.fn();
const mockInsert = vi.fn();
const mockJwt = vi.fn();
const mockSettings: Record<string, string> = {};

vi.mock('@googleapis/calendar', () => ({
  auth: {
    JWT: class {
      constructor(opts: unknown) {
        mockJwt(opts);
      }
    },
  },
  calendar: () => ({
    freebusy: { query: (...args: unknown[]) => mockFreebusy(...args) },
    events: { insert: (...args: unknown[]) => mockInsert(...args) },
  }),
}));

vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: async () => mockSettings,
  getSettingsValue: (key: string, settings: Record<string, string>) => settings[key],
}));

vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      get: (handler: unknown) => handler,
      use: (handler: unknown) => handler,
    };
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (handler: unknown) => handler,
}));

import createEventHandler from '../create-event';
import availableHandler from '../available';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const createEvent = createEventHandler as unknown as Handler;
const available = availableHandler as unknown as Handler;

const makeRes = () => {
  const res: Record<string, unknown> = {};
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res;
};

const configure = () => {
  Object.assign(mockSettings, {
    googleCalendarServiceAccountEmail: 'svc@example.com',
    googleCalendarServiceAccountSecret: Buffer.from('key').toString('base64'),
    googleCalendarOrganizerEmail: 'organizer@example.com',
  });
};

const validBody = { objective: 'Intro call', date: '2030-01-07 10:00:00', timeZone: 'Asia/Manila' };

describe('google calendar routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(mockSettings)) delete mockSettings[k];
    mockInsert.mockResolvedValue({ data: {} });
    mockFreebusy.mockResolvedValue({ data: { calendars: {} } });
  });

  describe('create-event', () => {
    it('uses the configured calendar and ignores a client calendarId', async () => {
      configure();
      const res = makeRes();
      await createEvent(
        { body: { ...validBody, calendarId: 'other@example.com' }, user: { email: 'me@example.com' } },
        res
      );
      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockInsert.mock.calls[0][0].calendarId).toBe('organizer@example.com');
    });

    it('invites only the calling user and ignores client attendees', async () => {
      configure();
      await createEvent(
        {
          body: { ...validBody, attendees: [{ email: 'x@example.com' }, { email: 'y@example.com' }] },
          user: { email: 'me@example.com' },
        },
        makeRes()
      );
      expect(mockInsert.mock.calls[0][0].requestBody.attendees).toEqual([{ email: 'me@example.com' }]);
    });

    it.each([
      ['missing objective', { date: validBody.date, timeZone: validBody.timeZone }],
      ['oversized objective', { ...validBody, objective: 'a'.repeat(2001) }],
      ['unparseable date', { ...validBody, date: 'tomorrow' }],
      ['unknown time zone', { ...validBody, timeZone: 'Not/AZone' }],
    ])('rejects an invalid body: %s', async (_name, body) => {
      configure();
      await expect(createEvent({ body, user: { email: 'me@example.com' } }, makeRes())).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('hides Google errors behind a bad gateway error', async () => {
      configure();
      mockInsert.mockRejectedValue(Object.assign(new Error('unauthorized_client: secret detail'), { status: 401 }));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(
        createEvent({ body: validBody, user: { email: 'me@example.com' } }, makeRes())
      ).rejects.toMatchObject({ statusCode: 502, message: 'Google Calendar request failed' });
    });

    it('rejects a user with no email', async () => {
      configure();
      await expect(createEvent({ body: validBody, user: { email: null } }, makeRes())).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('returns an unavailable error when settings are empty', async () => {
      await expect(
        createEvent({ body: validBody, user: { email: 'me@example.com' } }, makeRes())
      ).rejects.toMatchObject({
        statusCode: 503,
      });
      expect(mockInsert).not.toHaveBeenCalled();
      expect(mockJwt).not.toHaveBeenCalled();
    });
  });

  describe('available', () => {
    const query = { year: '2030', weekNumber: '2', timeZone: 'Asia/Manila' };

    it('uses the configured calendar and ignores a client calendarId', async () => {
      configure();
      const res = makeRes();
      await available({ query: { ...query, calendarId: 'other@example.com' } }, res);
      expect(mockFreebusy.mock.calls[0][0].requestBody.items).toEqual([{ id: 'organizer@example.com' }]);
      expect(res.json).toHaveBeenCalled();
    });

    it('hides Google errors behind a bad gateway error', async () => {
      configure();
      mockFreebusy.mockRejectedValue(Object.assign(new Error('unauthorized_client: secret detail'), { status: 401 }));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(available({ query }, makeRes())).rejects.toMatchObject({ statusCode: 502 });
    });

    it('rejects an invalid query', async () => {
      configure();
      await expect(available({ query: { ...query, year: 'abc' } }, makeRes())).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(mockFreebusy).not.toHaveBeenCalled();
    });

    it('returns an unavailable error when settings are empty', async () => {
      await expect(available({ query }, makeRes())).rejects.toMatchObject({ statusCode: 503 });
      expect(mockFreebusy).not.toHaveBeenCalled();
    });
  });
});
