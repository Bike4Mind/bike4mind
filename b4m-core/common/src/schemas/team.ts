import { z } from 'zod';
import type { IInternalTeamMemberDocument } from '../types/entities/InternalTeamMemberTypes';
import { passthroughShape } from './responseShape';

export const InternalTeamMemberSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  phone: z.string().min(1, 'Phone is required'),
  email: z.email('Must be a valid email').optional(),
  role: z.string().optional(),
  department: z.string().optional(),
  isActive: z.boolean().optional(),
});

export const InternalTeamMemberListSchema = z.array(InternalTeamMemberSchema);

// Held to the document type: a new field fails the build here until it is listed.
const INTERNAL_TEAM_MEMBER_RESPONSE_FIELDS = {
  id: true,
  name: true,
  phone: true,
  email: true,
  role: true,
  department: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Record<keyof IInternalTeamMemberDocument, true>;

/** An internal team member as the admin routes return it. */
export const internalTeamMemberResponseSchema = z.object(passthroughShape(INTERNAL_TEAM_MEMBER_RESPONSE_FIELDS));

export const internalTeamMemberListResponseSchema = z.array(internalTeamMemberResponseSchema);
