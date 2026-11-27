import type { Model } from 'mongoose';
import { PlatformAttempt, UsageEvent } from '@bike4mind/database';
import type { MigrationFile } from './index';

export async function ensurePlatformAccountingIndexes<T, U>(usage: Model<T>, attempts: Model<U>): Promise<void> {
  const usageIndexes = usage.schema
    .indexes()
    .filter(([fields]) => 'providerCallId' in fields || 'usageOccurredAt' in fields);
  const attemptIndexes = attempts.schema
    .indexes()
    .filter(([fields]) => 'providerCallId' in fields || 'state' in fields || 'attribution.executionId' in fields);
  if (
    !usageIndexes.some(
      ([fields, options]) =>
        fields.providerCallId === 1 &&
        options.unique &&
        options.partialFilterExpression?.['attribution.kind'] === 'platform_operation'
    ) ||
    !attemptIndexes.some(([fields, options]) => fields.providerCallId === 1 && options.unique)
  ) {
    throw new Error('Platform accounting unique indexes are not declared');
  }
  for (const [target, specs] of [
    [usage, usageIndexes],
    [attempts, attemptIndexes],
  ] as const) {
    for (const [fields, options] of specs) {
      type Args = Parameters<typeof target.collection.createIndex>;
      await target.collection.createIndex(fields as Args[0], options as Args[1]);
    }
  }
}

const migration: MigrationFile = {
  id: 20261125065938,
  name: 'ensure platform accounting indexes',
  up: async () => {
    await ensurePlatformAccountingIndexes(UsageEvent, PlatformAttempt);
  },
  down: async () => {},
};
export default migration;
