import { isReservedTagPrefix, normalizeTagPrefix } from '@bike4mind/common';

/**
 * Pure classification/rendering for the pre-merge prefix-only-member census
 * (check-datalake-prefix-only-members.ts). Kept free of I/O so the arm-mode
 * classification, the reconcile check and the exit-code decision are unit-testable
 * without a Mongo connection.
 */

export type ArmMode = 'anchored' | 'no-prefix' | 'reserved-prefix' | 'creator-less' | 'open';

/**
 * The fail-closed conditions that make an owned-lake membership filter collapse to a bare
 * meta-tag arm, kept separate here so the census can tell "genuinely no prefix arm" from
 * "fails closed for a data-quality reason" - all would otherwise print as an
 * indistinguishable `prefixOnly = 0`.
 *
 * `reserved-prefix` is deliberately NOT folded into `no-prefix`, because the two move in
 * opposite directions across the retrieval-parity fix:
 *  - A prefix that fails `normalizeTagPrefix` (no trailing ":") is dropped by retrieval
 *    TODAY (fabFileSearchQuery normalizes and filters nulls) and by the membership filter
 *    after the fix, so nothing moves - a genuine zero.
 *  - A RESERVED (`datalake:`-namespace) prefix is live at retrieval today and is dropped by
 *    `buildDataLakeMembershipFilter` after the fix, so such a lake loses its whole prefix
 *    arm while a collapsed `0 (no prefix arm)` would report that nothing moves. That is the
 *    exact false zero this census exists to catch, so it escalates on its own.
 *
 * Note that `fileTagPrefix` is `required: true` on DataLakeModel, so for a DYNAMIC lake
 * `no-prefix` still means a malformed stored value, not an absent one. It does not escalate
 * (nothing moves), but the prefix is printed so an operator can see it.
 */
export function classifyDynamicLakeMode(row: {
  fileTagPrefix?: string | null;
  createdByUserId?: string | null;
}): 'anchored' | 'no-prefix' | 'reserved-prefix' | 'creator-less' {
  const prefix = normalizeTagPrefix(row.fileTagPrefix);
  if (!prefix) return 'no-prefix';
  if (isReservedTagPrefix(prefix)) return 'reserved-prefix';
  // createdByUserId: '' is a real (if unusual) stored value, not the same as missing -
  // both must fail closed, so test truthiness rather than `!= null`.
  if (!row.createdByUserId) return 'creator-less';
  return 'anchored';
}

export interface ReconcileResult {
  expected: number;
  actual: number;
  matches: boolean;
}

/**
 * `total` counts the union of the meta-tag arm and the (prefix AND creator) arm;
 * `metaTagged` counts the meta-tag arm alone. By inclusion-exclusion,
 * `total - metaTagged` must equal the count of files that satisfy the prefix arm but
 * NOT the meta arm - exactly what `prefixOnlyDirect` counts directly. The two are
 * expected to agree. A mismatch has two causes, and the census cannot tell them apart:
 * the two queries diverged (e.g. a regex escaping difference), OR the population moved
 * between them - these are three separate unsynchronized `countDocuments` calls with no
 * session and no snapshot, so a single upload/delete/archive landing mid-run shifts one
 * count and not the other. Re-run before believing a mismatch; a real divergence is
 * reproducible and a concurrent write is not.
 */
export function reconcilePrefixOnly(total: number, metaTagged: number, prefixOnlyDirect: number): ReconcileResult {
  const expected = total - metaTagged;
  return { expected, actual: prefixOnlyDirect, matches: expected === prefixOnlyDirect };
}

/**
 * A capped example listing. `userId` is carried per file so the artifact can be split per owner
 * before it is shared - the narrowing set is by definition not the lake creator's, so file names
 * alone leave the cross-tenant half with no owner to split on.
 */
export interface ExampleFileListing {
  files: { userId: string; fileName: string }[];
  truncated: boolean;
}

export interface LakeReport {
  id: string;
  name: string;
  datalakeTag: string;
  fileTagPrefix: string | null | undefined;
  createdByUserId: string | null | undefined;
  mode: ArmMode;
  /** null where not computed (registry lakes have no DataLake document to count against). */
  total: number | null;
  totalExcludingPending: number | null;
  metaTagged: number | null;
  /** anchored only. */
  prefixOnlyDirect: number | null;
  reconcileMismatch: boolean;
  /** anchored only - the narrowing UPPER BOUND (Step 7's fourth count). */
  narrowingUpperBound: number | null;
  /** creator-less | open only - prefix reach with no ownership anchor at all. */
  unanchoredCount: number | null;
  /** capped example files for an anchored finding, for owner review. Empty otherwise. */
  prefixOnlyFiles: ExampleFileListing;
  narrowingFiles: ExampleFileListing;
}

/**
 * A lake needs owner sign-off. Anchored lakes escalate only on a nonzero widening OR
 * narrowing count; creator-less and reserved-prefix lakes escalate unconditionally - the
 * fail-closed reason itself is the defect (a dynamic lake with no creator; a lake whose
 * whole prefix arm disappears across the fix) regardless of what its count happens to be,
 * so both belong on the escalation path rather than in a footnote. `no-prefix` and `open`
 * never escalate: the first moves nothing in either direction (see classifyDynamicLakeMode),
 * the second is already retrievable today.
 */
export function isFinding(lake: LakeReport): boolean {
  if (lake.mode === 'anchored') {
    return (lake.prefixOnlyDirect ?? 0) > 0 || (lake.narrowingUpperBound ?? 0) > 0;
  }
  return lake.mode === 'creator-less' || lake.mode === 'reserved-prefix';
}

const modeColumn = (lake: LakeReport): string => {
  switch (lake.mode) {
    case 'no-prefix':
      return '0 (no prefix arm)';
    case 'reserved-prefix':
      // NOT a member count: a `datalake:`-namespace regex matches every OTHER lake's
      // membership meta-tag, so this figure is inflated by design. See renderLakeLines.
      return `n/a (reserved prefix - whole arm dropped by the fix) - prefix over-match: ${lake.unanchoredCount ?? 0}`;
    case 'creator-less':
      return `n/a (fails closed) - unanchored: ${lake.unanchoredCount ?? 0}`;
    case 'open':
      return `${lake.unanchoredCount ?? 0} (OPEN arm - already retrievable)`;
    case 'anchored':
      return `${lake.prefixOnlyDirect ?? 0}`;
  }
};

export function renderLakeLines(lake: LakeReport): string[] {
  const lines: string[] = [];
  // fileTagPrefix is JSON-quoted, not bare: a value that only LOOKS fine (stray whitespace,
  // a missing trailing ":") is what routes a lake to no-prefix, and bare printing hides it.
  const prefix = lake.fileTagPrefix == null ? '(none)' : JSON.stringify(lake.fileTagPrefix);
  const header = `Lake "${lake.name}" (id=${lake.id}, mode=${lake.mode}, fileTagPrefix=${prefix})`;
  lines.push(header);
  if (lake.total !== null) {
    lines.push(
      `  total=${lake.total} totalExcludingPending=${lake.totalExcludingPending} metaTagged=${lake.metaTagged}`
    );
  }
  lines.push(
    `  prefix-only members: ${modeColumn(lake)}${lake.prefixOnlyFiles.truncated ? ' (truncated listing)' : ''}`
  );
  if (lake.mode === 'anchored') {
    if (lake.reconcileMismatch) {
      lines.push(
        `  RECONCILE: total(${lake.total}) - metaTagged(${lake.metaTagged}) = ${
          (lake.total ?? 0) - (lake.metaTagged ?? 0)
        } but the direct count is ${lake.prefixOnlyDirect} - the two queries disagree, do not trust ` +
          "this lake's numbers. Re-run before acting: the three counts are unsynchronized, so a write " +
          'landing mid-run produces this too. A real divergence reproduces; a concurrent write does not.'
      );
    }
    lines.push(
      `  narrowing upper bound (files this fix makes UNREACHABLE): ${lake.narrowingUpperBound}${
        lake.narrowingFiles.truncated ? ' (truncated listing)' : ''
      }`
    );
    lines.push(
      '    This is an UPPER BOUND, not a per-caller reachability count. A nonzero value is CORRECT ' +
        'behaviour under the new predicate, not a defect - such a file genuinely is not a member of ' +
        'this lake once the prefix arm is anchored to the creator. It exists so an owner can review ' +
        'the population, not so anyone "fixes" it.'
    );
  }
  if (lake.mode === 'reserved-prefix') {
    lines.push(
      '  ESCALATE: this lake\'s fileTagPrefix sits in the reserved "datalake:" namespace. Retrieval honours ' +
        'that prefix TODAY and the fix drops it, so this lake loses its ENTIRE prefix arm - the one shape a ' +
        'collapsed "0 (no prefix arm)" would have hidden. Only meta-tagged files stay reachable.'
    );
    lines.push(
      '    The over-match figure above is NOT a member count and is inflated by design: a "datalake:" regex ' +
        "matches every other lake's membership meta-tag. Treat it as reach, not as narrowing. Note the arm " +
        'being dropped is also an ownership leak, so removing it is a fix - review what this lake loses, not ' +
        'whether the drop is correct.'
    );
  }
  if (lake.mode === 'creator-less') {
    lines.push('  ESCALATE: dynamic lake with no creator on record - legacy row or bad ingest, review before merge.');
  }
  return lines;
}

export interface CensusRenderResult {
  lines: string[];
  exitCode: 0 | 2;
  findingsCount: number;
  reconcileMismatchCount: number;
}

export function renderCensusReport(lakes: LakeReport[], stage: string): CensusRenderResult {
  const lines: string[] = [`Prefix-only member census - stage="${stage}"`, `Scanned ${lakes.length} lake(s).`, ''];
  for (const lake of lakes) {
    lines.push(...renderLakeLines(lake), '');
  }
  const findings = lakes.filter(isFinding);
  const reconcileMismatches = lakes.filter(l => l.reconcileMismatch);
  lines.push(
    findings.length === 0
      ? 'No lake needs owner sign-off.'
      : `${findings.length} lake(s) need owner sign-off before #2254 merges: ${findings.map(l => l.name).join(', ')}`
  );
  return {
    lines,
    exitCode: findings.length === 0 ? 0 : 2,
    findingsCount: findings.length,
    reconcileMismatchCount: reconcileMismatches.length,
  };
}
