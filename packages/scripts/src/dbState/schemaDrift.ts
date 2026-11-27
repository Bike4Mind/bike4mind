import { canonicalString, toCanonical } from './canonicalJson';
import type {
  DeclaredIndexFinding,
  IndexEntry,
  OptionMismatchFinding,
  SchemaDrift,
  UndeclaredIndexFinding,
} from './snapshotSchema';

/** The slice of a Mongoose model this check reads. Reading it never touches a database. */
export type ModelLike = {
  modelName: string;
  collection: { collectionName: string };
  schema: { indexes(): ReadonlyArray<readonly [object, object?]> };
};

export type DeclaredIndex = DeclaredIndexFinding;

/** Index options that change behaviour; everything else (background, name, v, ...) is ignored. */
const COMPARED_OPTIONS = [
  'unique',
  'sparse',
  'hidden',
  'partialFilterExpression',
  'expireAfterSeconds',
  'collation',
  'weights',
  'default_language',
  'language_override',
] as const;
const FLAG_OPTIONS = new Set(['unique', 'sparse', 'hidden']);
const TEXT_MARKER: [string, unknown] = ['$text', 'text'];
const TEXT_DEFAULTS: Record<string, unknown> = { default_language: 'english', language_override: 'language' };

type Normalized = { signature: string; options: Record<string, unknown> };

const pickComparedOptions = (options: Record<string, unknown>, isText: boolean): Record<string, unknown> => {
  const picked: Record<string, unknown> = {};
  for (const option of COMPARED_OPTIONS) {
    const value = options[option] ?? (isText ? TEXT_DEFAULTS[option] : undefined);
    if (value === undefined || value === null) continue;
    if (FLAG_OPTIONS.has(option) && value !== true) continue;
    picked[option] = toCanonical(value);
  }
  return picked;
};

/** Mongoose declares text fields as `{ title: 'text' }`; the server stores `_fts`/`_ftsx` plus weights. */
const normalizeDeclared = (key: [string, unknown][], options: Record<string, unknown>): Normalized => {
  const textFields = key.filter(([, direction]) => direction === 'text').map(([field]) => field);
  if (textFields.length === 0) {
    return { signature: canonicalString(key), options: pickComparedOptions(options, false) };
  }
  const firstText = key.findIndex(([, direction]) => direction === 'text');
  const pairs = key.filter(([, direction]) => direction !== 'text');
  pairs.splice(firstText, 0, TEXT_MARKER);
  const declaredWeights = (options.weights ?? {}) as Record<string, unknown>;
  const weights = Object.fromEntries(textFields.map(field => [field, declaredWeights[field] ?? 1]));
  return {
    signature: canonicalString(pairs),
    options: pickComparedOptions({ ...options, weights: { ...declaredWeights, ...weights } }, true),
  };
};

const normalizeActual = (index: IndexEntry): Normalized => {
  const isText = index.key.some(([field]) => field === '_fts');
  if (!isText) return { signature: canonicalString(index.key), options: pickComparedOptions(index.options, false) };
  const pairs = index.key.filter(([field]) => field !== '_ftsx').map(pair => (pair[0] === '_fts' ? TEXT_MARKER : pair));
  return { signature: canonicalString(pairs), options: pickComparedOptions(index.options, true) };
};

/** Declared collation fields are a subset; the server fills in the rest of its defaults. */
const optionsMatch = (declared: Record<string, unknown>, actual: Record<string, unknown>): boolean => {
  const keys = new Set([...Object.keys(declared), ...Object.keys(actual)]);
  for (const key of keys) {
    const want = declared[key];
    const have = actual[key];
    if (key === 'collation' && isRecord(want) && isRecord(have)) {
      if (Object.keys(want).some(field => canonicalString(want[field]) !== canonicalString(have[field]))) return false;
      continue;
    }
    if (canonicalString(want) !== canonicalString(have)) return false;
  }
  return true;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One entry per distinct declared index; discriminators share their base collection and indexes. */
export const collectDeclaredIndexes = (models: Iterable<ModelLike>): DeclaredIndex[] => {
  const byIdentity = new Map<string, DeclaredIndex>();
  for (const model of models) {
    const collection = model.collection.collectionName;
    for (const [fields, declaredOptions] of model.schema.indexes()) {
      const key: [string, unknown][] = Object.entries(fields);
      const options: Record<string, unknown> = Object.fromEntries(Object.entries(declaredOptions ?? {}));
      const comparable = normalizeDeclared(key, options);
      const identity = `${collection}\u0000${comparable.signature}\u0000${canonicalString(comparable.options)}`;
      const existing = byIdentity.get(identity);
      if (existing) {
        if (!existing.models.includes(model.modelName)) existing.models.push(model.modelName);
        continue;
      }
      byIdentity.set(identity, {
        collection,
        models: [model.modelName],
        key: key.map(([field, direction]) => [field, toCanonical(direction)]),
        options: pickComparedOptions(options, false),
      });
    }
  }
  return [...byIdentity.values()]
    .map(entry => ({ ...entry, models: [...entry.models].sort() }))
    .sort((a, b) =>
      compareStrings(`${a.collection} ${canonicalString(a.key)}`, `${b.collection} ${canonicalString(b.key)}`)
    );
};

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Matches declared indexes to the database by key, then by the options that change behaviour.
 * Only collections some model maps to are checked for undeclared indexes.
 */
export const checkSchemaDrift = (
  declared: readonly DeclaredIndex[],
  collections: ReadonlyArray<{ name: string; indexes: readonly IndexEntry[] }>
): SchemaDrift => {
  const actualByCollection = new Map(collections.map(c => [c.name, c.indexes.filter(index => index.name !== '_id_')]));
  const declaredCollections = new Set(declared.map(index => index.collection));
  const used = new Set<IndexEntry>();
  const missingInDatabase: DeclaredIndexFinding[] = [];
  const optionMismatches: OptionMismatchFinding[] = [];

  for (const index of declared) {
    const want = normalizeDeclared(index.key, index.options);
    const candidates = (actualByCollection.get(index.collection) ?? [])
      .filter(actual => !used.has(actual))
      .map(actual => ({ actual, normalized: normalizeActual(actual) }))
      .filter(candidate => candidate.normalized.signature === want.signature);
    const exact = candidates.find(candidate => optionsMatch(want.options, candidate.normalized.options));
    if (exact) {
      used.add(exact.actual);
      continue;
    }
    const [mismatch] = candidates;
    if (!mismatch) {
      missingInDatabase.push(index);
      continue;
    }
    used.add(mismatch.actual);
    optionMismatches.push({
      collection: index.collection,
      index: mismatch.actual.name,
      models: index.models,
      declared: want.options,
      actual: mismatch.normalized.options,
    });
  }

  const missingInSchema: UndeclaredIndexFinding[] = [];
  for (const [collection, indexes] of actualByCollection) {
    if (!declaredCollections.has(collection)) continue;
    for (const index of indexes) {
      if (used.has(index)) continue;
      missingInSchema.push({
        collection,
        index: index.name,
        key: index.key,
        options: pickComparedOptions(index.options, false),
      });
    }
  }

  return {
    missingInDatabase,
    missingInSchema: missingInSchema.sort((a, b) =>
      compareStrings(`${a.collection} ${a.index}`, `${b.collection} ${b.index}`)
    ),
    optionMismatches: optionMismatches.sort((a, b) =>
      compareStrings(`${a.collection} ${a.index}`, `${b.collection} ${b.index}`)
    ),
    unmodeledCollections: collections
      .map(c => c.name)
      .filter(name => !declaredCollections.has(name))
      .sort(),
  };
};
