import * as z from 'zod';
import type { IGroupDocument } from '../types/entities/GroupTypes';
import { passthroughShape } from './responseShape';

// Held to IGroupDocument: a new IGroup field fails the build here until it is listed.
const GROUP_RESPONSE_FIELDS = {
  id: true,
  createdAt: true,
  updatedAt: true,
  name: true,
  description: true,
  type: true,
  organizationId: true,
} as const satisfies Record<keyof IGroupDocument, true>;

/** An organization group instance, as returned by the org group routes. */
export const organizationGroupResponseSchema = z.object(passthroughShape(GROUP_RESPONSE_FIELDS));

/** A group with its members (organizationService.listOrganizationGroups). */
export const organizationGroupWithMembersResponseSchema = organizationGroupResponseSchema.extend({
  memberIds: z.array(z.string()),
  memberCount: z.number(),
});
