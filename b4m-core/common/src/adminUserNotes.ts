import { z } from 'zod';

export const ADMIN_NOTE_MAX_LENGTH = 2000;
export const AdminNoteBodySchema = z.string().trim().min(1).max(ADMIN_NOTE_MAX_LENGTH);
export const AdminNoteIdSchema = z
  .string()
  .regex(/^[0-9a-f]{24}$/i)
  .transform(id => id.toLowerCase());
export const AdminNoteVersionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const AdminNoteCreateSchema = z.object({ body: AdminNoteBodySchema }).strict();
export const AdminNoteChangeSchema = z
  .object({
    noteId: AdminNoteIdSchema,
    version: AdminNoteVersionSchema,
    body: AdminNoteBodySchema.optional(),
    deleted: z.boolean().optional(),
  })
  .strict()
  .refine(value => (value.body !== undefined) !== (value.deleted !== undefined), 'Choose one note action');
export const AdminNotePageQuerySchema = z
  .object({
    userId: AdminNoteIdSchema,
    noteId: AdminNoteIdSchema.optional(),
    cursor: AdminNoteIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  })
  .strict();

export type AdminUserNote = {
  id: string;
  author: { id: string; name: string };
  createdAt: string;
  updatedAt: string;
  body: string;
  version: number;
  deleted: boolean;
};
export type AdminUserNoteRevision = AdminUserNote & { editor: { id: string; name: string } };
export type AdminUserNotesPage = { entries: AdminUserNote[]; nextCursor: string | null };

export const AdminUserTagsSchema = z
  .array(z.string().trim().min(1).max(64))
  .max(100)
  .refine(tags => new Set(tags.map(tag => tag.toLowerCase())).size === tags.length, 'Tags must not repeat');
export const AdminUserTagsChangeSchema = z.object({ before: z.array(z.string()), tags: AdminUserTagsSchema }).strict();
