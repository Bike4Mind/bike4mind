import mongoose from 'mongoose';
import type { MigrationFile } from './index';
import { z } from 'zod';
import { INTERVENTION_TIERS } from '@bike4mind/common';
import { AutoContainmentDecisionModel } from '@bike4mind/database';

const NEW_INDEX_NAME = 'detection_revision_claim_class_unique';
const NEW_KEY = { detectionId: 1, revision: 1, claimClass: 1 } as const;
const LEGACY_KEYS = [{ detectionId: 1 }, { detectionId: 1, revision: 1 }] as const;

const indexSchema = z
  .object({
    name: z.string(),
    key: z.record(z.string(), z.unknown()),
    unique: z.boolean().optional(),
    sparse: z.boolean().optional(),
    hidden: z.boolean().optional(),
    partialFilterExpression: z.unknown().optional(),
    collation: z.unknown().optional(),
    expireAfterSeconds: z.unknown().optional(),
  })
  .passthrough();
type Index = z.infer<typeof indexSchema>;

function sameKey(actual: Record<string, unknown>, expected: Readonly<Record<string, number>>): boolean {
  const entries = Object.entries(actual);
  const wanted = Object.entries(expected);
  return (
    entries.length === wanted.length &&
    entries.every(([key, value], i) => key === wanted[i]?.[0] && value === wanted[i]?.[1])
  );
}

function assertPlainUnique(index: Index): void {
  if (
    index.unique !== true ||
    index.sparse === true ||
    index.hidden === true ||
    index.partialFilterExpression !== undefined ||
    index.collation !== undefined ||
    index.expireAfterSeconds !== undefined
  ) {
    throw new Error(`Unrecognized containment index options: ${index.name}`);
  }
}

async function indexes(): Promise<Index[]> {
  try {
    const value: unknown = await AutoContainmentDecisionModel.collection.indexes();
    return z.array(indexSchema).parse(value);
  } catch (error: unknown) {
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 26) return [];
    throw error;
  }
}

export async function up(): Promise<void> {
  const collection = AutoContainmentDecisionModel.collection;
  // Expression $type checks the field itself; query $type can also match array elements.
  const validTier = {
    $or: [
      { $in: [{ $type: '$tier' }, ['missing', 'null']] },
      { $and: [{ $eq: [{ $type: '$tier' }, 'string'] }, { $in: ['$tier', [...INTERVENTION_TIERS]] }] },
    ],
  };
  if (await collection.findOne({ $expr: { $not: [validTier] } }, { projection: { _id: 1 } })) {
    throw new Error('Unrecognized legacy containment tier; no indexes were removed');
  }

  // Raw update preserves decidedAt/updatedAt and ids. Mongo null equality also matches absence.
  // update-validators-off: native driver normalizes checked legacy null/missing tiers to a literal without changing timestamps
  await collection.updateMany({ tier: null }, { $set: { tier: 'contain' } });
  // Missing and null share the legacy Contain index slot, so old writers remain deduplicated.
  // update-validators-off: native driver derives this internal enum from the validated tier without changing timestamps
  await collection.updateMany({ tier: 'contain' }, { $set: { claimClass: null } });
  // update-validators-off: native driver gives all validated graduated tiers one shared claim class
  await collection.updateMany(
    { tier: { $in: INTERVENTION_TIERS.filter(tier => tier !== 'contain') } },
    { $set: { claimClass: 'graduated' } }
  );
  const duplicate: unknown = await collection
    .aggregate([
      {
        $group: {
          _id: { detectionId: '$detectionId', revision: '$revision', claimClass: '$claimClass' },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
      { $project: { _id: 0, count: 1 } },
    ])
    .next();
  if (duplicate !== null) throw new Error('Duplicate containment claim class; no indexes were removed');

  const before = await indexes();
  const old = before.filter(index => LEGACY_KEYS.some(key => sameKey(index.key, key)));
  for (const index of old) assertPlainUnique(index);
  for (const index of before) {
    if (index.name === NEW_INDEX_NAME || sameKey(index.key, NEW_KEY)) {
      if (index.name !== NEW_INDEX_NAME || !sameKey(index.key, NEW_KEY)) {
        throw new Error('Unexpected containment claim-class index identity; no indexes were removed');
      }
      assertPlainUnique(index);
    }
  }

  // Builds replacement + existing TTL/serving indexes; does not drop anything.
  await AutoContainmentDecisionModel.createIndexes();
  const replacement = (await indexes()).find(index => index.name === NEW_INDEX_NAME);
  if (!replacement || !sameKey(replacement.key, NEW_KEY)) throw new Error('Containment replacement index missing');
  assertPlainUnique(replacement);

  for (const index of old) {
    try {
      // Found by exact key/options above; do not assume an auto-generated legacy name.
      await collection.dropIndex(index.name);
    } catch (error: unknown) {
      if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 27) throw error;
    }
  }
  const after = await indexes();
  if (after.some(index => LEGACY_KEYS.some(key => sameKey(index.key, key)))) {
    throw new Error('Obsolete containment uniqueness still present');
  }
  const finalReplacement = after.find(index => index.name === NEW_INDEX_NAME);
  if (!finalReplacement || !sameKey(finalReplacement.key, NEW_KEY)) throw new Error('Containment replacement lost');
  assertPlainUnique(finalReplacement);
  if (!after.some(index => sameKey(index.key, { decidedAt: 1 }) && index.expireAfterSeconds === 365 * 24 * 60 * 60)) {
    throw new Error('Containment retention index missing or changed');
  }
  if (!after.some(index => sameKey(index.key, { outcome: 1, decidedAt: -1 }))) {
    throw new Error('Containment outcome index missing');
  }
  for (const prior of before.filter(index => !old.some(obsolete => obsolete.name === index.name))) {
    const current = after.find(index => index.name === prior.name);
    if (!current || JSON.stringify(current) !== JSON.stringify(prior)) {
      throw new Error(`Unrelated containment index changed: ${prior.name}`);
    }
  }
}

const migration: MigrationFile = {
  id: 20261124112619,
  name: 'separate auto containment decisions by tier',
  up,
  down: async () => {
    // Forward-only: different tiers can now coexist. Never delete records to restore pair uniqueness.
  },
};

export default migration;
