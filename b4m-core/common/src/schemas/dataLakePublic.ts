import { z } from 'zod';
import { DATA_LAKE_STATUSES } from '../types/entities/DataLakeTypes';
import { MAX_LAKE_FILE_TAG_NAME_LENGTH, MAX_TAXONOMY_TAGS } from '../constants/dataLakes';
import { paginatedResponseSchema } from './pagination';

/**
 * Wire schemas for the public `/api/v1/data-lakes/*` contracts
 * (api-contract/contracts/dataLakes.contract.ts). Deliberately narrower than the SPA's data-lake
 * payloads: a field published here can be added to later but never removed, so only what an
 * integrator needs to find a lake, manage its membership and search it is on the wire.
 *
 * Imported directly (never through the schemas barrel) by the contract and OpenAPI layers, so keep
 * this file free of `@bike4mind/*` imports - the CI spec job loads it without building anything.
 */

export const DataLakeResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  /**
   * The value to pass in a session's `lakeScope`. Not derivable from `slug` + `organization_id`: a
   * lake moved into an org keeps the `datalake:<slug>` tag it was created with.
   */
  datalake_tag: z.string(),
  description: z.string().nullable(),
  organization_id: z.string().nullable(),
  is_public: z.boolean(),
  /** A lake built into the platform: readable like any other, but read-only for every caller. */
  built_in: z.boolean(),
  status: z.enum(DATA_LAKE_STATUSES),
  file_count: z.number().int().nonnegative(),
  total_size_bytes: z.number().nonnegative(),
  last_sync_at: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});
export type DataLakeResource = z.infer<typeof DataLakeResourceSchema>;

export const ListDataLakesResponseSchema = paginatedResponseSchema(DataLakeResourceSchema);
export type ListDataLakesResponse = z.infer<typeof ListDataLakesResponseSchema>;

/** `id` is a lake id or its slug; an unknown value of either shape is a 404, never a 422. */
export const DataLakeIdParamSchema = z.object({
  id: z.string().min(1),
});

/**
 * `file_id` is a plain string here on purpose: a malformed id must answer 404 (CONVENTIONS.md
 * status table), and a path-param schema failure would answer 422. The handler 404s a non-ObjectId.
 */
export const DataLakeFileParamSchema = z.object({
  id: z.string().min(1),
  file_id: z.string().min(1),
});

/**
 * Ingestion vocabulary for a lake member. Must stay in step with `classifyIngestionStatus` in
 * b4m-core/services (dataLakeService/retrievalUnavailable.ts), which derives it from the same
 * predicates semantic search uses to withhold a file as indexing or paused.
 */
export const DATA_LAKE_FILE_INGESTION_STATUSES = ['not_ingested', 'indexing', 'paused', 'ready', 'failed'] as const;
export type DataLakeFileIngestionStatus = (typeof DATA_LAKE_FILE_INGESTION_STATUSES)[number];

export const DataLakeFileResponseSchema = z.object({
  lake_id: z.string(),
  file_id: z.string(),
  file_name: z.string(),
  ingestion_status: z.enum(DATA_LAKE_FILE_INGESTION_STATUSES),
  chunk_count: z.number().int().nonnegative(),
  vectorized_chunk_count: z.number().int().nonnegative(),
  error: z.string().nullable(),
});
export type DataLakeFileResponse = z.infer<typeof DataLakeFileResponseSchema>;

export const DataLakeFileMembershipResponseSchema = z.object({
  lake_id: z.string(),
  file_id: z.string(),
  file_count: z.number().int().nonnegative(),
  total_size_bytes: z.number().nonnegative(),
});
export type DataLakeFileMembershipResponse = z.infer<typeof DataLakeFileMembershipResponseSchema>;

export const DataLakeSearchRequestSchema = z.object({
  query: z.string().min(1).max(4000),
  top_k: z.number().int().min(1).max(100).default(10),
  min_score: z.number().min(-1).max(1).default(0),
  // Bounds match the taxonomy write path (schemas/dataLake.ts) so a search request can never
  // exceed what a lake's own tags could carry.
  tags: z.array(z.string().min(1).max(MAX_LAKE_FILE_TAG_NAME_LENGTH)).max(MAX_TAXONOMY_TAGS).optional(),
});
export type DataLakeSearchRequest = z.infer<typeof DataLakeSearchRequestSchema>;

export const DataLakeSearchResponseSchema = z.object({
  results: z.array(
    z.object({
      chunk_id: z.string(),
      file_id: z.string(),
      file_name: z.string(),
      chunk_text: z.string(),
      score: z.number(),
    })
  ),
  embedding_model: z.string(),
  partial_results: z.boolean(),
  retrieval_unavailable: z.object({
    indexing_files: z.number().int().nonnegative(),
    paused_files: z.number().int().nonnegative(),
  }),
});
export type DataLakeSearchResponse = z.infer<typeof DataLakeSearchResponseSchema>;

// Moved to ./chat beside the other shared error envelopes; re-exported for existing importers.
export { ProviderNotConfiguredErrorSchema } from './chat';
