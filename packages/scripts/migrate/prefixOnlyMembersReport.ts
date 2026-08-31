import { isReservedTagPrefix, normalizeTagPrefix } from '@bike4mind/common';

/**
 * Pure classification/rendering for the pre-merge prefix-only-member census
 * (check-datalake-prefix-only-members.ts). Kept free of I/O so the arm-mode
 * classification, the reconcile check and the exit-code decision are unit-testable
 * without a Mongo connection.
 */

export type ArmMode = 'anchored' | 'no-prefix' | 'creator-less' | 'open';

/**
 * The same three fail-closed conditions `buildDataLakeMembershipFilter`
 * (`@bike4mind/database`) collapses to a bare meta-tag arm, kept separate here so the
 * census can tell "genuinely no prefix arm" from "fails closed for a data-quality
 * reason" - both would otherwise print as an indistinguishable `prefixOnly = 0`.
 */
export function classifyDynamicLakeMode(row: {
  fileTagPrefix?: string | null;
  createdByUserId?: string | null;
}): 'anchored' | 'no-prefix' | 'creator-less' {
  const prefix = normalizeTagPrefix(row.fileTagPrefix);
  if (!prefix || isReservedTagPrefix(prefix)) return 'no-prefix';
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
 * expected to always agree; a mismatch means the two queries diverged (e.g. a regex
 * escaping difference), not that the population genuinely differs.
 */
export function reconcilePrefixOnly(total: number, metaTagged: number, prefixOnlyDirect: number): ReconcileResult {
  const expected = total - metaTagged;
  return { expected, actual: prefixOnlyDirect, matches: expected === prefixOnlyDirect };
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
  /** capped example file names for an anchored finding, for owner review. Empty otherwise. */
  prefixOnlyFiles: { fileNames: string[]; truncated: boolean };
  narrowingFiles: { fileNames: string[]; truncated: boolean };
}

/**
 * A lake needs owner sign-off. Anchored lakes escalate only on a nonzero widening OR
 * narrowing count; creator-less lakes escalate unconditionally - the fail-closed reason
 * itself (a dynamic lake with no creator) is a data-quality defect regardless of what its
 * unanchored count happens to be, so it belongs on the same escalation path rather than a
 * footnote. `no-prefix` and `open` never escalate: the first is genuinely zero, the second
 * is already retrievable today.
 */
export function isFinding(lake: LakeReport): boolean {
  if (lake.mode === 'anchored') {
    return (lake.prefixOnlyDirect ?? 0) > 0 || (lake.narrowingUpperBound ?? 0) > 0;
  }
  return lake.mode === 'creator-less';
}

const modeColumn = (lake: LakeReport): string => {
  switch (lake.mode) {
    case 'no-prefix':
      return '0 (no prefix arm)';
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
  const header = `Lake "${lake.name}" (id=${lake.id}, mode=${lake.mode})`;
  lines.push(header);
  if (lake.total !== null) {
    lines.push(
      `  total=${lake.total} totalExcludingPending=${lake.totalExcludingPending} metaTagged=${lake.metaTagged}`
    );
  }
  lines.push(`  prefix-only members: ${modeColumn(lake)}`);
  if (lake.mode === 'anchored') {
    if (lake.reconcileMismatch) {
      lines.push(
        `  RECONCILE: total(${lake.total}) - metaTagged(${lake.metaTagged}) = ${
          (lake.total ?? 0) - (lake.metaTagged ?? 0)
        } but the direct count is ${lake.prefixOnlyDirect} - the two queries disagree, do not trust this lake's numbers.`
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
