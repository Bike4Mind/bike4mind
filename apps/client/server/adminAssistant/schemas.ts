import { z } from 'zod';

export const objectIdString = z.string().regex(/^[a-f0-9]{24}$/i, 'must be a 24-character hex ObjectId');

/**
 * Unrefined so tools can extend it (`AdminUserRefFields.extend({ days: ... })`); zod v4 does not
 * allow extending a refined object. Apply `withExactlyOneUserRef` to the extended schema.
 */
export const AdminUserRefFields = z.object({
  userId: objectIdString
    .optional()
    .describe('The user id (24-character hex ObjectId). Provide exactly one of userId or email; omit the other.'),
  email: z
    .string()
    .email()
    .max(320)
    .optional()
    .describe('The user email address. Provide exactly one of userId or email; omit the other.'),
});

type UserRefInput = { userId?: string; email?: string };

export const withExactlyOneUserRef = <S extends z.ZodType<UserRefInput>>(schema: S) =>
  schema.refine(ref => (ref.userId === undefined) !== (ref.email === undefined), {
    message: 'Provide exactly one of userId or email',
  });

export const AdminUserRefSchema = withExactlyOneUserRef(AdminUserRefFields);

export type AdminUserRef = UserRefInput;

export const AdminOrgRefFields = z.object({
  orgId: objectIdString
    .optional()
    .describe('The organization id (24-character hex ObjectId). Provide exactly one of orgId or name; omit the other.'),
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'The organization name, matched case-insensitively; a unique partial match also resolves. Provide exactly one of orgId or name; omit the other.'
    ),
});

type OrgRefInput = { orgId?: string; name?: string };

export const withExactlyOneOrgRef = <S extends z.ZodType<OrgRefInput>>(schema: S) =>
  schema.refine(ref => (ref.orgId === undefined) !== (ref.name === undefined), {
    message: 'Provide exactly one of orgId or name',
  });

export const AdminOrgRefSchema = withExactlyOneOrgRef(AdminOrgRefFields);

export type AdminOrgRef = OrgRefInput;
