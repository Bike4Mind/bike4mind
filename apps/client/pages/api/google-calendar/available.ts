import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';
import { getAvailableTimeSlots } from '@server/integrations/google/calendar/common';

const AvailableRequestSchema = z.object({
  calendarId: z.string(),
  year: z.number(),
  weekNumber: z.number(),
  timeZone: z.string(),
});

const handler = baseApi().get(
  asyncHandler<unknown, unknown, unknown, Record<string, string>>(async (req, res) => {
    const { calendarId, year, weekNumber, timeZone } = AvailableRequestSchema.parse({
      ...req.query,
      year: Number(req.query.year),
      weekNumber: Number(req.query.weekNumber),
    });
    const slots = await getAvailableTimeSlots(calendarId, year, weekNumber, timeZone);
    return res.json(slots);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
