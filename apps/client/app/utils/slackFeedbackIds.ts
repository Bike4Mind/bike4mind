import { z } from 'zod';

export const slackFeedbackUserIdSchema = z.string().regex(/^[UW][A-Z0-9]+$/);
export const slackFeedbackChannelIdSchema = z.string().regex(/^[CG][A-Z0-9]+$/);
// Keep the existing configuration length requirement separate from incoming event syntax.
export const slackFeedbackConfiguredChannelIdSchema = slackFeedbackChannelIdSchema.min(9);
