import { z } from 'zod';
import { PaginationQuerySchema, paginatedResponseSchema } from './pagination';
import { ArtifactTypeSchema } from '../types/entities/ArtifactTypes';

/**
 * Wire schemas for the public `/api/v1/artifacts` contracts (api-contract/contracts/artifacts.contract.ts).
 * Deliberately narrower than the Artifact document: sharing state (`permissions`), owner and org ids,
 * content pointers and hashes, free-form `metadata` and lineage refs are never published, so they stay
 * free to change without a breaking API change.
 *
 * Imported directly (never through the schemas barrel) by the contract and OpenAPI layers, so keep
 * this file free of `@bike4mind/*` imports - the CI spec job loads it without building anything.
 */

/**
 * Plain strings on purpose: a malformed id or version must answer 404 (CONVENTIONS.md status
 * table), and a path-param schema failure would answer 422.
 */
export const ArtifactIdParamSchema = z.object({
  id: z.string().min(1).max(200),
});

export const ArtifactVersionParamSchema = ArtifactIdParamSchema.extend({
  version: z.string().min(1).describe('A version number, starting at 1.'),
});

const ARTIFACT_VISIBILITIES = ['private', 'project', 'organization', 'public'] as const;
const ARTIFACT_STATUSES = ['draft', 'review', 'published', 'archived'] as const;

export const ArtifactResourceSchema = z.object({
  id: z.string(),
  type: ArtifactTypeSchema,
  title: z.string(),
  description: z.string().nullable(),
  version: z.number().int().describe('The current version. Starts at 1; each content change adds one.'),
  version_tag: z.string().nullable(),
  status: z.enum(ARTIFACT_STATUSES),
  tags: z.array(z.string()),
  session_id: z.string().nullable(),
  project_id: z.string().nullable(),
  visibility: z.enum(ARTIFACT_VISIBILITIES),
  created_at: z.string().describe('ISO 8601 timestamp.'),
  updated_at: z.string().describe('ISO 8601 timestamp.'),
  content: z
    .string()
    .nullable()
    .describe(
      "The current version's content. `null` in a list (fetch the artifact by id for it), and in an update " +
        'response to a caller who may edit the artifact but not read it, unless that update sent content.'
    ),
});
export type ArtifactResource = z.infer<typeof ArtifactResourceSchema>;

export const ArtifactVersionSchema = z.object({
  version: z.number().int(),
  version_tag: z.string().nullable(),
  change_description: z.string().nullable(),
  created_at: z.string().describe('ISO 8601 timestamp.'),
  content: z.string().nullable().describe("This version's content. `null` in a list; fetch the version for it."),
});
export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;

export const ListArtifactsQuerySchema = PaginationQuerySchema;

export const ListArtifactsResponseSchema = paginatedResponseSchema(ArtifactResourceSchema);
export type ListArtifactsResponse = z.infer<typeof ListArtifactsResponseSchema>;

export const ListArtifactVersionsResponseSchema = paginatedResponseSchema(ArtifactVersionSchema);
export type ListArtifactVersionsResponse = z.infer<typeof ListArtifactVersionsResponseSchema>;

// Limits mirror artifactService's own (b4m-core/services/src/artifactService/create.ts, update.ts),
// so an over-long field is a 422 here rather than a throw from the service.
const TitleSchema = z.string().min(1).max(255);
const DescriptionSchema = z.string().max(1000);
const TagsSchema = z.array(z.string().max(50)).max(20);

/** Strict, so a camelCase `sessionId` (the SPA route's spelling) is a 422 rather than silently dropped. */
export const CreateArtifactRequestSchema = z
  .object({
    type: ArtifactTypeSchema,
    title: TitleSchema,
    content: z.string().min(1),
    description: DescriptionSchema.optional(),
    session_id: z.string().min(1).optional().describe('A session you can edit, to file the artifact under.'),
    project_id: z.string().min(1).optional().describe('A project you can read, to file the artifact under.'),
    tags: TagsSchema.optional(),
  })
  .strict();
export type CreateArtifactRequest = z.infer<typeof CreateArtifactRequestSchema>;

/** Strict for the same reason as the create body. Omitted fields are left unchanged. */
export const UpdateArtifactRequestSchema = z
  .object({
    title: TitleSchema.optional(),
    description: DescriptionSchema.optional(),
    content: z.string().min(1).optional().describe('Changed content creates a new version.'),
    tags: TagsSchema.optional(),
  })
  .strict();
export type UpdateArtifactRequest = z.infer<typeof UpdateArtifactRequestSchema>;

/** Strict like the other bodies. `content` is required: an empty version marker has nothing to publish. */
export const CreateArtifactVersionRequestSchema = z
  .object({
    content: z.string().min(1).describe("The new version's content."),
    change_description: z.string().max(500).optional().describe('A short note on what changed.'),
    version_tag: z.string().max(100).optional().describe('A label for this version, such as `v2`.'),
  })
  .strict();
export type CreateArtifactVersionRequest = z.infer<typeof CreateArtifactVersionRequestSchema>;

export const SearchArtifactsQuerySchema = PaginationQuerySchema.extend({
  q: z.string().min(1).max(200).describe('The text to search for.'),
  type: ArtifactTypeSchema.optional().describe('Only artifacts of this type.'),
});

export const ArtifactTypeInfoSchema = z.object({
  type: ArtifactTypeSchema,
  name: z.string(),
  description: z.string(),
  category: z.string(),
  mime_type: z.string(),
});

export const ListArtifactTypesResponseSchema = z.object({
  types: z.array(ArtifactTypeInfoSchema),
  categories: z.array(z.string()),
});
export type ListArtifactTypesResponse = z.infer<typeof ListArtifactTypesResponseSchema>;

const PUBLISH_VISIBILITIES = ['private', 'organization', 'public'] as const;

/** Lowercase kebab-case. Reserved words such as `api` and `admin` are rejected by the handler. */
const PublishSlugSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase kebab-case');

/**
 * The gate a page is published behind. A passphrase is sent in plaintext once and stored only as a
 * hash; `allowed_domains` admits a viewer whose verified email is on one of the domains or their
 * subdomains.
 */
export const PublishAccessGateRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('passphrase'), passphrase: z.string().min(8).max(128) }).strict(),
  z
    .object({
      kind: z.literal('domain'),
      allowed_domains: z.array(z.string().min(1).max(253)).min(1).max(20),
    })
    .strict(),
]);
export type PublishAccessGateRequest = z.infer<typeof PublishAccessGateRequestSchema>;

/** Strict like the other bodies. Everything is optional: an empty body publishes publicly under a generated slug. */
export const PublishArtifactRequestSchema = z
  .object({
    slug: PublishSlugSchema.optional().describe(
      'The page address, unique within your pages. Omitted: one is generated from the title.'
    ),
    visibility: z
      .enum(PUBLISH_VISIBILITIES)
      .default('public')
      .describe('Who can open the page. `private` is visible to you only.'),
    access_gate: PublishAccessGateRequestSchema.optional().describe(
      'Put the page behind a passphrase or an email-domain list. Applied together with the visibility, so ' +
        'the page is never reachable without it. Requires `visibility: "public"`.'
    ),
  })
  .strict();
export type PublishArtifactRequest = z.infer<typeof PublishArtifactRequestSchema>;

export const PublishedArtifactResourceSchema = z.object({
  artifact_id: z.string(),
  public_id: z.string().describe('The id of the published page. Stable across republishes.'),
  url: z.string().describe('The absolute URL of the page.'),
  slug: z.string(),
  visibility: z.enum(PUBLISH_VISIBILITIES),
  access_gate: z
    .object({ kind: z.enum(['passphrase', 'domain']) })
    .nullable()
    .describe('The kind of gate on the page, or `null` when it has none. The passphrase is never returned.'),
  published_version: z.number().int().describe('The artifact version whose content the page shows.'),
  published_at: z.string().describe('ISO 8601 timestamp of the latest publish.'),
});
export type PublishedArtifactResource = z.infer<typeof PublishedArtifactResourceSchema>;
