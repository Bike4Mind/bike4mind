import { z } from 'zod';

export const SNAPSHOT_FORMAT_VERSION = 1;

export const UNDEFINED_SCAN_MODES = ['off', 'top-level', 'nested'] as const;
export type UndefinedScanMode = (typeof UNDEFINED_SCAN_MODES)[number];

const KeyPairsSchema = z.array(z.tuple([z.string(), z.unknown()]));
const OptionsSchema = z.record(z.string(), z.unknown());

export const IndexEntrySchema = z.object({
  name: z.string(),
  // Pairs, not an object: compound key order is significant and the writer sorts object keys.
  key: KeyPairsSchema,
  options: OptionsSchema,
});
export type IndexEntry = z.infer<typeof IndexEntrySchema>;

export const SearchIndexEntrySchema = z.object({
  name: z.string(),
  type: z.string().nullable(),
  status: z.string().nullable(),
  queryable: z.boolean().nullable(),
  definition: z.unknown(),
});
export type SearchIndexEntry = z.infer<typeof SearchIndexEntrySchema>;

export const SearchIndexListingSchema = z.discriminatedUnion('supported', [
  z.object({ supported: z.literal(true), indexes: z.array(SearchIndexEntrySchema) }),
  z.object({ supported: z.literal(false), reason: z.string() }),
]);
export type SearchIndexListing = z.infer<typeof SearchIndexListingSchema>;

export const CollectionEntrySchema = z.object({
  name: z.string(),
  type: z.string(),
  options: OptionsSchema,
  estimatedCount: z.number().nullable(),
  exactCount: z.number().nullable(),
  indexes: z.array(IndexEntrySchema),
  searchIndexes: SearchIndexListingSchema,
});
export type CollectionEntry = z.infer<typeof CollectionEntrySchema>;

export const InvalidTtlFindingSchema = z.object({
  collection: z.string(),
  index: z.string(),
  expireAfterSeconds: z.unknown(),
});
export type InvalidTtlFinding = z.infer<typeof InvalidTtlFindingSchema>;

export const DeclaredIndexFindingSchema = z.object({
  collection: z.string(),
  models: z.array(z.string()),
  key: KeyPairsSchema,
  options: OptionsSchema,
});
export type DeclaredIndexFinding = z.infer<typeof DeclaredIndexFindingSchema>;

export const UndeclaredIndexFindingSchema = z.object({
  collection: z.string(),
  index: z.string(),
  key: KeyPairsSchema,
  options: OptionsSchema,
});
export type UndeclaredIndexFinding = z.infer<typeof UndeclaredIndexFindingSchema>;

export const OptionMismatchFindingSchema = z.object({
  collection: z.string(),
  index: z.string(),
  models: z.array(z.string()),
  declared: OptionsSchema,
  actual: OptionsSchema,
});
export type OptionMismatchFinding = z.infer<typeof OptionMismatchFindingSchema>;

export const SchemaDriftSchema = z.object({
  missingInDatabase: z.array(DeclaredIndexFindingSchema),
  missingInSchema: z.array(UndeclaredIndexFindingSchema),
  optionMismatches: z.array(OptionMismatchFindingSchema),
  unmodeledCollections: z.array(z.string()),
});
export type SchemaDrift = z.infer<typeof SchemaDriftSchema>;

export const UndefinedValuesSchema = z.object({
  mode: z.enum(['top-level', 'nested']),
  collections: z.array(z.object({ collection: z.string(), documents: z.number() })),
  unfinished: z.array(z.object({ collection: z.string(), reason: z.string() })),
});
export type UndefinedValues = z.infer<typeof UndefinedValuesSchema>;

export const SnapshotSchema = z.object({
  formatVersion: z.literal(SNAPSHOT_FORMAT_VERSION),
  takenAt: z.string(),
  database: z.string(),
  server: z.object({ version: z.string(), replicaSetMembers: z.number().nullable() }),
  settings: z.object({
    exactCounts: z.boolean(),
    schemaCheck: z.boolean(),
    undefinedScan: z.enum(UNDEFINED_SCAN_MODES),
  }),
  collections: z.array(CollectionEntrySchema),
  checks: z.object({
    invalidTtl: z.array(InvalidTtlFindingSchema),
    schemaDrift: SchemaDriftSchema.nullable(),
    undefinedValues: UndefinedValuesSchema.nullable(),
  }),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
