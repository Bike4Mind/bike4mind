import { Types } from 'mongoose';
import {
  ConflictError,
  feedLabel,
  type IDataLakeProposalDocument,
  type IDataLakeProposalRepository,
  type IDataLakeResearchConfigDocument,
  type IDataLakeResearchConfigRepository,
  type IFabFileRepository,
  type ILakeConfigChangeEventDocument,
  type ILakeConfigChangeEventRepository,
  type ILakeConfigLeverChange,
  type ILakeConfigSnapshotRepository,
  type ILakeConfigUndoClaimRepository,
  type ILakeMembershipChangeEventDocument,
  type ILakeMembershipChangeEventRepository,
  type ILakeMembershipRemovalRepository,
  type LakeConfigUndoResult,
} from '@bike4mind/common';
import { HTTPError, NotFoundError } from '@bike4mind/utils';
import { LEVER_EQUALITY, researchConfigStateOf } from '../dataLakeResearchService/researchConfigChanges';
import { RESEARCH_CONFIGS_PER_LAKE_MAX, type ResearchScheduleDraft } from '../dataLakeResearchService/researchConfigs';
import type { ResearchLeversDraft } from '../dataLakeResearchService/researchLevers';
import { toLakeConfigHistoryEntry, toLakeFileHistoryEntry } from './assembleLakeConfigHistory';
import {
  UNDO_FILE_EXPIRED_NOTE,
  UNDO_TOO_OLD_MESSAGE,
  classifyConfigUndo,
  classifyFileUndo,
  type UndoPlan,
} from './lakeChangeUndoability';

/** Links the History row an inverse action writes back to the event it reverses. */
export interface UndoAudit {
  undoesEventId: string;
  /** Pre-minted, so the row can be named before it is written. */
  eventId: string;
}

type ConfigInput = { name?: string } & ResearchScheduleDraft & ResearchLeversDraft;

/**
 * The inverse actions, each bound by the caller to the real service with the actor, grants and
 * adapters already applied. Going through the service is what keeps its own manage check, validation
 * and audit write in force for an undo.
 */
export type UndoConfigInput = ConfigInput;

export interface UndoActions {
  updateResearchConfig(configId: string, input: ConfigInput, audit: UndoAudit): Promise<unknown>;
  setSchedulePaused(configId: string, paused: boolean, audit: UndoAudit): Promise<unknown>;
  createResearchConfig(input: ConfigInput & { name: string }, audit: UndoAudit): Promise<unknown>;
  deleteResearchConfig(configId: string, audit: UndoAudit): Promise<unknown>;
  declineProposal(proposalId: string, audit: UndoAudit): Promise<unknown>;
  restoreProposal(proposalId: string, audit: UndoAudit): Promise<unknown>;
  unapproveProposal(proposalId: string, audit: UndoAudit, admittedFabFileId?: string): Promise<unknown>;
  removeFile(fabFileId: string, audit: UndoAudit): Promise<unknown>;
  addFile(fabFileId: string, audit: UndoAudit): Promise<unknown>;
}

export interface UndoLakeConfigChangeAdapters {
  db: {
    lakeConfigChangeEvents: Pick<ILakeConfigChangeEventRepository, 'findOne' | 'count'>;
    lakeMembershipChangeEvents: Pick<ILakeMembershipChangeEventRepository, 'findOne' | 'count'>;
    lakeConfigUndoClaims: Pick<ILakeConfigUndoClaimRepository, 'claim' | 'release'>;
    lakeConfigSnapshots: Pick<ILakeConfigSnapshotRepository, 'findLive'>;
    lakeMembershipRemovals: Pick<ILakeMembershipRemovalRepository, 'findLive'>;
    dataLakeResearchConfigs: Pick<IDataLakeResearchConfigRepository, 'findByIdInLake' | 'listByLake'>;
    dataLakeProposals: Pick<IDataLakeProposalRepository, 'findById' | 'countPendingByLakes'>;
    /** Absent: the result entry for a file row carries no name. */
    fabFiles?: Pick<IFabFileRepository, 'find'>;
  };
  actions: UndoActions;
  now?: Date;
}

const isObjectIdShaped = (id: string): boolean => /^[0-9a-fA-F]{24}$/.test(id);

const LEVER_PROSE: Record<string, string> = {
  name: 'name',
  cadence: 'schedule',
  reviewBacklogLimit: 'review backlog limit',
  schedulePaused: 'pause',
  feedUrl: 'feed address',
  itemRules: 'item rules',
};
const leverProse = (lever: string): string =>
  LEVER_PROSE[lever] ?? lever.replace(/[A-Z]/g, ch => ` ${ch.toLowerCase()}`);

/** A value as it may be shown in a refusal: a feed address by origin and path only, long lists by count. */
function showValue(lever: string, value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (lever === 'feedUrl' && typeof value === 'string') return feedLabel(value);
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? 'entry' : 'entries'}`;
  return String(value);
}

const driftError = (lever: string, current: unknown): ConflictError =>
  new ConflictError(`The ${leverProse(lever)} has changed since this edit (now ${showValue(lever, current)})`, {
    field: lever,
    current: showValue(lever, current),
  });

/**
 * A re-validation refusal from the inverse action (the old value no longer passes today's checks, or
 * the config or proposal is gone) becomes a 409 that names the blocking field and its current value.
 */
function asRefusal(err: unknown, current?: IDataLakeResearchConfigDocument | null): unknown {
  if (err instanceof NotFoundError) return new ConflictError('This change can no longer be undone: its target is gone');
  if (!(err instanceof HTTPError) || err.statusCode !== 400) return err;
  const field = typeof err.additionalInfo?.field === 'string' ? err.additionalInfo.field : undefined;
  if (!field || !current) return new ConflictError(err.message, field ? { field } : undefined);
  const currentValue = (current as unknown as Record<string, unknown>)[field];
  return new ConflictError(`${err.message} (the ${leverProse(field)} is now ${showValue(field, currentValue)})`, {
    field,
    current: showValue(field, currentValue),
  });
}

type LoadedEvent =
  | { stream: 'config'; event: ILakeConfigChangeEventDocument }
  | { stream: 'file'; event: ILakeMembershipChangeEventDocument };

async function loadEvent(
  eventId: string,
  lakeId: string,
  db: UndoLakeConfigChangeAdapters['db']
): Promise<LoadedEvent> {
  if (!isObjectIdShaped(eventId)) throw new NotFoundError('History entry not found');
  const config = await db.lakeConfigChangeEvents.findOne({ _id: eventId, dataLakeId: lakeId });
  if (config) return { stream: 'config', event: config };
  const file = await db.lakeMembershipChangeEvents.findOne({ _id: eventId, dataLakeId: lakeId });
  if (file) return { stream: 'file', event: file };
  throw new NotFoundError('History entry not found');
}

const NO_UNDO_MESSAGE = 'This change cannot be undone';

/** A later event aimed at the same target means the world moved on, so this one is not undone blindly. */
async function assertNoLaterConfigEvent(
  event: ILakeConfigChangeEventDocument,
  lakeId: string,
  db: UndoLakeConfigChangeAdapters['db']
): Promise<void> {
  if (!event.target) return;
  const later = await db.lakeConfigChangeEvents.count({
    dataLakeId: lakeId,
    'target.id': event.target.id,
    _id: { $ne: event.id },
    createdAt: { $gte: event.createdAt },
  });
  if (later > 0) throw new ConflictError('A later change touched the same item, so this one cannot be undone');
}

async function assertNoLaterFileEvent(
  event: ILakeMembershipChangeEventDocument,
  lakeId: string,
  db: UndoLakeConfigChangeAdapters['db']
): Promise<void> {
  const later = await db.lakeMembershipChangeEvents.count({
    dataLakeId: lakeId,
    fabFileId: event.fabFileId,
    _id: { $ne: event.id },
    createdAt: { $gte: event.createdAt },
  });
  if (later > 0) throw new ConflictError('A later change touched the same file, so this one cannot be undone');
}

/** Adding or removing the approved file after the approval means unapproving would act on a changed file. */
async function assertApprovedFileUntouched(
  event: ILakeConfigChangeEventDocument,
  lakeId: string,
  db: UndoLakeConfigChangeAdapters['db']
): Promise<void> {
  if (!event.admittedFabFileId) return;
  const later = await db.lakeMembershipChangeEvents.count({
    dataLakeId: lakeId,
    fabFileId: event.admittedFabFileId,
    createdAt: { $gte: event.createdAt },
  });
  if (later > 0) {
    throw new ConflictError('The approved file was added or removed after this approval, so it cannot be undone');
  }
}

const SCHEDULE_LEVERS = new Set(['name', 'cadence', 'reviewBacklogLimit', 'schedulePaused']);

function currentLeverValue(config: IDataLakeResearchConfigDocument, lever: string): unknown {
  const state = researchConfigStateOf(config);
  if (lever === 'name') return state.name;
  if (lever === 'cadence') return state.cadence;
  if (lever === 'reviewBacklogLimit') return state.reviewBacklogLimit;
  if (lever === 'schedulePaused') return state.schedulePaused;
  return (state.levers as unknown as Record<string, unknown>)[lever] ?? null;
}

function leverMatches(lever: string, current: unknown, expected: unknown): boolean {
  if (SCHEDULE_LEVERS.has(lever)) return current === expected;
  const compare = LEVER_EQUALITY[lever as keyof typeof LEVER_EQUALITY] as
    ((a: unknown, b: unknown) => boolean) | undefined;
  return compare ? compare(current, expected) : current === expected;
}

async function undoUpdateConfig(
  event: ILakeConfigChangeEventDocument,
  lakeId: string,
  audit: UndoAudit,
  { db, actions }: UndoLakeConfigChangeAdapters
): Promise<string[]> {
  const configId = event.target!.id;
  const levers: ILakeConfigLeverChange[] = event.leverChanges ?? [];
  const config = await db.dataLakeResearchConfigs.findByIdInLake(configId, lakeId);
  if (!config) throw new ConflictError('This research configuration no longer exists');

  const snapshot = levers.some(l => l.lever === 'feedUrl')
    ? await db.lakeConfigSnapshots.findLive(lakeId, event.id)
    : null;
  if (levers.some(l => l.lever === 'feedUrl') && !snapshot) throw new ConflictError(UNDO_TOO_OLD_MESSAGE);

  for (const { lever, after } of levers) {
    const current = currentLeverValue(config, lever);
    const expected = lever === 'feedUrl' ? (snapshot?.feedUrlAfter ?? null) : after;
    if (!leverMatches(lever, current, expected)) throw driftError(lever, current);
  }

  const input: Record<string, unknown> = {};
  for (const { lever, before } of levers) {
    input[lever] = lever === 'feedUrl' ? (snapshot?.feedUrlBefore ?? null) : before;
  }
  try {
    if (levers.length === 1 && levers[0].lever === 'schedulePaused') {
      await actions.setSchedulePaused(configId, levers[0].before === true, audit);
    } else {
      await actions.updateResearchConfig(configId, input as ConfigInput, audit);
    }
  } catch (err) {
    throw asRefusal(err, config);
  }
  return [];
}

async function undoCreateConfig(
  event: ILakeConfigChangeEventDocument,
  lakeId: string,
  audit: UndoAudit,
  adapters: UndoLakeConfigChangeAdapters
): Promise<string[]> {
  const { db, actions } = adapters;
  const configId = event.target!.id;
  const config = await db.dataLakeResearchConfigs.findByIdInLake(configId, lakeId);
  if (!config) throw new ConflictError('This research configuration no longer exists');
  await assertNoLaterConfigEvent(event, lakeId, db);
  try {
    await actions.deleteResearchConfig(configId, audit);
  } catch (err) {
    throw asRefusal(err, config);
  }
  return [];
}

async function undoDeleteConfig(
  event: ILakeConfigChangeEventDocument,
  lakeId: string,
  audit: UndoAudit,
  { db, actions }: UndoLakeConfigChangeAdapters
): Promise<string[]> {
  const snapshot = await db.lakeConfigSnapshots.findLive(lakeId, event.id);
  if (snapshot?.kind !== 'config-deleted' || !snapshot.config) throw new ConflictError(UNDO_TOO_OLD_MESSAGE);

  const existing = await db.dataLakeResearchConfigs.listByLake(lakeId);
  if (existing.length >= RESEARCH_CONFIGS_PER_LAKE_MAX) {
    throw new ConflictError(`This lake already has ${RESEARCH_CONFIGS_PER_LAKE_MAX} research configurations`);
  }

  const state = researchConfigStateOf(snapshot.config as unknown as IDataLakeResearchConfigDocument);
  const {
    allowedDomains: _derived,
    schedulePaused: _paused,
    ...levers
  } = state.levers as typeof state.levers & {
    schedulePaused?: boolean;
  };
  const input: ConfigInput & { name: string } = {
    ...levers,
    name: state.name,
    cadence: state.cadence,
    reviewBacklogLimit: state.reviewBacklogLimit,
    // resolveSchedulePaused refuses a pause on a config with no cadence.
    ...(state.cadence !== 'off' && state.schedulePaused ? { schedulePaused: true } : {}),
  };
  try {
    await actions.createResearchConfig(input, audit);
  } catch (err) {
    throw asRefusal(err, null);
  }
  return [];
}

async function loadBoundProposal(
  proposalId: string,
  lakeId: string,
  db: UndoLakeConfigChangeAdapters['db']
): Promise<IDataLakeProposalDocument> {
  const proposal = await db.dataLakeProposals.findById(proposalId);
  if (!proposal || proposal.dataLakeId !== lakeId) throw new NotFoundError('History entry not found');
  return proposal;
}

async function backlogHoldNotes(lakeId: string, { db }: UndoLakeConfigChangeAdapters): Promise<string[]> {
  const [configs, pending] = await Promise.all([
    db.dataLakeResearchConfigs.listByLake(lakeId),
    db.dataLakeProposals.countPendingByLakes([lakeId]),
  ]);
  const pendingCount = pending[lakeId] ?? 0;
  const held = configs.filter(
    c =>
      (c.cadence ?? 'off') !== 'off' && c.schedulePaused !== true && pendingCount >= (c.reviewBacklogLimit ?? Infinity)
  );
  return held.length > 0
    ? [
        `The proposal is back in the review queue, so scheduled research is on hold for ${held
          .map(c => `"${c.name}"`)
          .join(', ')} until the queue is below its limit.`,
      ]
    : [];
}

/**
 * Reverse one History row. The caller has already confirmed the actor may manage `lake`; each inverse
 * action then applies its own service's checks again.
 *
 * Order: bind the event to the lake (404 for a foreign or malformed id), take the one-undo claim,
 * check drift, act. The claim is released on any refusal or failure and kept only on success, so a
 * refusal that names a blocking field can be retried once the user fixes it. The History row the
 * action writes is best-effort and never the guard; the claim is the source of truth for "Undone".
 */
export async function undoLakeConfigChange(
  eventId: string,
  lake: { id: string },
  adapters: UndoLakeConfigChangeAdapters
): Promise<LakeConfigUndoResult> {
  const { db, now = new Date() } = adapters;
  const loaded = await loadEvent(eventId, lake.id, db);
  const classification =
    loaded.stream === 'config' ? classifyConfigUndo(loaded.event, now) : classifyFileUndo(loaded.event, now);
  if (!classification.plan) {
    throw new ConflictError(classification.note ?? NO_UNDO_MESSAGE);
  }
  const plan: UndoPlan = classification.plan;

  // Lake binding beyond the event itself: a live config is read through its lake-scoped lookup, a
  // proposal by its own dataLakeId, a deleted config's snapshot is keyed by lake.
  if (
    loaded.stream === 'config' &&
    (plan === 'unapprove-proposal' || plan === 'decline-proposal' || plan === 'restore-proposal')
  ) {
    await loadBoundProposal(loaded.event.target!.id, lake.id, db);
  }

  const undoEventId = new Types.ObjectId().toHexString();
  const audit: UndoAudit = { undoesEventId: eventId, eventId: undoEventId };

  if (!(await db.lakeConfigUndoClaims.claim(lake.id, eventId, undoEventId))) {
    throw new ConflictError('Already undone');
  }

  let notes: string[] = [];
  try {
    notes = await perform(plan, loaded, lake.id, audit, adapters);
  } catch (err) {
    await db.lakeConfigUndoClaims.release(lake.id, eventId).catch(() => undefined);
    throw err;
  }

  return { entry: await loadResultEntry(streamOfResult(plan), undoEventId, lake.id, db, now), notes };
}

const streamOfResult = (plan: UndoPlan): 'config' | 'file' =>
  plan === 'remove-file' || plan === 'add-file' ? 'file' : 'config';

async function perform(
  plan: UndoPlan,
  loaded: LoadedEvent,
  lakeId: string,
  audit: UndoAudit,
  adapters: UndoLakeConfigChangeAdapters
): Promise<string[]> {
  const { db, actions } = adapters;
  if (loaded.stream === 'file') {
    const { event } = loaded;
    await assertNoLaterFileEvent(event, lakeId, db);
    if (plan === 'add-file') {
      if (!(await db.lakeMembershipRemovals.findLive(lakeId, event.fabFileId))) {
        throw new ConflictError(UNDO_FILE_EXPIRED_NOTE);
      }
      try {
        await actions.addFile(event.fabFileId, audit);
      } catch (err) {
        throw asRefusal(err, null);
      }
    } else {
      try {
        await actions.removeFile(event.fabFileId, audit);
      } catch (err) {
        throw asRefusal(err, null);
      }
    }
    return [];
  }

  const { event } = loaded;
  switch (plan) {
    case 'update-config':
      return undoUpdateConfig(event, lakeId, audit, adapters);
    case 'create-config':
      return undoCreateConfig(event, lakeId, audit, adapters);
    case 'delete-config':
      return undoDeleteConfig(event, lakeId, audit, adapters);
    case 'unapprove-proposal': {
      const proposal = await loadBoundProposal(event.target!.id, lakeId, db);
      if (proposal.status !== 'approved') throw new ConflictError('This proposal is no longer approved');
      await assertNoLaterConfigEvent(event, lakeId, db);
      await assertApprovedFileUntouched(event, lakeId, db);
      try {
        await actions.unapproveProposal(proposal.id, audit, event.admittedFabFileId);
      } catch (err) {
        throw asRefusal(err);
      }
      return backlogHoldNotes(lakeId, adapters);
    }
    case 'restore-proposal': {
      const proposal = await loadBoundProposal(event.target!.id, lakeId, db);
      if (proposal.status !== 'declined') throw new ConflictError('This proposal is no longer declined');
      await assertNoLaterConfigEvent(event, lakeId, db);
      try {
        await actions.restoreProposal(proposal.id, audit);
      } catch (err) {
        throw asRefusal(err);
      }
      return backlogHoldNotes(lakeId, adapters);
    }
    case 'decline-proposal': {
      const proposal = await loadBoundProposal(event.target!.id, lakeId, db);
      if (proposal.status !== 'pending') throw new ConflictError('This proposal has already been reviewed');
      await assertNoLaterConfigEvent(event, lakeId, db);
      try {
        await actions.declineProposal(proposal.id, audit);
      } catch (err) {
        throw asRefusal(err);
      }
      return [];
    }
    default:
      throw new ConflictError(NO_UNDO_MESSAGE);
  }
}

/** A deleted or unknown file has no name to show, so the entry stays unnamed. */
async function findFileName(fabFileId: string, db: UndoLakeConfigChangeAdapters['db']): Promise<string | undefined> {
  if (!db.fabFiles || !isObjectIdShaped(fabFileId)) return undefined;
  const [file] = await db.fabFiles.find({ _id: { $in: [fabFileId] } });
  return file && !file.deletedAt && file.fileName ? file.fileName : undefined;
}

async function loadResultEntry(
  stream: 'config' | 'file',
  undoEventId: string,
  lakeId: string,
  db: UndoLakeConfigChangeAdapters['db'],
  now: Date
): Promise<LakeConfigUndoResult['entry']> {
  try {
    if (stream === 'file') {
      const row = await db.lakeMembershipChangeEvents.findOne({ _id: undoEventId, dataLakeId: lakeId });
      if (!row) return null;
      const fileName = await findFileName(row.fabFileId, db);
      return {
        ...toLakeFileHistoryEntry(row),
        ...(fileName ? { fileName } : {}),
        undoable: !!classifyFileUndo(row, now).plan,
      };
    }
    const row = await db.lakeConfigChangeEvents.findOne({ _id: undoEventId, dataLakeId: lakeId });
    return row ? { ...toLakeConfigHistoryEntry(row), undoable: !!classifyConfigUndo(row, now).plan } : null;
  } catch {
    // The undo has landed; a failed read-back must not report it as failed.
    return null;
  }
}
