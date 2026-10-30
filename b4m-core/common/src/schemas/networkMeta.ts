import { z } from 'zod';
import type { INetworkMeta, ISignupMeta } from '../types/entities/UserTypes';

// Unlike $, this end assertion also rejects a final newline in MongoDB's regex engine.
export const JA4_PATTERN = /^[tqd][0-9a-z]{2}[di][0-9]{4}[0-9A-Za-z]{2}_[0-9a-f]{12}_[0-9a-f]{12}(?![\s\S])/;
export const ja4FingerprintSchema = z.string().length(36).regex(JA4_PATTERN);

export const networkMetaSchema = z.object({
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  asn: z.number().nullable(),
  asnOrg: z.string().nullable(),
  country: z.string().nullable(),
  isDatacenter: z.boolean().nullable(),
  ja4: ja4FingerprintSchema.nullable().optional(),
  wafAnonIp: z.boolean().nullable().optional(),
  wafBotSignal: z.boolean().nullable().optional(),
}) satisfies z.ZodType<INetworkMeta>;

export const signupMetaSchema = networkMetaSchema.extend({
  capturedAt: z.date(),
  challengeVerified: z.literal(true).nullable().optional(),
}) satisfies z.ZodType<ISignupMeta>;

/** Server/admin-only observation; a shared fingerprint is not an access decision. */
export const signupFingerprintClusterSchema = z.object({
  ja4: ja4FingerprintSchema,
  signupCount: z.number().int().positive(),
  windowStart: z.date(),
  windowEnd: z.date(),
});
export type SignupFingerprintCluster = z.infer<typeof signupFingerprintClusterSchema>;
