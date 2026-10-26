import { z } from 'zod';

export const JA4_PATTERN = /^[tqd][0-9a-z]{2}[di][0-9]{4}[0-9a-z]{2}_[0-9a-f]{12}_[0-9a-f]{12}$/;
export const ja4FingerprintSchema = z.string().length(36).regex(JA4_PATTERN);

export const networkMetaSchema = z.object({
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  asn: z.number().nullable(),
  asnOrg: z.string().nullable(),
  country: z.string().nullable(),
  isDatacenter: z.boolean().nullable(),
  ja4: ja4FingerprintSchema.nullable().optional(),
});

export const signupMetaSchema = networkMetaSchema.extend({ capturedAt: z.date() });

/** Server/admin-only observation; a shared fingerprint is not an access decision. */
export const signupFingerprintClusterSchema = z.object({
  ja4: ja4FingerprintSchema,
  signupCount: z.number().int().positive(),
  windowStart: z.date(),
  windowEnd: z.date(),
});
export type SignupFingerprintCluster = z.infer<typeof signupFingerprintClusterSchema>;
