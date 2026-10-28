import { z } from 'zod';
import { PaginationQuerySchema, paginatedResponseSchema } from './pagination';
import type { ApiErrorCode } from '../apiErrorCodes';

/**
 * Wire schemas for the public Skill Market authoring contracts
 * (api-contract/contracts/skillMarketWrite.contract.ts). An explicit snake_case allowlist over
 * ISkillListing / ISkillListingVersion: a field added to the models does not reach the public
 * surface until it is added here. The server mapper is apps/client/server/skillMarket/publicView.ts.
 *
 * Imported directly (never through the schemas barrel) by the contract and OpenAPI layers, so keep
 * this file free of `@bike4mind/*` imports - the CI spec job loads it without building anything.
 */

const ISO = 'ISO 8601 timestamp.';
const PRIVILEGED = 'Present only for the listing author.';

export const SkillListingVisibilitySchema = z.enum(['public', 'organization', 'unlisted']);

export const PublicSkillFileSchema = z.object({ path: z.string(), content: z.string() });

export const PublicSkillSnapshotSchema = z.object({
  name: z.string(),
  description: z.string(),
  body: z
    .string()
    .optional()
    .describe('The SKILL.md body. Omitted from marketplace list responses; included in the review queue.'),
  argument_hint: z.string().nullable(),
  allowed_tools: z.array(z.string()),
  claude_code_allowed_tools: z.array(z.string()).describe('Tools pre-approved when the skill runs in Claude Code.'),
  disable_model_invocation: z.boolean(),
  files: z
    .array(PublicSkillFileSchema)
    .optional()
    .describe(
      'Supporting files under scripts/ or references/, sorted by path. Present whenever `body` is, except on a review-queue `previous` version.'
    ),
});

export const PublicSkillHonestSummarySchema = z.object({
  what_it_does: z.string(),
  tools_used: z.array(z.string()),
  data_it_touches: z.string(),
  risk_notes: z.array(z.string()),
  description_matches: z.boolean(),
  mismatch_note: z.string().nullable(),
});

export const PublicSkillScanFindingSchema = z.object({
  rule: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  message: z.string(),
  excerpt: z.string().nullable(),
  source: z.enum(['rules', 'classifier']),
});

export const PublicSkillListingVersionSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  snapshot: PublicSkillSnapshotSchema,
  risk_tier: z.enum(['clean', 'review', 'high']).nullable(),
  honest_summary: PublicSkillHonestSummarySchema.nullable().describe(
    'Generated from the skill body, not its description.'
  ),
  scan_status: z.enum(['scanning', 'passed', 'failed', 'error']).optional().describe(PRIVILEGED),
  scan_findings: z.array(PublicSkillScanFindingSchema).optional().describe(PRIVILEGED),
  review_status: z
    .enum(['not_required', 'pending', 'auto_approved', 'approved', 'rejected', 'superseded'])
    .optional()
    .describe(PRIVILEGED),
  review_note: z.string().nullable().optional().describe(PRIVILEGED),
  created_at: z.string().describe(ISO),
});
export type PublicSkillListingVersion = z.infer<typeof PublicSkillListingVersionSchema>;

export const PublicSkillListingSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  visibility: SkillListingVisibilitySchema,
  organization_id: z.string().nullable(),
  tags: z.array(z.string()),
  status: z.enum(['in_review', 'approved', 'rejected', 'delisted', 'withdrawn']),
  author_name: z.string().nullable(),
  current_version: z.number().int().nullable().describe('The approved version importers receive.'),
  risk_tier: z.enum(['clean', 'review', 'high']).nullable(),
  uses_tools: z.boolean(),
  auto_checked: z.boolean().describe('Whether the live version was approved without a human reviewer.'),
  import_count: z.number().int(),
  rating_avg: z.number(),
  rating_count: z.number().int(),
  published_at: z.string().nullable().describe(ISO),
  created_at: z.string().describe(ISO),
  updated_at: z.string().describe(ISO),
  source_skill_id: z.string().optional().describe(`The skill the listing was published from. ${PRIVILEGED}`),
  share_token: z.string().optional().describe(`Unlocks an unlisted listing. ${PRIVILEGED}`),
  latest_version: z.number().int().optional().describe(`The newest submitted version. ${PRIVILEGED}`),
  pending_version: z.number().int().nullable().optional().describe(`A version awaiting review. ${PRIVILEGED}`),
});
export type PublicSkillListing = z.infer<typeof PublicSkillListingSchema>;

/** `id` is a plain string so a malformed id answers 404, not 422 (CONVENTIONS.md status table). */
export const SkillListingIdParamSchema = z.object({ id: z.string().min(1) });
export const SkillVersionIdParamSchema = z.object({ vid: z.string().min(1) });

/** Body of publish and new-version: the listing as the author sees it, and the scanned version. */
export const SkillMarketSubmitResponseSchema = z.object({
  listing: PublicSkillListingSchema,
  version: PublicSkillListingVersionSchema,
});
export type SkillMarketSubmitResponse = z.infer<typeof SkillMarketSubmitResponseSchema>;

export const RescanSkillVersionResponseSchema = z.object({ version: PublicSkillListingVersionSchema });

const tagsField = z.array(z.string()).describe('Up to 5 tags: 1-24 lowercase letters, digits or hyphens.');

/** Strict, so a camelCase field (the SPA route's spelling) is a 422 rather than silently dropped. */
export const PublishSkillListingRequestSchema = z
  .object({
    skill_id: z.string().min(1).describe('A skill you own. Imported skills cannot be republished.'),
    visibility: SkillListingVisibilitySchema,
    organization_id: z
      .string()
      .min(1)
      .optional()
      .describe('Required for `organization` visibility, unless you belong to exactly one organization.'),
    tags: tagsField.optional(),
  })
  .strict();
export type PublishSkillListingRequest = z.infer<typeof PublishSkillListingRequestSchema>;

// A bodiless POST reaches Next as '' (no content-type -> text/plain), so '' is folded into "absent"
// before the default applies; same as SessionCloneRequestSchema.
const emptyBodyAsAbsent = (body: unknown) => (body === '' ? undefined : body);

export const SubmitSkillListingVersionRequestSchema = z.preprocess(
  emptyBodyAsAbsent,
  z
    .object({ tags: tagsField.optional().describe('Replaces the listing tags once the version is accepted.') })
    .strict()
    .default({})
);
export type SubmitSkillListingVersionRequest = z.infer<typeof SubmitSkillListingVersionRequestSchema>;

export const ImportSkillListingRequestSchema = z.preprocess(
  emptyBodyAsAbsent,
  z
    .object({
      token: z.string().max(64).optional().describe("An unlisted listing's share token."),
      name: z.string().optional().describe("A name for the copy, when the listing's name collides with one of yours."),
      target_skill_id: z.string().optional().describe('Update this earlier imported copy in place instead.'),
      overwrite: z.boolean().optional().describe('Confirms overwriting a copy you edited since importing it.'),
      expected_version_id: z
        .string()
        .max(64)
        .optional()
        .describe('The version you reviewed; a 409 if a newer one was approved since.'),
    })
    .strict()
    .default({})
);
export type ImportSkillListingRequest = z.infer<typeof ImportSkillListingRequestSchema>;

/** The `errorCode` of an import 409; the SPA route sends the same values as `code`. */
export const SKILL_MARKET_IMPORT_ERROR_CODES = [
  'version_changed',
  'local_changes',
  'name_taken',
] as const satisfies readonly ApiErrorCode[];

export const ImportSkillListingResponseSchema = z.object({
  skill: z.object({ id: z.string(), name: z.string() }),
});

export const BrowseSkillListingsQuerySchema = PaginationQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(50).default(24),
  q: z.string().max(200).optional().describe('Full-text search over name, description and summary.'),
  scope: z.enum(['public', 'org']).optional(),
  tags: z.string().optional().describe('Comma-separated; matches listings carrying any of the first 5.'),
  tools: z.enum(['with', 'without']).optional(),
  min_rating: z.coerce.number().min(0).max(5).optional(),
  sort: z
    .enum(['relevance', 'top', 'imports', 'new', 'updated'])
    .optional()
    .describe('Defaults to `relevance` with `q`, else `top`.'),
});
export type BrowseSkillListingsQuery = z.infer<typeof BrowseSkillListingsQuerySchema>;

export const BrowseSkillListingsResponseSchema = paginatedResponseSchema(PublicSkillListingSchema);

export const MySkillListingsQuerySchema = PaginationQuerySchema.extend({
  source_skill_id: z.string().min(1).optional().describe('Only the listing published from this skill.'),
});
export type MySkillListingsQuery = z.infer<typeof MySkillListingsQuerySchema>;

export const MySkillListingSchema = PublicSkillListingSchema.extend({
  versions: z
    .array(PublicSkillListingVersionSchema)
    .describe('The 5 newest versions, newest first, without snapshot bodies.'),
});
export const MySkillListingsResponseSchema = paginatedResponseSchema(MySkillListingSchema);

export const SkillListingDetailQuerySchema = z.object({
  token: z.string().max(64).optional().describe("An unlisted listing's share token."),
});

export const SkillListingDetailSchema = z.object({
  listing: PublicSkillListingSchema,
  version: PublicSkillListingVersionSchema.nullable().describe('The current approved version, if any.'),
  ratings: z.array(
    z.object({
      stars: z.number().int(),
      review: z.string().nullable(),
      rated_at: z.string().nullable().describe(ISO),
      mine: z.boolean(),
    })
  ),
  my_import: z
    .object({
      version: z.number().int(),
      stars: z.number().int().nullable(),
      review: z.string().nullable(),
      skill: z
        .object({ id: z.string(), name: z.string() })
        .nullable()
        .describe('Your imported copy, while it still exists.'),
    })
    .nullable(),
});
export type SkillListingDetail = z.infer<typeof SkillListingDetailSchema>;

// Review (api-contract/contracts/skillMarketReview.contract.ts). The reviewer sees the privileged
// version and listing shapes, so `PRIVILEGED` fields above are always present here.

export const ReviewSkillVersionRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('approve'),
      ack_high_risk: z.boolean().optional().describe('Required to approve a version whose `risk_tier` is `high`.'),
      ack_mismatch: z
        .boolean()
        .optional()
        .describe(
          'Required when `honest_summary.description_matches` is false: the description understates the skill.'
        ),
      note: z.string().trim().max(2000).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('reject'),
      note: z.string().trim().min(1, 'A note is required to reject').max(2000).describe('Shown to the author.'),
    })
    .strict(),
]);
export type ReviewSkillVersionRequest = z.infer<typeof ReviewSkillVersionRequestSchema>;

export const ReviewSkillVersionResponseSchema = z.object({ version: PublicSkillListingVersionSchema });

export const ReviewQueueItemSchema = z.object({
  version: PublicSkillListingVersionSchema,
  listing: PublicSkillListingSchema,
  previous: z
    .object({ id: z.string(), version: z.number().int(), snapshot: PublicSkillSnapshotSchema })
    .nullable()
    .describe('The approved version this one would replace, for a diff.'),
  can_decide: z.boolean(),
});

export const ReviewQueueQuerySchema = PaginationQuerySchema;
export const ReviewQueueResponseSchema = paginatedResponseSchema(ReviewQueueItemSchema);
