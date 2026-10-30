import type { RepositorySite, UpdateCallSite } from './scanUpdateCalls';

/**
 * Constrained paths a schema pre-hook rejects on the query methods in HOOK_COVERED_METHODS, so they
 * hold without `runValidators`. Each entry is probed for real in updateValidatorAudit.test.ts.
 */
export const SCHEMA_HOOK_GATES: Record<string, string[]> = {
  FabFile: ['status', 'moderationStatus', 'chunkStallReason'],
};

// `findByIdAndUpdate` runs the `findOneAndUpdate` middleware. `bulkWrite` and the raw driver run none.
export const HOOK_COVERED_METHODS = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findByIdAndUpdate',
  'replaceOne',
  'findOneAndReplace',
] as const;

export type AuditPath = {
  path: string;
  kinds: string[];
  /** Direct writers that name this path literally. */
  writers: string[];
  /** `schema-hook-partial` = hooked, but the model also has writers the hook never sees. */
  gate: 'schema-hook' | 'schema-hook-partial' | 'none';
};

export type AuditModel = {
  model: string;
  viaRepository: boolean;
  dynamicWriters: string[];
  hookBypassWriters: string[];
  paths: AuditPath[];
};

export type Audit = {
  sitesScanned: number;
  callSiteValidated: string[];
  rawDriver: string[];
  models: AuditModel[];
  constrainedPathTotal: number;
};

const writerLabel = (site: UpdateCallSite) =>
  `${site.file}::${site.writer} (${site.method})${site.gate === 'raw-driver' ? ' (raw driver)' : ''}`;

const NEVER_VALIDATED_NOTE = ' [$inc/$min/$max/$mul: never validated, even with runValidators]';

const overlaps = (written: string, constrained: string) =>
  written === constrained || constrained.startsWith(`${written}.`) || written.startsWith(`${constrained}.`);

export function buildAudit(input: {
  sites: UpdateCallSite[];
  repositories: RepositorySite[];
  constraints: Map<string, Map<string, string[]>>;
  /** Whether BaseRepository's own writers pass `runValidators: true`. */
  baseRepositoryValidates: boolean;
}): Audit {
  const { sites, repositories, constraints, baseRepositoryValidates } = input;
  const repositoryModels = new Set(repositories.flatMap(repository => (repository.model ? [repository.model] : [])));
  const unvalidated = sites.filter(site => site.gate !== 'call-site');

  const models: AuditModel[] = [];
  for (const [model, constrained] of [...constraints].sort(([a], [b]) => a.localeCompare(b))) {
    if (constrained.size === 0) continue;
    const viaRepository = repositoryModels.has(model) && !baseRepositoryValidates;
    const allModelSites = sites.filter(site => site.model === model);
    const modelSites = unvalidated.filter(site => site.model === model);
    const dynamicWriters = [...new Set(modelSites.filter(site => site.dynamic).map(writerLabel))].sort();
    const hookBypassWriters = SCHEMA_HOOK_GATES[model]
      ? [
          ...new Set(
            modelSites.filter(site => site.gate === 'raw-driver' || site.method === 'bulkWrite').map(writerLabel)
          ),
        ].sort()
      : [];

    const paths: AuditPath[] = [];
    for (const [path, kinds] of [...constrained].sort(([a], [b]) => a.localeCompare(b))) {
      const writers = [
        ...new Set([
          ...modelSites.filter(site => site.paths.some(written => overlaps(written, path))).map(writerLabel),
          ...allModelSites
            .filter(site => site.unvalidatablePaths.some(written => overlaps(written, path)))
            .map(site => `${writerLabel(site)}${NEVER_VALIDATED_NOTE}`),
        ]),
      ].sort();
      if (!viaRepository && dynamicWriters.length === 0 && writers.length === 0) continue;
      const hooked = SCHEMA_HOOK_GATES[model]?.includes(path);
      paths.push({
        path,
        kinds,
        writers,
        gate: hooked ? (hookBypassWriters.length > 0 ? 'schema-hook-partial' : 'schema-hook') : 'none',
      });
    }
    if (paths.length > 0) models.push({ model, viaRepository, dynamicWriters, hookBypassWriters, paths });
  }

  const callSiteValidated = [...new Set(sites.filter(site => site.gate === 'call-site').map(writerLabel))].sort();
  const rawDriver = [...new Set(sites.filter(site => site.gate === 'raw-driver').map(writerLabel))].sort();
  return {
    sitesScanned: sites.length,
    callSiteValidated,
    rawDriver,
    models,
    constrainedPathTotal: models.reduce((sum, entry) => sum + entry.paths.length, 0),
  };
}

export function renderAudit(audit: Audit, baseRepositoryValidates: boolean): string {
  const count = (gate: AuditPath['gate']) =>
    audit.models.reduce((sum, entry) => sum + entry.paths.filter(path => path.gate === gate).length, 0);
  const lines: string[] = [
    '# Update validator audit',
    '',
    'Mongoose runs schema validators (enum, maxlength, minlength, min, max, match, custom `validate`) on create and save, but skips them on update calls unless `runValidators: true` is passed. This report lists every constrained schema path that some update call can write without that option, and the gate that actually protects it.',
    '',
    'Generated by `updateValidatorAudit.test.ts`; do not edit by hand. After a deliberate change, regenerate with `pnpm --filter @bike4mind/database exec vitest run src/__test__/updateValidatorAudit -u` and review the diff: a path that gains a gate disappears or changes gate here, and a path that loses one appears.',
    '',
    '## Scope',
    '',
    '- Scanned: every `updateOne`, `updateMany`, `findOneAndUpdate`, `findByIdAndUpdate`, `replaceOne`, `findOneAndReplace` and `bulkWrite` call in non-test source under `packages/database/src/models`, plus the writers in `BaseRepository` (`b4m-core/db-core/src/models/BaseModel.ts`).',
    '- Not scanned: update calls on models made outside `packages/database/src/models`, and the callers of a repository. A repository method that forwards caller data is listed as reachable (`repository`); whether a route schema upstream constrains that data is not verified here.',
    '- `required` is not tracked: it behaves differently on updates, so enabling `runValidators` blindly is not a fix.',
    `- Gates: \`schema-hook\` = a schema pre-hook rejects the value on ${HOOK_COVERED_METHODS.map(method => `\`${method}\``).join(', ')} (probed by the test); \`schema-hook-partial\` = hooked, but the model also has \`bulkWrite\` or raw driver writers the hook never sees; \`none\` = nothing in this package stops an out-of-constraint value.`,
    '- `$inc`, `$min`, `$max` and `$mul` are never validated by Mongoose, so a `min`/`max` path written through one is listed even when the call passes `runValidators: true`.',
    '',
    '## Summary',
    '',
    `- Update call sites scanned: ${audit.sitesScanned}`,
    `- Passing \`runValidators: true\` at the call site: ${audit.callSiteValidated.length} writers`,
    `- Raw driver writes (never validated): ${audit.rawDriver.length} writers`,
    `- BaseRepository writers validate: ${baseRepositoryValidates ? 'yes' : 'no'}`,
    `- Models with a constrained path reachable by an unvalidated writer: ${audit.models.length}`,
    `- Constrained paths reachable that way: ${audit.constrainedPathTotal} (${count('none')} with no gate, ${count('schema-hook-partial')} partly gated by a schema hook, ${count('schema-hook')} fully gated by one)`,
    '',
    '## Writers that pass runValidators: true',
    '',
    ...audit.callSiteValidated.map(label => `- ${label}`),
    '',
    '## Raw driver writers',
    '',
    ...audit.rawDriver.map(label => `- ${label}`),
    '',
    '## Constrained paths by model',
    '',
    'Writer format is `file::enclosing function (method)`. A path with no literal writer is reached only through `repository` or a dynamic writer.',
    '',
  ];

  for (const entry of audit.models) {
    lines.push(`### ${entry.model}`, '');
    if (entry.viaRepository)
      lines.push(
        '- repository: BaseRepository `update`, `updateGuarded` and `updateMany` write any path without validators'
      );
    for (const writer of entry.dynamicWriters) lines.push(`- dynamic payload: ${writer}`);
    for (const writer of entry.hookBypassWriters) lines.push(`- schema hook does not cover: ${writer}`);
    lines.push('', '| Path | Constraints | Literal writers | Gate |', '| --- | --- | --- | --- |');
    for (const row of entry.paths) {
      lines.push(`| ${row.path} | ${row.kinds.join(', ')} | ${row.writers.join('<br>') || '-'} | ${row.gate} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
