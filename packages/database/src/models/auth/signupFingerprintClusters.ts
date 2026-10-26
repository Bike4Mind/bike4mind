import { z } from 'zod';
import { JA4_PATTERN, ja4FingerprintSchema, type SignupFingerprintCluster } from '@bike4mind/common';
import { User } from './UserModel';

const querySchema = z
  .object({
    windowStart: z.date(),
    windowEnd: z.date(),
    minimumSignups: z.number().int().min(1),
    excludedFingerprints: z.array(ja4FingerprintSchema).max(10_000),
    limit: z.number().int().min(1).max(1_000),
  })
  .refine(
    q => q.windowStart < q.windowEnd && q.windowEnd.getTime() - q.windowStart.getTime() <= 90 * 24 * 60 * 60_000,
    'Window must be increasing and at most 90 days'
  );

export type SignupFingerprintQuery = z.infer<typeof querySchema>;

/** Counts user records, not auth events: retries and subsequent logins cannot inflate a cluster. */
export async function findSignupFingerprintClusters(
  input: SignupFingerprintQuery
): Promise<SignupFingerprintCluster[]> {
  const query = querySchema.parse(input);
  const rows = await User.aggregate<{ _id: string; signupCount: number }>([
    {
      $match: {
        createdAt: { $gte: query.windowStart, $lt: query.windowEnd },
        'signupMeta.ja4': { $type: 'string', $regex: JA4_PATTERN.source, $nin: query.excludedFingerprints },
      },
    },
    { $group: { _id: '$signupMeta.ja4', signupCount: { $sum: 1 } } },
    { $match: { signupCount: { $gte: query.minimumSignups } } },
    { $sort: { signupCount: -1, _id: 1 } },
    { $limit: query.limit },
  ]).option({ maxTimeMS: 30_000, allowDiskUse: true });
  return rows.map(row => ({
    ja4: row._id,
    signupCount: row.signupCount,
    windowStart: query.windowStart,
    windowEnd: query.windowEnd,
  }));
}
