import mongoose from 'mongoose';

const { EJSON } = mongoose.mongo.BSON;

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, sortKeys((value as Record<string, unknown>)[key])])
  );
};

/**
 * Converts driver values (Date, ObjectId, Long, NaN, ...) to relaxed Extended JSON with sorted
 * object keys, so equal database state always serializes to the same bytes. Arrays keep their
 * order: callers sort the arrays whose order carries no meaning.
 */
export const toCanonical = (value: unknown): unknown => {
  if (value === undefined) return null;
  return sortKeys(EJSON.serialize(value, { relaxed: true }));
};

export const canonicalString = (value: unknown): string => JSON.stringify(toCanonical(value));

export const stringifySnapshot = (value: unknown): string => `${JSON.stringify(toCanonical(value), null, 2)}\n`;
