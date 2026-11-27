import { z } from 'zod';
import { OAUTH_SOURCE_TAG_PREFIX, isOAuthSourceTag } from './constants/oauthClients';
import { AdminModelFilterSchema } from './schemas/adminModels';
import { AdminActionReasonSchema } from './types/entities/adminActionReason';

/**
 * Wire contract for the admin model access endpoints (apps/client/pages/api/admin/models/access*):
 * per-model PATCH, bulk dry run / apply / undo, and the access revision header.
 */

/** Response header on GET /api/admin/llm-models/configurations carrying the modelAccessRevision setting. */
export const MODEL_ACCESS_REVISION_HEADER = 'x-model-access-revision';

/** Upper bound on the models one bulk selection covers, whether named by `{ ids }` or matched by `{ filter }`. */
export const MODEL_ACCESS_BULK_MAX_IDS = 500;

/** One llmModelConfigurations entry as the access endpoints return it. */
export type ModelAccessEntry = {
  id: string;
  enabled: boolean;
  allowedUserTags: string[];
  allowedEntitlements: string[];
  fallbackModel?: string;
  rank?: number;
  /** ISO time of the entry's last write; null for an entry stored before per-entry stamps. Send it back as `expectedUpdatedAt`. */
  updatedAt: string | null;
};

const ModelIdSchema = z.string().trim().min(1).max(512);

const accessKeySchema = (label: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(128)
    .refine(
      value => !isOAuthSourceTag(value),
      `${label} cannot use the self-assignable "${OAUTH_SOURCE_TAG_PREFIX}" namespace`
    );

const UserTagsSchema = z.array(accessKeySchema('User tags')).max(100);
const EntitlementsSchema = z.array(accessKeySchema('Entitlements')).max(100);

const StampSchema = z
  .string()
  .refine(value => !Number.isNaN(Date.parse(value)), 'expectedUpdatedAt must be an ISO date or null');

/** Fields a per-model PATCH may set. `fallbackModel: ''` or null clears it; `rank: null` clears it. */
export const ModelAccessChangeSchema = z
  .object({
    enabled: z.boolean().optional(),
    allowedUserTags: UserTagsSchema.optional(),
    allowedEntitlements: EntitlementsSchema.optional(),
    fallbackModel: z.union([ModelIdSchema, z.literal(''), z.null()]).optional(),
    rank: z.number().int().min(0).max(100).nullable().optional(),
  })
  .strict()
  .refine(change => Object.values(change).some(value => value !== undefined), 'Change at least one field');
export type ModelAccessChange = z.infer<typeof ModelAccessChangeSchema>;

export const ModelAccessPatchRequestSchema = z
  .object({
    change: ModelAccessChangeSchema,
    reason: AdminActionReasonSchema,
    /** The entry's `updatedAt` as read, or null when the model had no entry (or an unstamped one). */
    expectedUpdatedAt: StampSchema.nullable(),
    /** Required when the write leaves an enabled model with no tags and no entitlements (admins only). */
    confirmAdminOnly: z.boolean().optional(),
  })
  .strict();
export type ModelAccessPatchRequest = z.infer<typeof ModelAccessPatchRequestSchema>;

/** Atomic compatibility Save for the current dashboard; unversioned whole-array writes are refused. */
export const ModelAccessSaveRequestSchema = z
  .object({
    changes: z
      .array(
        z
          .object({
            id: ModelIdSchema,
            change: ModelAccessChangeSchema,
            expectedUpdatedAt: StampSchema.nullable(),
          })
          .strict()
      )
      .max(MODEL_ACCESS_BULK_MAX_IDS)
      .refine(changes => new Set(changes.map(change => change.id)).size === changes.length, 'Model ids must be unique'),
    reason: AdminActionReasonSchema,
    confirmAdminOnly: z.boolean().optional(),
  })
  .strict();
export type ModelAccessSaveRequest = z.infer<typeof ModelAccessSaveRequestSchema>;
export type ModelAccessSaveResult = {
  entries: { id: string; entry: ModelAccessEntry | null }[];
  changed: number;
  revision: string | null;
};

export type ModelAccessPatchResult = {
  entry: ModelAccessEntry | null;
  /** False when the change matched the stored access; nothing was written, audited or bumped. */
  changed: boolean;
  /** The new modelAccessRevision, or null when nothing was written or the bump failed. */
  revision: string | null;
};

const TagListSchema = UserTagsSchema.min(1).max(20);
const EntitlementListSchema = EntitlementsSchema.min(1).max(20);

/** One change applied to every selected model. */
export const ModelAccessBulkChangeSchema = z.union([
  z.object({ enabled: z.boolean() }).strict(),
  z.object({ addTags: TagListSchema, alsoRemoveBase: z.boolean().optional() }).strict(),
  z.object({ removeTags: TagListSchema, alsoRestoreBase: z.boolean().optional() }).strict(),
  z.object({ addEntitlements: EntitlementListSchema }).strict(),
  z.object({ removeEntitlements: EntitlementListSchema }).strict(),
]);
export type ModelAccessBulkChange = z.infer<typeof ModelAccessBulkChangeSchema>;

/**
 * Explicit ids, or the model list's filter (GET /api/admin/models) resolved server-side to the ids it lists. A
 * filter matching no models or more than MODEL_ACCESS_BULK_MAX_IDS is a 422.
 */
export const ModelAccessSelectionSchema = z.union([
  z.object({ ids: z.array(ModelIdSchema).min(1).max(MODEL_ACCESS_BULK_MAX_IDS) }).strict(),
  z.object({ filter: AdminModelFilterSchema }).strict(),
]);
export type ModelAccessSelection = z.infer<typeof ModelAccessSelectionSchema>;

/**
 * Without `dryRunToken` the call is a dry run. With it, the call applies the change the token was
 * minted for (reason required). With `undoToken` (from an apply response) it reverts that batch.
 */
export const ModelAccessBulkRequestSchema = z.union([
  z
    .object({
      selection: ModelAccessSelectionSchema,
      change: ModelAccessBulkChangeSchema,
      reason: AdminActionReasonSchema.optional(),
      dryRunToken: z.string().min(1).optional(),
      confirmAdminOnly: z.boolean().optional(),
    })
    .strict(),
  z.object({ undoToken: z.string().min(1), reason: AdminActionReasonSchema }).strict(),
]);
export type ModelAccessBulkRequest = z.infer<typeof ModelAccessBulkRequestSchema>;
/** What a client sends: a `{ filter }` may leave out the fields AdminModelFilterSchema defaults. */
export type ModelAccessBulkRequestInput = z.input<typeof ModelAccessBulkRequestSchema>;

/**
 * Who can pick the model after the change compared with before: `none` when the audience is the same
 * (a tag added to a model every user reaches through `base`), `mixed` when some gain and some lose.
 */
export type ModelAccessAudienceEffect = 'none' | 'wider' | 'narrower' | 'mixed';

export type ModelAccessBulkItem = {
  id: string;
  /** Null when the model has no entry; it then behaves as enabled for everyone through `base`. */
  before: ModelAccessEntry | null;
  after: Omit<ModelAccessEntry, 'updatedAt'>;
  changes: boolean;
  audience: ModelAccessAudienceEffect;
  /** After the change every signed-in user still reaches the model through `base`. */
  everyoneThroughBase: boolean;
  /** After the change the model is enabled with no tags and no entitlements: only admins see it. */
  adminOnly: boolean;
};

export type ModelAccessBulkDryRun = {
  ids: string[];
  items: ModelAccessBulkItem[];
  counts: { selected: number; change: number; unchanged: number; noAudienceChange: number; adminOnly: number };
  adminOnlyIds: string[];
  /** Pass back as `dryRunToken` with the same selection and change to apply. */
  token: string;
  expiresAt: string;
};

export type ModelAccessBulkFailure = 'stamp-moved' | 'write-error';

export type ModelAccessBulkResult = {
  batchId: string;
  results: {
    id: string;
    outcome: 'updated' | 'unchanged' | 'failed';
    reason?: ModelAccessBulkFailure;
    entry?: ModelAccessEntry | null;
  }[];
  counts: { selected: number; updated: number; unchanged: number; failed: number };
  /** "Updated 37 of 40. 3 failed" */
  summary: string;
  /** Reverts this batch's updated entries in one call; null when nothing was updated. */
  undoToken: string | null;
  revision: string | null;
};

/** A 409 from the bulk endpoint carries the dry run recomputed against current state. */
export type ModelAccessBulkConflict = { error: string; dryRun: ModelAccessBulkDryRun };

/** The `code` on the bulk endpoint's 409 for an undo token past its expiry; any other 409 there is not this. */
export const MODEL_ACCESS_UNDO_EXPIRED_CODE = 'undo-expired';

export type ModelUserTagCount = { tag: string; count: number };
