import { z } from 'zod';
import { paginatedResponseSchema } from './pagination';
import { FileSummarySchema } from './publicFile';
import { SessionResponseSchema } from './session';
import { MAX_PROJECT_CREATE_IDS } from './projectPublic';

/**
 * Wire schemas for the public project file and session sub-resources
 * (api-contract/contracts/projectContent.contract.ts). The project itself is rendered by
 * `ProjectResourceSchema`; list items reuse the public file summary and session shapes.
 *
 * Imported directly (never through the schemas barrel) by the contract and OpenAPI layers, so keep
 * this file free of `@bike4mind/*` imports - the CI spec job loads it without building anything.
 */

/**
 * Ids are plain strings on purpose: a malformed id must answer 404 (CONVENTIONS.md status table),
 * and a path-param schema failure would answer 422.
 */
export const ProjectFileParamSchema = z.object({
  id: z.string().min(1),
  file_id: z.string().min(1),
});

export const ProjectSessionParamSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
});

/** Strict, so the SPA route's camelCase `fileIds` is a 422 rather than silently dropped. */
export const AddProjectFilesRequestSchema = z
  .object({
    file_ids: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_PROJECT_CREATE_IDS)
      .describe('Files to group in the project. Each must be readable by the caller.'),
  })
  .strict();
export type AddProjectFilesRequest = z.infer<typeof AddProjectFilesRequestSchema>;

/** Strict for the same reason as the files body. */
export const AddProjectSessionsRequestSchema = z
  .object({
    session_ids: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_PROJECT_CREATE_IDS)
      .describe('Sessions to group in the project. Each must be readable by the caller.'),
  })
  .strict();
export type AddProjectSessionsRequest = z.infer<typeof AddProjectSessionsRequestSchema>;

export const ListProjectFilesResponseSchema = paginatedResponseSchema(FileSummarySchema);
export type ListProjectFilesResponse = z.infer<typeof ListProjectFilesResponseSchema>;

export const ListProjectSessionsResponseSchema = paginatedResponseSchema(SessionResponseSchema);
export type ListProjectSessionsResponse = z.infer<typeof ListProjectSessionsResponseSchema>;
