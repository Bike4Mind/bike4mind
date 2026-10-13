import * as z from 'zod';
import { selfUserResponseSchema } from '@bike4mind/common';

/**
 * Response contract shared by every endpoint that hands the client a session for the
 * caller's own account (identify, refreshToken, returnToAdmin, loginAs). The client's
 * currentUser is fed from `user`, so all of them must serialize it through the same
 * self-view schema. `accessToken` is absent for an API-key caller on identify.
 */
export const selfSessionResponseSchema = z.object({
  user: selfUserResponseSchema,
  accessToken: z.string().optional(),
  impersonating: z.boolean(),
});
