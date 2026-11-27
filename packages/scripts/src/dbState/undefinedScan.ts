import type { mongo } from 'mongoose';
import { describeError } from './describeError';

export type UndefinedScanResult = { status: 'complete'; documents: number } | { status: 'incomplete'; reason: string };

const READ_PREFERENCE = 'secondary';
const TIME_LIMIT_REASON = 'time limit exceeded';

/** Counted on the server, so no document leaves the database. */
const TOP_LEVEL_PIPELINE: mongo.Document[] = [
  {
    $match: {
      $expr: {
        $anyElementTrue: [
          {
            $map: {
              input: { $objectToArray: '$$ROOT' },
              in: { $eq: [{ $type: '$$this.v' }, 'undefined'] },
            },
          },
        ],
      },
    },
  },
  { $count: 'documents' },
];

const isBsonValue = (value: object): boolean => '_bsontype' in value;

/** BSON undefined deserializes to a present key whose value is `undefined`. */
export const holdsUndefined = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(element => element === undefined || holdsUndefined(element));
  if (value === null || typeof value !== 'object' || value instanceof Date || isBsonValue(value)) return false;
  return Object.values(value).some(field => field === undefined || holdsUndefined(field));
};

const isTimeLimit = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 50;

const scanTopLevel = async (collection: mongo.Collection, timeLimitMs: number): Promise<UndefinedScanResult> => {
  const [result] = await collection
    .aggregate<{ documents: number }>(TOP_LEVEL_PIPELINE, { readPreference: READ_PREFERENCE, maxTimeMS: timeLimitMs })
    .toArray();
  return { status: 'complete', documents: result?.documents ?? 0 };
};

/**
 * Nested values cannot be reached by one server-side expression, so documents are walked here.
 * The time limit covers both the server cursor and the client-side walk.
 */
const scanNested = async (collection: mongo.Collection, timeLimitMs: number): Promise<UndefinedScanResult> => {
  const deadline = Date.now() + timeLimitMs;
  const cursor = collection.find({}, { readPreference: READ_PREFERENCE, maxTimeMS: timeLimitMs, batchSize: 1000 });
  let documents = 0;
  try {
    for await (const document of cursor) {
      if (holdsUndefined(document)) documents += 1;
      if (Date.now() > deadline) return { status: 'incomplete', reason: TIME_LIMIT_REASON };
    }
  } finally {
    await cursor.close();
  }
  return { status: 'complete', documents };
};

export const scanForUndefined = async (
  collection: mongo.Collection,
  mode: 'top-level' | 'nested',
  timeLimitMs: number
): Promise<UndefinedScanResult> => {
  try {
    return mode === 'top-level'
      ? await scanTopLevel(collection, timeLimitMs)
      : await scanNested(collection, timeLimitMs);
  } catch (error) {
    return { status: 'incomplete', reason: isTimeLimit(error) ? TIME_LIMIT_REASON : describeError(error) };
  }
};
