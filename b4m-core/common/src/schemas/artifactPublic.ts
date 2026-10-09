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
    .describe("The current version's content. `null` in a list; fetch the artifact by id for it."),
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
