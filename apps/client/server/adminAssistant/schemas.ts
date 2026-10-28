import { z } from 'zod';

export const objectIdString = z.string().regex(/^[a-f0-9]{24}$/i, 'must be a 24-character hex ObjectId');

/**
 * Unrefined so tools can extend it (`AdminUserRefFields.extend({ days: ... })`); zod v4 does not
 * allow extending a refined object. Apply `withExactlyOneUserRef` to the extended schema.
 */
export const AdminUserRefFields = z.object({
  userId: objectIdString.optional().describe('The user id (24-character hex ObjectId). Give this or email.'),
  email: z.string().email().max(320).optional().describe('The user email address. Give this or userId.'),
});

export const withExactlyOneUserRef = <S extends z.ZodType<{ userId?: string; email?: string }>>(schema: S) =>
  schema.refine(ref => (ref.userId === undefined) !== (ref.email === undefined), {
    message: 'Provide exactly one of userId or email',
  });

export const AdminUserRefSchema = withExactlyOneUserRef(AdminUserRefFields);

export type AdminUserRef = z.infer<typeof AdminUserRefSchema>;
