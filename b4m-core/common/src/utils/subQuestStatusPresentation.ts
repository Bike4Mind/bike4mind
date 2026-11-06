import type { SubQuestStatus } from '../types/entities/QuestTypes';

/**
 * The one glyph/label vocabulary for a sub-quest status, shared by the client-side export
 * (apps/client/app/utils/questExport.ts), the queued server-side export
 * (apps/workers/src/queueHandlers/questExport.ts) and the markdown serializer in questMarkdown.ts.
 * It lives in @bike4mind/common so the serializer can use it without depending on server-utils;
 * @bike4mind/server-utils/shared/subQuestStatusPresentation re-exports it for existing importers.
 *
 * Both maps used to be declared separately in those two files. Being `Record<SubQuestStatus, ...>`
 * meant a NEW status failed the build in both - but a changed GLYPH on one side drifted silently,
 * which is how the server copy sat missing its `deleted` arm while the client copy rendered one.
 * Keys were guarded; values were not. One module closes that.
 *
 * Deliberately dependency-free: the server handler imports this, and pulling in questExport.ts
 * would drag docx/xlsx/papaparse into a Lambda that needs none of them.
 */
export const SUBQUEST_STATUS_ICONS: Record<SubQuestStatus, string> = {
  completed: ' \u2713',
  in_progress: ' \u{1F504}',
  not_started: ' \u23F3',
  skipped: ' \u23ED',
  deleted: ' \u274C',
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
