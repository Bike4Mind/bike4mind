import type { SubQuestStatus } from '@bike4mind/common';

/**
 * The one glyph/label vocabulary for a sub-quest status, shared by the client-side export
 * (app/utils/questExport.ts) and the queued server-side export
 * (server/queueHandlers/questExport.ts).
 *
 * Both maps used to be declared separately in those two files. Being `Record<SubQuestStatus, …>`
 * meant a NEW status failed the build in both - but a changed GLYPH on one side drifted silently,
 * which is how the server copy sat missing its `deleted` arm while the client copy rendered one.
 * Keys were guarded; values were not. One module closes that.
 *
 * Deliberately dependency-free: the server handler imports this, and pulling in questExport.ts
 * would drag docx/xlsx/papaparse into a Lambda that needs none of them.
 */
export const SUBQUEST_STATUS_ICONS: Record<SubQuestStatus, string> = {
  completed: ' ✓',
  in_progress: ' \u{1F504}',
  not_started: ' ⏳',
  skipped: ' ⏭',
  deleted: ' ❌',
};

export const SUBQUEST_STATUS_LABELS: Record<SubQuestStatus, string> = {
  completed: 'Completed',
  in_progress: 'In Progress',
  not_started: 'Not Started',
  skipped: 'Skipped',
  deleted: 'Deleted',
};

/**
 * Both lookups are total for any string, not just a canonical one. The value arrives off a
 * persisted document and the mongoose enum did not gate the update path for the collection's
 * whole history, so a retired token can still reach here.
 *
 * `Object.hasOwn` rather than `??` or `in`: a plain object literal inherits from
 * Object.prototype, so a status named `constructor`/`toString`/`valueOf` would otherwise resolve
 * to the inherited function and get spliced into an exported heading.
 */
export const getSubQuestStatusIcon = (status: SubQuestStatus): string =>
  Object.hasOwn(SUBQUEST_STATUS_ICONS, status) ? SUBQUEST_STATUS_ICONS[status] : '';

/** Falls back to the raw token: unlabelled beats mislabelled as Not Started. */
export const getSubQuestStatusLabel = (status: SubQuestStatus): string =>
  Object.hasOwn(SUBQUEST_STATUS_LABELS, status) ? SUBQUEST_STATUS_LABELS[status] : status;
