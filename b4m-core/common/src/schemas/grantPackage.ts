import { z } from 'zod';
import type { GrantPackageRefusalReason } from '../types/entities/GrantPackageTypes';

const capSchema = z.number().int().min(1).nullable();

export const grantPackageInputSchema = z.object({
  name: z.string().trim().min(1),
  credits: z.number().int().min(0),
  storageMb: z.number().int().min(1).nullable().optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  totalCap: capSchema,
  dailyCap: capSchema,
  active: z.boolean().optional(),
  reason: z.string().trim().min(1).nullable().optional(),
});

export type GrantPackageInput = z.infer<typeof grantPackageInputSchema>;

/** UTC calendar day a daily cap counts against. */
export const grantPackageDay = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

export const GRANT_PACKAGE_INBOX_CLAIMED_MESSAGE = 'This inbox has already received a signup grant';

export function grantPackageRefusalMessage(reason: GrantPackageRefusalReason): string {
  switch (reason) {
    case 'total_cap':
      return 'This invite code has reached its signup limit';
    case 'daily_cap':
      return 'This invite code has reached its signup limit for today, please try again tomorrow';
    case 'inactive':
      return 'This invite code is no longer active';
  }
}
