import * as z from 'zod';
import { selfUserResponseSchema } from '@bike4mind/common';

/**
 * Response contract shared by every endpoint that returns the caller's own session view
 * (identify, refreshToken, returnToAdmin, loginAs). The client's currentUser is fed from
 * `user`, so all of them must serialize it through the same self-view schema. identify is a
 * read-only whoami: it echoes the presented bearer and never mints one, so `accessToken` is
 * absent for an API-key caller there.
 */
export const selfSessionResponseSchema = z.object({
  user: selfUserResponseSchema,
  accessToken: z.string().optional(),
  impersonating: z.boolean(),
});
