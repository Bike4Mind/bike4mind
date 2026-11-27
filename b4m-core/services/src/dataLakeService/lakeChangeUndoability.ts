import {
  LAKE_CONFIG_SNAPSHOT_TTL_DAYS,
  type ILakeConfigChangeEventDocument,
  type ILakeMembershipChangeEventDocument,
} from '@bike4mind/common';
import { REMOVAL_RECORD_TTL_MS } from './removeFileFromDataLake';

export const UNDO_REAPPROVE_NOTE = 'Re-approve from Proposals';
export const UNDO_DELETE_RECREATED_NOTE = 'Delete it from Research';
export const UNDO_FILE_EXPIRED_NOTE = 'Add it again from your files';
export const UNDO_TOO_OLD_MESSAGE = 'This change is too old to undo';

/** What undoing a row does. Absent `plan` means the row has no Undo; `note` says why when a reader can act on it. */
export type UndoPlan =
  | 'update-config'
  | 'create-config'
  | 'delete-config'
  | 'unapprove-proposal'
  | 'decline-proposal'
  | 'restore-proposal'
  | 'remove-file'
  | 'add-file';

export interface UndoClassification {
  plan?: UndoPlan;
  note?: string;
}

type ConfigEventFacts = Pick<
  ILakeConfigChangeEventDocument,
  'action' | 'target' | 'leverChanges' | 'undoesEventId' | 'admittedFabFileId' | 'createdAt'
>;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Which inverse a config event has. Pure and shared by the History view and the undo service, so the
 * button and the handler cannot disagree. Rows from before structured targets existed have no plan.
 */
export function classifyConfigUndo(
  event: ConfigEventFacts,
  now: Date = new Date(),
  /** False when the target config no longer exists (deleted, or recreated under a new id). Unknown is treated as live. */
  targetConfigLive = true
): UndoClassification {
  const target = event.target;
  switch (event.action) {
    case 'update-research-config':
      return target?.kind === 'researchConfig' && event.leverChanges && event.leverChanges.length > 0
        ? { plan: 'update-config' }
        : {};
    case 'create-research-config':
      if (target?.kind !== 'researchConfig') return {};
      // A create that carries `undoesEventId` is a recreate: it has no inverse of its own.
      if (event.undoesEventId) return { note: UNDO_DELETE_RECREATED_NOTE };
      return targetConfigLive ? { plan: 'create-config' } : {};
    case 'delete-research-config':
      if (target?.kind !== 'researchConfig' || !event.leverChanges) return {};
      return now.getTime() - event.createdAt.getTime() > LAKE_CONFIG_SNAPSHOT_TTL_DAYS * DAY_MS
        ? { note: UNDO_TOO_OLD_MESSAGE }
        : { plan: 'delete-config' };
    case 'approve-proposal':
    case 'auto-approve-proposal':
      return target?.kind === 'proposal' ? { plan: 'unapprove-proposal' } : {};
    case 'decline-proposal':
      return target?.kind === 'proposal' ? { plan: 'restore-proposal' } : {};
    case 'restore-proposal':
      if (target?.kind !== 'proposal') return {};
      // An unapprove is recorded as a restore row that names the file it removed.
      if (event.admittedFabFileId) return { note: UNDO_REAPPROVE_NOTE };
      return { plan: 'decline-proposal' };
    default:
      return {};
  }
}

type FileEventFacts = Pick<ILakeMembershipChangeEventDocument, 'action' | 'causedByEventId' | 'createdAt'>;

export function classifyFileUndo(event: FileEventFacts, now: Date = new Date()): UndoClassification {
  // A side effect of another event (an unapprove's removal) is undone by undoing its cause.
  if (event.causedByEventId) return {};
  if (event.action === 'added') return { plan: 'remove-file' };
  return now.getTime() - event.createdAt.getTime() > REMOVAL_RECORD_TTL_MS
    ? { note: UNDO_FILE_EXPIRED_NOTE }
    : { plan: 'add-file' };
}
