import * as z from 'zod';
import type { IProjectDocument } from '../types/entities/ProjectTypes';
import { passthroughShape } from './responseShape';
import { groupShareResponseSchema, userShareResponseSchema } from './shareResponse';

// Held to IProjectDocument: a new IProject field fails the build here until it is listed.
// `users` and `groups` are typed below instead of passed through.
const PROJECT_RESPONSE_FIELDS = {
  id: true,
  createdAt: true,
  updatedAt: true,
  name: true,
  description: true,
  userId: true,
  sessionIds: true,
  fileIds: true,
  systemPrompts: true,
  deletedAt: true,
  isGlobalRead: true,
  isGlobalWrite: true,
} as const satisfies Record<Exclude<keyof IProjectDocument, 'users' | 'groups'>, true>;

/** A project as returned by the SPA project routes. */
export const projectResponseSchema = z.object({
  ...passthroughShape(PROJECT_RESPONSE_FIELDS),
  users: z.array(userShareResponseSchema).optional(),
  groups: z.array(groupShareResponseSchema).optional(),
});

export const projectListResponseSchema = z.array(projectResponseSchema);

/** DELETE /api/projects/removeNonExistintFiles. */
export const removeNonExistentFilesResponseSchema = z.object({
  updatedProjects: z.array(projectResponseSchema),
});
