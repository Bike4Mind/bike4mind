import { z } from 'zod';

export const objectIdString = z.string().regex(/^[a-f0-9]{24}$/i, 'must be a 24-character hex ObjectId');

// Models often fill the unused optional field with null or "" instead of omitting it.
const optionalRef = <T extends z.ZodType<string>>(schema: T) => schema.or(z.literal('')).nullish();

/** A ref field counts as provided only when it is a non-empty string. */
export const presentRef = (value: string | null | undefined): string | undefined =>
  value === undefined || value === null || value === '' ? undefined : value;

/**
 * Unrefined so tools can extend it (`AdminUserRefFields.extend({ days: ... })`); zod v4 does not
 * allow extending a refined object. Apply `withExactlyOneUserRef` to the extended schema.
 */
export const AdminUserRefFields = z.object({
  userId: optionalRef(objectIdString).describe(
    'The user id (24-character hex ObjectId). Provide exactly one of userId or email.'
  ),
  email: optionalRef(z.string().email().max(320)).describe(
    'The user email address. Provide exactly one of userId or email.'
  ),
});

type UserRefInput = { userId?: string | null; email?: string | null };

export const withExactlyOneUserRef = <S extends z.ZodType<UserRefInput>>(schema: S) =>
  schema.refine(ref => (presentRef(ref.userId) === undefined) !== (presentRef(ref.email) === undefined), {
    message: 'Provide exactly one of userId or email',
  });

export const AdminUserRefSchema = withExactlyOneUserRef(AdminUserRefFields);

export type AdminUserRef = UserRefInput;
