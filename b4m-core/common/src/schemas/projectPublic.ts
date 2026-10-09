import { z } from 'zod';
import { paginatedResponseSchema } from './pagination';

/**
 * Wire schemas for the public `/api/v1/projects` contracts (api-contract/contracts/projects.contract.ts).
 * Deliberately narrower than IProject: sharing state (`users`, `groups`, `isGlobalRead/Write`), system
 * prompts and soft-delete markers are never published. A field added here can never be removed, so
 * only what an integrator needs to find a project and see what it groups is on the wire.
 *
 * Imported directly (never through the schemas barrel) by the contract and OpenAPI layers, so keep
 * this file free of `@bike4mind/*` imports - the CI spec job loads it without building anything.
 */

/** Upper bound on ids attached at create time; keeps the access lookup a bounded `$in`. */
export const MAX_PROJECT_CREATE_IDS = 500;

export const ProjectResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  session_ids: z
    .array(z.string())
    .describe('Sessions grouped in the project. Anyone the project is shared with can read them.'),
  file_ids: z
    .array(z.string())
    .describe('Files grouped in the project. Anyone the project is shared with can read them.'),
  created_at: z.string().nullable().describe('ISO 8601 timestamp.'),
  updated_at: z.string().nullable().describe('ISO 8601 timestamp.'),
});
export type ProjectResource = z.infer<typeof ProjectResourceSchema>;

export const ListProjectsResponseSchema = paginatedResponseSchema(ProjectResourceSchema);
export type ListProjectsResponse = z.infer<typeof ListProjectsResponseSchema>;

/**
 * `id` is a plain string on purpose: a malformed id must answer 404 (CONVENTIONS.md status table),
 * and a path-param schema failure would answer 422.
 */
export const ProjectIdParamSchema = z.object({
  id: z.string().min(1),
});

/**
 * Strict, so a camelCase `sessionIds`/`fileIds` (the SPA route's spelling) is a 422 rather than
 * silently dropped, which would create a project without the content the caller meant to attach.
 */
export const CreateProjectRequestSchema = z
  .object({
    name: z.string().min(1).describe('Unique among your live projects.'),
    description: z.string().min(1),
    session_ids: z
      .array(z.string().min(1))
      .max(MAX_PROJECT_CREATE_IDS)
      .optional()
      .describe('Sessions to group in the project. Each must be readable by the caller.'),
    file_ids: z
      .array(z.string().min(1))
      .max(MAX_PROJECT_CREATE_IDS)
      .optional()
      .describe('Files to group in the project. Each must be readable by the caller.'),
  })
  .strict();
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;
