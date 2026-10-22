import * as z from 'zod';
import { passthroughShape } from './responseShape';

// Mirrors the `.select()` in pages/api/admin/users/email-verification.ts. The rows are lean
// documents, so the key is `_id` rather than `id`; the verification token is not selected and
// stays out of the response.
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

/** GET /api/admin/users/email-verification */
export const emailVerificationResponseSchema = z.object({
  users: z.array(z.object(passthroughShape(EMAIL_VERIFICATION_USER_RESPONSE_FIELDS))),
  pagination: z.object({
    page: z.number(),
    limit: z.number(),
    totalPages: z.number(),
    totalCount: z.number(),
  }),
});
