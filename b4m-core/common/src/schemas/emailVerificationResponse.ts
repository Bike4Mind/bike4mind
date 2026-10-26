import * as z from 'zod';
import { passthroughShape } from './responseShape';

// pages/api/admin/users/email-verification.ts projects exactly these keys, so the query and the
// contract cannot drift. The rows are lean documents, so the key is `_id` rather than `id`; the
// verification token is not listed, so it is neither selected nor returned.
const EMAIL_VERIFICATION_USER_RESPONSE_FIELDS = {
  _id: true,
  username: true,
  email: true,
  name: true,
  emailVerified: true,
  emailVerifiedAt: true,
  emailVerificationSentAt: true,
  emailVerificationExpires: true,
  pendingEmail: true,
  pendingEmailSentAt: true,
  pendingEmailExpires: true,
  createdAt: true,
} as const;

export const emailVerificationUserResponseSchema = z.object(passthroughShape(EMAIL_VERIFICATION_USER_RESPONSE_FIELDS));

/** GET /api/admin/users/email-verification */
export const emailVerificationResponseSchema = z.object({
  users: z.array(emailVerificationUserResponseSchema),
  pagination: z.object({
    page: z.number(),
    limit: z.number(),
    totalPages: z.number(),
    totalCount: z.number(),
  }),
});
