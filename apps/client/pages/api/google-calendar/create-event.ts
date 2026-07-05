import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';
import { createEvent } from '@server/integrations/google/calendar/common';

export const CreateEventRequestSchema = z.object({
  objective: z.string(),
  calendarId: z.string().optional(),
  date: z.string().optional(),
  timeZone: z.string().optional(),
  attendees: z.array(z.object({ email: z.string() })).optional(),
});

const handler = baseApi().use(
  asyncHandler(async (req, res) => {
    const { objective, calendarId, date, timeZone, attendees } = CreateEventRequestSchema.parse(req.body);

    try {
      await createEvent({
        calendarId: calendarId!,
        summary: 'Schedule Session',
        description: objective,
        date: date!,
        timeZone: timeZone!,
        attendees: attendees!,
      });
      return res.send('success');
    } catch (error) {
      return res.status(500).send(`Unable to create calendar event: ${error}`);
    }
  })
);

export default handler;
