import { Types } from 'mongoose';
import { CounterLog } from '@bike4mind/database';
import { type MigrationFile } from './index';

const LOG = '[strip-prompt-text-from-counter-logs]';
const WINDOW_SIZE = 10_000;

/**
 * Analytics events now record a prompt's length, never its text. Rewrites the rows written before
 * that change the same way, so CounterLog holds no prompt text.
 *
 * Idempotent: only rows that still carry metadata.promptMessage match.
 */
const migration: MigrationFile = {
  id: 20261126141113,
  name: 'strip prompt text from counter logs',

  up: async () => {
    let after: Types.ObjectId | undefined;
    let rewritten = 0;
    for (;;) {
      // Windows are cut on _id alone, straight from its index. Paging on the unindexed metadata
      // filter instead would scan the rest of the collection in one call once few rows still match.
      const [end] = await CounterLog.collection
        .find(after ? { _id: { $gt: after } } : {}, { projection: { _id: 1 } })
        .sort({ _id: 1 })
        .skip(WINDOW_SIZE - 1)
        .limit(1)
        .toArray();
      const upTo = end?._id as Types.ObjectId | undefined;

      // update-validators-off: native pipeline update on a Mixed metadata field; no schema validators apply.
      const result = await CounterLog.collection.updateMany(
        {
          ...((after || upTo) && { _id: { ...(after && { $gt: after }), ...(upTo && { $lte: upTo }) } }),
          'metadata.promptMessage': { $exists: true },
        },
        [
          {
            $set: {
              'metadata.promptLength': {
                $cond: [
                  { $eq: [{ $type: '$metadata.promptMessage' }, 'string'] },
                  { $strLenCP: '$metadata.promptMessage' },
                  0,
                ],
              },
            },
          },
          { $unset: 'metadata.promptMessage' },
        ]
      );
      rewritten += result.modifiedCount;

      if (!upTo) break;
      after = upTo;
    }
    console.log(`${LOG} rewrote ${rewritten} counter log(s)`);
  },

  down: async () => {
    // One-way: the removed text is not recoverable.
  },
};

export default migration;
