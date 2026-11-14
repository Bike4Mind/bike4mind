import { z } from 'zod';

export const MAX_RETENTION_DAYS = 36500;

export const retentionPolicySchema = z
  .object({
    chats: z.number().int().min(1).max(MAX_RETENTION_DAYS).nullable(),
    files: z.number().int().min(1).max(MAX_RETENTION_DAYS).nullable(),
    media: z.number().int().min(1).max(MAX_RETENTION_DAYS).nullable(),
  })
  .strict();

export type OrganizationRetentionPolicy = z.infer<typeof retentionPolicySchema>;
export const foreverRetention: OrganizationRetentionPolicy = { chats: null, files: null, media: null };
export const retentionKinds = ['chats', 'files', 'media'] as const;
export type RetentionKind = (typeof retentionKinds)[number];

export function shortensRetention(before: OrganizationRetentionPolicy, after: OrganizationRetentionPolicy): boolean {
  return retentionKinds.some(kind => after[kind] !== null && (before[kind] === null || after[kind]! < before[kind]!));
}

export function retentionCutoff(days: number | null, now: Date): Date | null {
  return days === null ? null : new Date(now.getTime() - days * 86_400_000);
}
