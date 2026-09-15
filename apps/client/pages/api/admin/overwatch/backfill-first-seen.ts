import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { User, OverwatchUserFirstSeen } from '@bike4mind/database';
import { ForbiddenError } from '@server/utils/errors';
import { pseudonymizeUserId } from '@server/analytics/pseudonymize';
import { Config } from '@server/utils/config';

const BATCH_SIZE = 500;
const PRODUCT_ID = 'bike4mind';

const bodySchema = z.object({
  skip: z.number().int().nonnegative().default(0),
});

const handler = baseApi().post(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  // Salt must be configured; pseudonymizing with the 'not-configured' placeholder produces a
  // different key than the live emitter, silently writing orphaned first-seen records that never
  // match any real user. Fail safe instead. (Resource.X.value returns the placeholder, not a throw.)
  if (!Config.OVERWATCH_PSEUDONYM_SALT || Config.OVERWATCH_PSEUDONYM_SALT === 'not-configured') {
    return res.status(503).json({
      error: 'OVERWATCH_PSEUDONYM_SALT not configured. Set it via `sst secret set` before running the backfill.',
    });
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
  }
  const { skip } = parsed.data;

  // Fetch one batch of non-system human users, oldest first for deterministic pagination
  const users = await User.find({ isSystem: { $ne: true } }, { _id: 1, createdAt: 1 })
    .sort({ _id: 1 })
    .skip(skip)
    .limit(BATCH_SIZE)
    .lean();

  if (users.length === 0) {
    return res.json({ processed: 0, upserted: 0, hasMore: false, nextSkip: skip });
  }

  // Build bulkWrite ops: $min preserves the earliest date if re-run after some events already landed.
  // Skip docs with a missing/unparseable createdAt rather than letting new Date(undefined).toISOString()
  // throw and abort the whole batch (which would stall the backfill permanently at this offset).
  let skipped = 0;
  const ops = users.flatMap(user => {
    const created = user.createdAt instanceof Date ? user.createdAt : new Date(user.createdAt as string);
    if (isNaN(created.getTime())) {
      skipped++;
      return [];
    }
    const pseudoUserId = pseudonymizeUserId(user._id.toString());
    const firstSeenDate = created.toISOString().substring(0, 10);

    return [
      {
        updateOne: {
          filter: { productId: PRODUCT_ID, userId: pseudoUserId },
          update: {
            $min: { firstSeenDate },
            $setOnInsert: { productId: PRODUCT_ID, userId: pseudoUserId },
          },
          upsert: true,
        },
      },
    ];
  });

  const result = ops.length > 0 ? await OverwatchUserFirstSeen.bulkWrite(ops, { ordered: false }) : null;

  return res.json({
    processed: users.length,
    skipped,
    upserted: result?.upsertedCount ?? 0,
    modified: result?.modifiedCount ?? 0,
    hasMore: users.length === BATCH_SIZE,
    nextSkip: skip + users.length,
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
