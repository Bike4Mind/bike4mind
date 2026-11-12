// The bundles a dev applies with the tutorial apply script. Built in the browser, so the server needs
// no repository credential: the edits reach code through a person's PR.
import {
  MODULE_BUNDLE_FORMAT,
  OVERRIDE_BUNDLE_FORMAT,
  unitKey,
  type OverrideBundle,
  type TutorialDraftContent,
  type TutorialModuleBundle,
} from '@bike4mind/common';
import type { TutorialModuleOverrideRow } from './adminTypes';

/** Only live units: a retired one is already in the repo, and a stale one was written over text that moved. */
export const liveUnitsOf = (row: TutorialModuleOverrideRow) => {
  const stateOf = new Map(row.report.states.map(s => [s.key, s.state]));
  return row.fields.filter(unit => stateOf.get(unitKey(unit)) === 'live');
};

/** The row carries only the module's latest edit to its fields, so its author and reason stand for every unit. */
export function overrideBundleOf(row: TutorialModuleOverrideRow, owner: string, now: Date): OverrideBundle {
  return {
    format: OVERRIDE_BUNDLE_FORMAT,
    owner,
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

/** A made tutorial as its author left it; the apply script fills its prompts and params as the server does. */
export function moduleBundleOf(content: TutorialDraftContent, owner: string, now: Date): TutorialModuleBundle {
  return { format: MODULE_BUNDLE_FORMAT, owner, moduleId: content.moduleId, exportedAt: now.toISOString(), content };
}

function downloadJson(bundle: object, filename: string): void {
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(bundle, null, 2)}\n`], { type: 'application/json;charset=utf-8' })
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // Revoke on a later tick - some browsers abort the download if revoked synchronously.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadOverrideBundle(row: TutorialModuleOverrideRow, owner: string): void {
  downloadJson(
    overrideBundleOf(row, owner, new Date()),
    `tutorial-${row.moduleId}-v${row.version}r${row.revision}-overrides.json`
  );
}

export function downloadModuleBundle(content: TutorialDraftContent, owner: string): void {
  downloadJson(moduleBundleOf(content, owner, new Date()), `tutorial-${content.moduleId}-module.json`);
}
