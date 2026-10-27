import * as z from 'zod';
import type { IProjectDocument } from '../types/entities/ProjectTypes';
import { passthroughShape } from './responseShape';

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

// IUserShare.user is a lazy-loaded virtual that project reads never populate, so it is not listed.
const projectUserShareResponseSchema = z.object(
  passthroughShape({ userId: true, permissions: true, projectId: true, sessionId: true, extraData: true })
);

const projectGroupShareResponseSchema = z.object(passthroughShape({ groupId: true, permissions: true }));

/** A project as returned by the SPA project routes. */
export const projectResponseSchema = z.object({
  ...passthroughShape(PROJECT_RESPONSE_FIELDS),
  users: z.array(projectUserShareResponseSchema).optional(),
  groups: z.array(projectGroupShareResponseSchema).optional(),
});

/** DELETE /api/projects/removeNonExistintFiles. */
export const removeNonExistentFilesResponseSchema = z.object({
  updatedProjects: z.array(projectResponseSchema),
});
