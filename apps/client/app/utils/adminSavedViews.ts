import { z } from 'zod';
import {
  ADMIN_USERS_PAGE_SIZES,
  ADMIN_USERS_SORT_FIELDS,
  AdminUsersFilterFieldsSchema,
  refineAdminUsersFilter,
} from './adminUsersFilter';

/**
 * The admin saved views contract, shared by the admin lists and /api/admin/saved-views. Pure and
 * React-free: the server imports it.
 */

/** Must stay in sync with ADMIN_SAVED_VIEW_SURFACES in packages/database AdminSavedViewModel.ts. */
export const ADMIN_SAVED_VIEW_SURFACES = ['users'] as const;
export const AdminSavedViewSurfaceSchema = z.enum(ADMIN_SAVED_VIEW_SURFACES);
export type AdminSavedViewSurface = z.infer<typeof AdminSavedViewSurfaceSchema>;

export const ADMIN_SAVED_VIEW_NAME_MAX_LENGTH = 60;
/** Per admin per surface; creating one more answers 400. */
export const ADMIN_SAVED_VIEWS_PER_ADMIN_MAX = 50;
/** The list endpoint's bound on other admins' shared views; an admin's own views are bounded by PER_ADMIN_MAX. */
export const ADMIN_SAVED_VIEWS_SHARED_LIST_LIMIT = 50;

export const AdminSavedViewNameSchema = z.string().trim().min(1, 'Name the view').max(ADMIN_SAVED_VIEW_NAME_MAX_LENGTH);

/**
 * What a users-list view persists: the filters (free-text search included), sort, page size and
 * grouping. The page is deliberately left out so a view always opens on page 1.
 */
export const UsersSavedViewParamsSchema = AdminUsersFilterFieldsSchema.extend({
  sortField: z.enum(ADMIN_USERS_SORT_FIELDS),
  sortOrder: z.enum(['asc', 'desc']),
  limit: z
    .number()
    .int()
    .refine(value => (ADMIN_USERS_PAGE_SIZES as readonly number[]).includes(value)),
  groupBy: z.enum(['emailDomain']).optional(),
}).superRefine(refineAdminUsersFilter);
export type UsersSavedViewParams = z.infer<typeof UsersSavedViewParamsSchema>;

/** The stored view envelope. A new shape gets a new version, and readers skip versions they do not know. */
export const UsersSavedViewSchema = z.object({ version: z.literal(1), params: UsersSavedViewParamsSchema });
export type UsersSavedView = z.infer<typeof UsersSavedViewSchema>;

const SAVED_VIEW_SCHEMAS = { users: UsersSavedViewSchema } as const satisfies Record<AdminSavedViewSurface, z.ZodType>;

export type AdminSavedViewPayload<S extends AdminSavedViewSurface = AdminSavedViewSurface> = z.infer<
  (typeof SAVED_VIEW_SCHEMAS)[S]
>;

export type ParsedSavedView<S extends AdminSavedViewSurface> =
  { ok: true; view: AdminSavedViewPayload<S> } | { ok: false; reason: 'unknown-version' | 'invalid'; version: unknown };

/**
 * Reads a stored view for `surface`. Never throws: a view written by a newer version, or one that
 * no longer validates, comes back as `ok: false` for the caller to skip and log.
 */
export function parseSavedView<S extends AdminSavedViewSurface>(surface: S, stored: unknown): ParsedSavedView<S> {
  const version = typeof stored === 'object' && stored !== null ? (stored as { version?: unknown }).version : undefined;
  if (version !== 1) return { ok: false, reason: 'unknown-version', version };
  const parsed = SAVED_VIEW_SCHEMAS[surface].safeParse(stored);
  return parsed.success
    ? { ok: true, view: parsed.data as AdminSavedViewPayload<S> }
    : { ok: false, reason: 'invalid', version };
}

export const ListAdminSavedViewsQuerySchema = z.object({ surface: AdminSavedViewSurfaceSchema });

export const CreateAdminSavedViewRequestSchema = z.discriminatedUnion('surface', [
  z.object({
    surface: z.literal('users'),
    name: AdminSavedViewNameSchema,
    shared: z.boolean().default(false),
    view: UsersSavedViewSchema,
  }),
]);
export type CreateAdminSavedViewRequest = z.input<typeof CreateAdminSavedViewRequestSchema>;

/** `view` is checked against the stored view's own surface by the handler. */
export const UpdateAdminSavedViewRequestSchema = z
  .object({
    name: AdminSavedViewNameSchema.optional(),
    shared: z.boolean().optional(),
    view: z.unknown().optional(),
  })
  .strict()
  .refine(patch => Object.values(patch).some(value => value !== undefined), { message: 'Nothing to update' });
export type UpdateAdminSavedViewRequest = z.input<typeof UpdateAdminSavedViewRequestSchema>;

export type AdminSavedViewResponse<S extends AdminSavedViewSurface = AdminSavedViewSurface> = {
  id: string;
  surface: S;
  name: string;
  shared: boolean;
  ownerId: string;
  /** Only the owner may rename, share, unshare or delete. */
  isOwner: boolean;
  view: AdminSavedViewPayload<S>;
};

export type AdminSavedViewsListResponse<S extends AdminSavedViewSurface = AdminSavedViewSurface> = {
  views: AdminSavedViewResponse<S>[];
};
