import { canonicalString } from './canonicalJson';
import type { CollectionEntry, IndexEntry, SearchIndexEntry, Snapshot } from './snapshotSchema';

export type CountTolerance = { absolute: number; percent: number };

export type Difference = {
  kind: 'added' | 'removed' | 'changed';
  subject: string;
  detail?: string;
};

export type Comparison = {
  differences: Difference[];
  notes: string[];
  findings: string[];
};

const keyed = <T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T> =>
  new Map(items.map(item => [keyOf(item), item]));

const show = (value: unknown): string => canonicalString(value);

/** Lists the top-level fields whose values differ, as `field: before -> after`. */
const fieldChanges = (before: Record<string, unknown>, after: Record<string, unknown>): string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter(field => show(before[field]) !== show(after[field]))
    .map(
      field =>
        `${field}: ${before[field] === undefined ? '(none)' : show(before[field])} -> ${after[field] === undefined ? '(none)' : show(after[field])}`
    );

const diffKeyed = <T>(
  before: readonly T[],
  after: readonly T[],
  keyOf: (item: T) => string,
  label: (key: string) => string,
  fields: (item: T) => Record<string, unknown>
): Difference[] => {
  const beforeMap = keyed(before, keyOf);
  const afterMap = keyed(after, keyOf);
  const differences: Difference[] = [];
  for (const [key, item] of beforeMap) {
    const next = afterMap.get(key);
    if (!next) {
      differences.push({ kind: 'removed', subject: label(key), detail: show(fields(item)) });
      continue;
    }
    const changes = fieldChanges(fields(item), fields(next));
    if (changes.length > 0) differences.push({ kind: 'changed', subject: label(key), detail: changes.join('; ') });
  }
  for (const [key, item] of afterMap) {
    if (!beforeMap.has(key)) differences.push({ kind: 'added', subject: label(key), detail: show(fields(item)) });
  }
  return differences;
};

const indexFields = (index: IndexEntry): Record<string, unknown> => ({ key: index.key, ...index.options });

const searchIndexFields = (index: SearchIndexEntry): Record<string, unknown> => ({
  type: index.type,
  status: index.status,
  queryable: index.queryable,
  definition: index.definition,
});

export const withinTolerance = (before: number, after: number, tolerance: CountTolerance): boolean => {
  const delta = Math.abs(after - before);
  return delta <= tolerance.absolute || (before > 0 && (delta / before) * 100 <= tolerance.percent);
};

const formatDelta = (before: number, after: number): string => {
  const delta = after - before;
  const sign = delta >= 0 ? '+' : '';
  const percent = before > 0 ? ` (${sign}${((delta / before) * 100).toFixed(1)}%)` : '';
  return `${before} -> ${after}, ${sign}${delta}${percent}`;
};

const diffCounts = (before: CollectionEntry, after: CollectionEntry, tolerance: CountTolerance): Difference[] => {
  const pairs: Array<[string, number | null, number | null]> = [
    ['estimated count', before.estimatedCount, after.estimatedCount],
    ['exact count', before.exactCount, after.exactCount],
  ];
  return pairs.flatMap(([label, from, to]) =>
    from === null || to === null || withinTolerance(from, to, tolerance)
      ? []
      : [{ kind: 'changed' as const, subject: `${label} ${before.name}`, detail: formatDelta(from, to) }]
  );
};

const diffCollection = (before: CollectionEntry, after: CollectionEntry, tolerance: CountTolerance): Difference[] => {
  const name = before.name;
  const differences: Difference[] = [];
  const shape = fieldChanges(
    { type: before.type, options: before.options },
    { type: after.type, options: after.options }
  );
  if (shape.length > 0) differences.push({ kind: 'changed', subject: `collection ${name}`, detail: shape.join('; ') });

  differences.push(
    ...diffKeyed(
      before.indexes,
      after.indexes,
      index => index.name,
      key => `index ${name}.${key}`,
      indexFields
    )
  );

  const beforeSearch = before.searchIndexes;
  const afterSearch = after.searchIndexes;
  if (beforeSearch.supported && afterSearch.supported) {
    differences.push(
      ...diffKeyed(
        beforeSearch.indexes,
        afterSearch.indexes,
        index => index.name,
        key => `search index ${name}.${key}`,
        searchIndexFields
      )
    );
  } else if (beforeSearch.supported !== afterSearch.supported) {
    differences.push({
      kind: 'changed',
      subject: `search index listing ${name}`,
      detail: `${beforeSearch.supported ? 'supported' : 'unsupported'} -> ${afterSearch.supported ? 'supported' : `unsupported (${afterSearch.reason})`}`,
    });
  }

  differences.push(...diffCounts(before, after, tolerance));
  return differences;
};

const diffFindingSet = <T>(
  before: readonly T[] | undefined,
  after: readonly T[] | undefined,
  label: string,
  describe: (item: T) => string
): Difference[] => {
  if (!before || !after) return [];
  const beforeSet = new Set(before.map(describe));
  const afterSet = new Set(after.map(describe));
  return [
    ...[...afterSet]
      .filter(item => !beforeSet.has(item))
      .map(item => ({ kind: 'added' as const, subject: label, detail: item })),
    ...[...beforeSet]
      .filter(item => !afterSet.has(item))
      .map(item => ({ kind: 'removed' as const, subject: label, detail: item })),
  ];
};

const describeTtl = (finding: Snapshot['checks']['invalidTtl'][number]) =>
  `${finding.collection}.${finding.index} expireAfterSeconds=${show(finding.expireAfterSeconds)}`;

const describeKey = (collection: string, key: unknown, options: Record<string, unknown>) =>
  `${collection} ${show(key)}${Object.keys(options).length > 0 ? ` ${show(options)}` : ''}`;

const diffChecks = (before: Snapshot['checks'], after: Snapshot['checks']): Difference[] => [
  ...diffFindingSet(before.invalidTtl, after.invalidTtl, 'invalid TTL', describeTtl),
  ...diffFindingSet(
    before.schemaDrift?.missingInDatabase,
    after.schemaDrift?.missingInDatabase,
    'declared index missing in database',
    finding => describeKey(finding.collection, finding.key, finding.options)
  ),
  ...diffFindingSet(
    before.schemaDrift?.missingInSchema,
    after.schemaDrift?.missingInSchema,
    'database index missing in schema',
    finding => `${finding.collection}.${finding.index} ${show(finding.key)}`
  ),
  ...diffFindingSet(
    before.schemaDrift?.optionMismatches,
    after.schemaDrift?.optionMismatches,
    'index options differ from schema',
    finding =>
      `${finding.collection}.${finding.index} declared ${show(finding.declared)} actual ${show(finding.actual)}`
  ),
  ...diffFindingSet(
    before.undefinedValues?.collections,
    after.undefinedValues?.collections,
    'documents holding undefined',
    finding => `${finding.collection}: ${finding.documents}`
  ),
];

const standingFindings = (snapshot: Snapshot): string[] => {
  const { invalidTtl, schemaDrift, undefinedValues } = snapshot.checks;
  const findings = invalidTtl.map(finding => `invalid TTL: ${describeTtl(finding)}`);
  if (schemaDrift) {
    findings.push(
      ...schemaDrift.missingInDatabase.map(
        f =>
          `declared index missing in database: ${describeKey(f.collection, f.key, f.options)} (${f.models.join(', ')})`
      ),
      ...schemaDrift.missingInSchema.map(
        f => `database index missing in schema: ${f.collection}.${f.index} ${show(f.key)}`
      ),
      ...schemaDrift.optionMismatches.map(
        f =>
          `index options differ from schema: ${f.collection}.${f.index} declared ${show(f.declared)} actual ${show(f.actual)}`
      )
    );
  }
  if (undefinedValues) {
    findings.push(
      ...undefinedValues.collections.map(
        f => `documents holding undefined (${undefinedValues.mode}): ${f.collection}: ${f.documents}`
      ),
      ...undefinedValues.unfinished.map(f => `undefined scan did not finish: ${f.collection} (${f.reason})`)
    );
  }
  return findings;
};

const comparisonNotes = (before: Snapshot, after: Snapshot): string[] => {
  const notes: string[] = [];
  if (before.database !== after.database) notes.push(`database name: ${before.database} -> ${after.database}`);
  const server = fieldChanges(before.server, after.server);
  if (server.length > 0) notes.push(`server ${server.join('; ')}`);
  const settings = fieldChanges(before.settings, after.settings);
  if (settings.length > 0) notes.push(`snapshot settings differ, some checks are not compared: ${settings.join('; ')}`);
  return notes;
};

/**
 * Server details and snapshot settings are reported as notes; every other change counts as a
 * difference. Findings present in the after snapshot are listed whether or not they changed.
 */
export const compareSnapshots = (before: Snapshot, after: Snapshot, tolerance: CountTolerance): Comparison => {
  const afterCollections = keyed(after.collections, c => c.name);
  const differences: Difference[] = [];
  for (const collection of before.collections) {
    const next = afterCollections.get(collection.name);
    if (next) differences.push(...diffCollection(collection, next, tolerance));
    else
      differences.push({
        kind: 'removed',
        subject: `collection ${collection.name}`,
        detail: `type ${collection.type}`,
      });
  }
  const beforeNames = new Set(before.collections.map(c => c.name));
  for (const collection of after.collections) {
    if (!beforeNames.has(collection.name)) {
      differences.push({ kind: 'added', subject: `collection ${collection.name}`, detail: `type ${collection.type}` });
    }
  }
  differences.push(...diffChecks(before.checks, after.checks));
  return { differences, notes: comparisonNotes(before, after), findings: standingFindings(after) };
};

const SYMBOL: Record<Difference['kind'], string> = { added: '+', removed: '-', changed: '~' };

export const formatComparison = (before: Snapshot, after: Snapshot, comparison: Comparison): string => {
  const lines = [
    `Before: ${before.database} at ${before.takenAt} (server ${before.server.version})`,
    `After:  ${after.database} at ${after.takenAt} (server ${after.server.version})`,
    '',
  ];
  if (comparison.notes.length > 0) lines.push('Notes:', ...comparison.notes.map(note => `  ${note}`), '');
  lines.push(`Differences (${comparison.differences.length}):`);
  if (comparison.differences.length === 0) lines.push('  none');
  for (const { kind, subject, detail } of comparison.differences) {
    lines.push(`  ${SYMBOL[kind]} ${subject}${detail ? `: ${detail}` : ''}`);
  }
  lines.push('', `Findings in the after snapshot (${comparison.findings.length}):`);
  if (comparison.findings.length === 0) lines.push('  none');
  lines.push(...comparison.findings.map(finding => `  ${finding}`));
  return lines.join('\n');
};
