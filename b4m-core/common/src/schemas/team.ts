import { z } from 'zod';

export const InternalTeamMemberSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  phone: z.string().min(1, 'Phone is required'),
  email: z.email('Must be a valid email').optional(),
  role: z.string().optional(),
  department: z.string().optional(),
  isActive: z.boolean().optional(),
});

export const InternalTeamMemberListSchema = z.array(InternalTeamMemberSchema);
