import { CounterLog } from '@bike4mind/database';
import { type MigrationFile } from './index';

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
    // update-validators-off: native pipeline update on a Mixed metadata field; no schema validators apply.
    const result = await CounterLog.collection.updateMany({ 'metadata.promptMessage': { $exists: true } }, [
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
    ]);
    console.log(`[strip-prompt-text-from-counter-logs] rewrote ${result.modifiedCount} counter log(s)`);
  },

  down: async () => {
    // One-way: the removed text is not recoverable.
  },
};

export default migration;
