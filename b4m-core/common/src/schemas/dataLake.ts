import z from 'zod';
import { DATALAKE_TAG_PREFIX, hasBlankTagPrefixSegment, isReservedTagPrefix } from '../constants/dataLakes';

// Slug validation

const slugRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const sha256Regex = /^[a-f0-9]{64}$/;

// Data Lake CRUD

export const CreateDataLakeRequestInput = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(2)
    .max(60)
    .regex(slugRegex, 'Slug must be lowercase alphanumeric with hyphens (e.g. "my-data-lake")'),
  description: z.string().max(2000).optional(),
  fileTagPrefix: z
    .string()
    .min(2)
    .max(30)
    .refine(s => s.endsWith(':'), 'Tag prefix must end with ":" (e.g. "acme:")')
    // A prefix with a blank segment ("::", "a::", ":a:", "a: :", or zero-width characters)
    // gives every derived tag a blank tree segment, which the tag-tree UIs can only paper
    // over (empty node labels, orphaned back rows). Reject it at the source; the wizard
    // mirrors this via tagPrefixIssue / hasBlankTagPrefixSegment so the rules cannot drift.
    .refine(s => !hasBlankTagPrefixSegment(s), 'Tag prefix segments must be non-empty (e.g. "acme:" or "acme:legal:")')
    .refine(s => !isReservedTagPrefix(s), `Tag prefix cannot use the reserved "${DATALAKE_TAG_PREFIX}" namespace`),
  requiredUserTag: z.string().min(1).max(100).optional(),
  // Entitlement keys are namespaced (must contain ":") so a bare user-tag value can never
  // be a requiredEntitlement - tags pass through 1:1 as entitlement keys, so an un-namespaced
  // value would be self-grantable. Stored normalized (lowercase) by the service.
  requiredEntitlement: z
    .string()
    .min(3)
    .max(100)
    .refine(
      s => s.includes(':') && s.split(':').every(part => part.length > 0),
      'Entitlement key must be namespaced with non-empty parts (e.g. "product:pro")'
    )
    .optional(),
  // The caller's active account-switcher org, if any. It is NOT trusted as-is: the route
  // authorization-validates it against the caller's org memberships (see resolveActiveOrg)
  // before scoping the lake, so a user still can't plant a lake into an org they don't
  // belong to. Omitted (or empty) means personal scope.
  organizationId: z.string().optional(),
});
export type CreateDataLakeRequestInputType = z.infer<typeof CreateDataLakeRequestInput>;

export const UpdateDataLakeRequestInput = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  // Per-lake system prompt (see IDataLake.systemPrompt). Uncapped, matching the other system
  // prompts in the codebase. Edit is gated to creator/admin by updateDataLake (canManageLake).
  systemPrompt: z.string().optional(),
  // Empty string is the explicit "remove this gate" sentinel, accepted on UPDATE only (a
  // create has no gate to clear). It is stored as-is rather than unset: every read path
  // already treats '' as ungated - the access queries in DataLakeModel carry explicit
  // `requiredUserTag: ''` arms, and lakeMatchesAccess/canAccessLake test truthiness.
  // Omitting the field still means "leave unchanged" (Mongo $set strips undefined).
  requiredUserTag: z.union([z.literal(''), z.string().min(1).max(100)]).optional(),
  requiredEntitlement: z
    .union([
      z.literal(''),
      z
        .string()
        .min(3)
        .max(100)
        .refine(
          s => s.includes(':') && s.split(':').every(part => part.length > 0),
          'Entitlement key must be namespaced with non-empty parts (e.g. "product:pro")'
        ),
    ])
    .optional(),
  // NOTE: status is intentionally NOT updatable here. Lifecycle transitions
  // (archive/unarchive/delete/cleanup) go through their dedicated endpoints so the
  // required side effects (cancel in-flight batch, archive/soft-delete files, stat
  // recompute, best-effort index removal) always run.
});
export type UpdateDataLakeRequestInputType = z.infer<typeof UpdateDataLakeRequestInput>;

export const DataLakeListRequestInput = z.object({
  organizationId: z.string().optional(),
  status: z.enum(['draft', 'active', 'archived', 'deleted']).optional(),
});
export type DataLakeListRequestInputType = z.infer<typeof DataLakeListRequestInput>;

// Conflict resolution (per-batch dedup policy)

export const ConflictResolutionSchema = z.enum(['skip', 'update', 'duplicate']);
export type ConflictResolutionType = z.infer<typeof ConflictResolutionSchema>;

// Batch creation

export const CreateBatchRequestInput = z.object({
  dataLakeId: z.string(),
  totalFiles: z.number().positive(),
  totalSizeBytes: z.number().nonnegative(),
  conflictResolution: ConflictResolutionSchema.optional(),
  appliedTags: z.array(z.object({ name: z.string(), strength: z.number() })).optional(),
  /** Opt-in for background AI tag suggestion - never true in append mode. */
  wantsTaxonomy: z.boolean().optional(),
});
export type CreateBatchRequestInputType = z.infer<typeof CreateBatchRequestInput>;

// Batch Presigned URLs

export const BatchPresignedUrlFileItem = z.object({
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  fileSize: z.number().positive(),
  contentHash: z.string().regex(sha256Regex).optional(),
  tags: z
    .array(
      z.object({
        name: z.string().min(1),
        strength: z.number().min(0).max(1),
      })
    )
    .optional(),
  relativePath: z.string().optional(),
});

export const BatchPresignedUrlRequestInput = z.object({
  files: z.array(BatchPresignedUrlFileItem).min(1).max(100),
  /**
   * The lake to upload into, as an id or a slug (`assertLakeWriteAccess` resolves either).
   * Send the id: a slug the client derived from the lake's name resolves to whichever lake
   * holds it, which after the server disambiguates a collision is not the new lake.
   */
  dataLakeSlug: z.string().optional(),
  /**
   * When uploading into a data lake batch, the batch id so each created FabFile is
   * correlated to the batch (stamped with batchId) AND appended to the batch
   * manifest. Without it the pipeline can't track batch progress.
   */
  batchId: z.string().optional(),
});
export type BatchPresignedUrlRequestInputType = z.infer<typeof BatchPresignedUrlRequestInput>;

// AI Taxonomy Application - the background job's inference call itself has no HTTP
// request shape (triggered by the queue handler, not the client); these cover the review
// panel's two actions against an already-analyzed batch.

// Bounds are generous relative to real values (inference aims for 5-20 short hierarchical
// tags like "type:contract") - they exist to cap worst-case request size/storage/CPU from a
// crafted body, not to constrain legitimate use. applyTaxonomySuggestions also cross-checks
// each originalName against the batch's actual stored suggestions, so these bounds are a
// second, independent layer rather than the only protection.
const TaxonomyTagInput = z.object({
  suffix: z.string().min(1).max(100),
  originalName: z.string().min(1).max(150),
  strength: z.number().min(0).max(1),
  source: z.enum(['folder', 'ai']),
  matchingFolders: z.array(z.string().max(512)).max(100),
  deleted: z.boolean(),
});

export const ApplyTaxonomyRequestInput = z.object({
  /** The reviewed/edited tag list to apply (already filtered to non-deleted by the caller, or
   * filtered here - deleted entries are simply skipped since they carry no tag to write). */
  tags: z.array(TaxonomyTagInput).max(100),
});
export type ApplyTaxonomyRequestInputType = z.infer<typeof ApplyTaxonomyRequestInput>;

export const ReanalyzeTaxonomyRequestInput = z.object({
  /** User description of the data (helps the AI) */
  context: z.string().max(2000).optional(),
});
export type ReanalyzeTaxonomyRequestInputType = z.infer<typeof ReanalyzeTaxonomyRequestInput>;

// Deduplication

export const CheckDuplicatesRequestInput = z.object({
  hashes: z.array(z.string().regex(sha256Regex)).min(1).max(500),
});
export type CheckDuplicatesRequestInputType = z.infer<typeof CheckDuplicatesRequestInput>;

// Incremental Sync

export const SyncDeltaFileEntry = z.object({
  relativePath: z.string(),
  fileName: z.string(),
  contentHash: z.string().regex(sha256Regex),
  fileSize: z.number(),
});

export const ComputeSyncDeltaRequestInput = z.object({
  dataLakeSlug: z.string(),
  currentFiles: z.array(SyncDeltaFileEntry).min(1).max(10000),
  /** Per-request dedup policy for files whose content hash already exists. Defaults to 'skip'. */
  conflictResolution: ConflictResolutionSchema.optional(),
});
export type ComputeSyncDeltaRequestInputType = z.infer<typeof ComputeSyncDeltaRequestInput>;

export const ApplySyncRequestInput = z.object({
  dataLakeSlug: z.string(),
  actions: z.object({
    upload: z.array(
      z.object({
        relativePath: z.string(),
        fileName: z.string(),
        contentHash: z.string().regex(sha256Regex),
      })
    ),
    update: z.array(
      z.object({
        existingFileId: z.string(),
        relativePath: z.string(),
        fileName: z.string(),
        contentHash: z.string().regex(sha256Regex),
      })
    ),
    remove: z.array(z.string()),
    skip: z.array(z.string()),
  }),
});
export type ApplySyncRequestInputType = z.infer<typeof ApplySyncRequestInput>;
