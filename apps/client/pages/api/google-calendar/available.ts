import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { getAvailableTimeSlots } from '@server/integrations/google/calendar/common';

const isValidTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const AvailableRequestSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  weekNumber: z.number().int().min(1).max(53),
  timeZone: z.string().min(1).max(100).refine(isValidTimeZone),
});

const handler = baseApi().get(
  asyncHandler<unknown, unknown, unknown, Record<string, string>>(async (req, res) => {
    const parsed = AvailableRequestSchema.safeParse({
      year: Number(req.query.year),
      weekNumber: Number(req.query.weekNumber),
      timeZone: req.query.timeZone,
    });
    if (!parsed.success) throw new BadRequestError('Invalid calendar request');
    const { year, weekNumber, timeZone } = parsed.data;
    const slots = await getAvailableTimeSlots(year, weekNumber, timeZone);
    return res.json(slots);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
