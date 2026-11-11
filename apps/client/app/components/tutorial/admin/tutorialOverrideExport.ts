// The bundle a dev applies with scripts/apply-tutorial-override.mjs. Built in the browser, so the server needs
// no repository credential: the edits reach code through a person's PR.
import { OVERRIDE_BUNDLE_FORMAT, unitKey, type OverrideBundle } from '@bike4mind/common';
import type { TutorialModuleOverrideRow } from './adminTypes';

/** Only live units: a retired one is already in the repo, and a stale one was written over text that moved. */
export const liveUnitsOf = (row: TutorialModuleOverrideRow) => {
  const stateOf = new Map(row.report.states.map(s => [s.key, s.state]));
  return row.fields.filter(unit => stateOf.get(unitKey(unit)) === 'live');
};

/** The row carries only the module's latest edit to its fields, so its author and reason stand for every unit. */
export function overrideBundleOf(row: TutorialModuleOverrideRow, now: Date): OverrideBundle {
  return {
    format: OVERRIDE_BUNDLE_FORMAT,
    moduleId: row.moduleId,
    version: row.version,
    revision: row.revision,
    exportedAt: now.toISOString(),
    units: liveUnitsOf(row),
    changes: row.lastFieldsChange
      ? [{ author: row.lastFieldsChange.actorId, reason: row.lastFieldsChange.reason, at: row.lastFieldsChange.at }]
      : [],
  };
}

export function downloadOverrideBundle(row: TutorialModuleOverrideRow): void {
  const bundle = overrideBundleOf(row, new Date());
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(bundle, null, 2)}\n`], { type: 'application/json;charset=utf-8' })
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `tutorial-${row.moduleId}-v${row.version}r${row.revision}-overrides.json`;
  link.click();
  // Revoke on a later tick - some browsers abort the download if revoked synchronously.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
