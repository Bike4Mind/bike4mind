import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { createEvent, isValidTimeZone } from '@server/integrations/google/calendar/common';

export const CreateEventRequestSchema = z.object({
  objective: z.string().min(1).max(2000),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/),
  timeZone: z.string().min(1).max(100).refine(isValidTimeZone),
});

const handler = baseApi().use(
  asyncHandler(async (req, res) => {
    const parsed = CreateEventRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError('Invalid calendar event');
    const { objective, date, timeZone } = parsed.data;

    const email = req.user?.email;
    if (!email) throw new BadRequestError('Your account has no email address');

    await createEvent({
      summary: 'Schedule Session',
      description: objective,
      date,
      timeZone,
      attendees: [{ email }],
    });
    return res.send('success');
  })
);

export default handler;
