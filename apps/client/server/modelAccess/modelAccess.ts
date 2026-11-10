import { randomUUID } from 'crypto';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  UnprocessableEntityError,
  isFullAdmin,
  MODEL_ACCESS_BULK_MAX_IDS,
  type ModelAccessBulkChange,
  type ModelAccessBulkDryRun,
  type ModelAccessBulkItem,
  type ModelAccessBulkResult,
  type ModelAccessPatchRequest,
  type ModelAccessPatchResult,
  type ModelAccessSelection,
} from '@bike4mind/common';
import { bumpModelAccessRevision } from '@bike4mind/server-utils/modelDiscovery/modelAccessRevision';
import { resolveAdminModelFilterIds } from '@server/admin/models/adminModelFilter';
import {
  accessFieldsOf,
  applyAccessChange,
  applyBulkChange,
  audienceEffect,
  buildEntry,
  isAdminOnly,
  nextStamp,
  reachesEveryoneThroughBase,
  sameAccess,
  stampOf,
  toEntryView,
  type AccessFields,
  type StoredAccessEntry,
} from './modelAccessEntries';
import { claimDryRun, commitAccessEntry, readAccessEntries } from './modelAccessStore';
import {
  ACCESS_TOKEN_TTL_MS,
  canonicalJson,
  readAccessToken,
  signAccessToken,
  idsDigest,
  stampsDigest,
} from './modelAccessTokens';

type AccessRequest = Parameters<typeof commitAccessEntry>[0] & {
  user?: { id: string; isAdmin?: boolean | null };
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void };
};

function actorOf(req: AccessRequest): string {
  if (!req.user) throw new ForbiddenError('Authentication required');
  return req.user.id;
}

export const STALE_ENTRY_MESSAGE = "Someone changed this model's access since you opened it. Reload and try again.";
export const ADMIN_ONLY_MESSAGE = 'Only admins will see this model. Confirm to continue.';

/** Model access writes need a full admin: adminApi admits a delegate holding settings:manage. */
export function assertFullAdmin(user: { isAdmin?: boolean | null } | undefined): void {
  if (!isFullAdmin(user)) throw new ForbiddenError('Only full administrators can manage models');
}

/** A bumped revision, or null: the writes have committed, so a failed bump must not fail the request. */
async function bumpRevision(req: AccessRequest): Promise<string | null> {
  try {
    return await bumpModelAccessRevision();
  } catch (error) {
    req.logger?.warn('[model-access] access revision bump failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

const toDate = (stamp: string | null): Date | null => (stamp === null ? null : new Date(stamp));

export async function patchModelAccess(
  req: AccessRequest,
  id: string,
  { change, reason, expectedUpdatedAt, confirmAdminOnly }: ModelAccessPatchRequest
): Promise<ModelAccessPatchResult> {
  const current = (await readAccessEntries()).get(id) ?? null;
  const expected = toDate(expectedUpdatedAt);
  if (stampOf(current) !== (expected ? expected.toISOString() : null)) {
    throw new ConflictError(STALE_ENTRY_MESSAGE, { entry: current ? toEntryView(current) : null });
  }
  const before = accessFieldsOf(current);
  const after = applyAccessChange(before, change);
  // A model with no entry already behaves as the default entry, so a change that matches it writes nothing.
  if (sameAccess(before, after)) {
    return { entry: current ? toEntryView(current) : null, changed: false, revision: null };
  }
  if (isAdminOnly(after) && !confirmAdminOnly) {
    throw new UnprocessableEntityError(ADMIN_ONLY_MESSAGE, { adminOnlyIds: [id] });
  }
  const next = buildEntry(id, after, nextStamp(current?.updatedAt));
  const outcome = await commitAccessEntry(req, { id, expected, before: current, next, reason });
  if (outcome === 'stale') {
    const latest = (await readAccessEntries()).get(id);
    throw new ConflictError(STALE_ENTRY_MESSAGE, { entry: latest ? toEntryView(latest) : null });
  }
  return { entry: toEntryView(next), changed: true, revision: await bumpRevision(req) };
}

/** The sorted ids a selection covers; `{ filter }` resolves to exactly what the model list shows for it. */
async function resolveSelection(selection: ModelAccessSelection): Promise<string[]> {
  if ('ids' in selection) return [...new Set(selection.ids)].sort();
  const ids = [...new Set(await resolveAdminModelFilterIds(selection.filter))].sort();
  if (ids.length === 0) throw new UnprocessableEntityError('No models match this filter.', { matched: 0 });
  if (ids.length > MODEL_ACCESS_BULK_MAX_IDS) {
    throw new UnprocessableEntityError(
      `This filter matches ${ids.length} models. Narrow it to ${MODEL_ACCESS_BULK_MAX_IDS} or fewer.`,
      { matched: ids.length }
    );
  }
  return ids;
}

// Order and repeats in an id list do not change what it selects.
const canonicalSelection = (selection: ModelAccessSelection): string =>
  canonicalJson('ids' in selection ? { ids: [...new Set(selection.ids)].sort() } : selection);

type PlannedItem = { id: string; current: StoredAccessEntry | null; after: AccessFields; changes: boolean };

type Plan = { items: PlannedItem[]; dryRun: ModelAccessBulkDryRun; digest: string; idSet: string };

type DryRunTokenPayload = {
  kind: 'model-access-dry-run';
  jti: string;
  actor: string;
  change: string;
  selection: string;
  ids: string;
  stamps: string;
  exp: number;
};

async function plan(actor: string, selection: ModelAccessSelection, change: ModelAccessBulkChange): Promise<Plan> {
  const ids = await resolveSelection(selection);
  const entries = await readAccessEntries();
  const planned: PlannedItem[] = ids.map(id => {
    const current = entries.get(id) ?? null;
    const before = accessFieldsOf(current);
    const after = applyBulkChange(before, change);
    return { id, current, after, changes: !sameAccess(before, after) };
  });
  const items: ModelAccessBulkItem[] = planned.map(({ id, current, after, changes }) => ({
    id,
    before: current ? toEntryView(current) : null,
    after: { id, ...after },
    changes,
    audience: audienceEffect(accessFieldsOf(current), after),
    everyoneThroughBase: reachesEveryoneThroughBase(after),
    adminOnly: changes && isAdminOnly(after),
  }));
  const changing = items.filter(item => item.changes);
  const adminOnlyIds = changing.filter(item => item.adminOnly).map(item => item.id);
  const digest = stampsDigest(planned.map(({ id, current }) => [id, stampOf(current)]));
  const idSet = idsDigest(ids);
  const exp = Date.now() + ACCESS_TOKEN_TTL_MS;
  const payload: DryRunTokenPayload = {
    kind: 'model-access-dry-run',
    jti: randomUUID(),
    actor,
    change: canonicalJson(change),
    selection: canonicalSelection(selection),
    ids: idSet,
    stamps: digest,
    exp,
  };
  return {
    items: planned,
    digest,
    idSet,
    dryRun: {
      ids,
      items,
      counts: {
        selected: ids.length,
        change: changing.length,
        unchanged: ids.length - changing.length,
        noAudienceChange: changing.filter(item => item.audience === 'none').length,
        adminOnly: adminOnlyIds.length,
      },
      adminOnlyIds,
      token: signAccessToken(payload),
      expiresAt: new Date(exp).toISOString(),
    },
  };
}

export async function dryRunModelAccessBulk(
  actor: string,
  selection: ModelAccessSelection,
  change: ModelAccessBulkChange
): Promise<ModelAccessBulkDryRun> {
  return (await plan(actor, selection, change)).dryRun;
}

const summarize = (updated: number, failed: number) =>
  `Updated ${updated} of ${updated + failed}${failed > 0 ? `. ${failed} failed` : ''}`;

type UndoItem = { id: string; stamp: string; before: (AccessFields & { id: string }) | null };

type UndoTokenPayload = { kind: 'model-access-undo'; actor: string; batchId: string; items: UndoItem[]; exp: number };

type CommitOutcome = { id: string; outcome: 'written' | 'stale' | 'error'; entry?: StoredAccessEntry | null };

async function commitEach(
  req: AccessRequest,
  writes: { id: string; expected: Date | null; before: StoredAccessEntry | null; next: StoredAccessEntry | null }[],
  reason: string,
  details: Record<string, unknown>
): Promise<CommitOutcome[]> {
  const outcomes: CommitOutcome[] = [];
  // One at a time: every entry lives in one document, so concurrent transactions would only conflict.
  for (const write of writes) {
    try {
      const outcome = await commitAccessEntry(req, { ...write, reason, details });
      outcomes.push({ id: write.id, outcome, entry: write.next });
    } catch (error) {
      req.logger?.warn('[model-access] bulk entry write failed', {
        modelId: write.id,
        error: error instanceof Error ? error.message : String(error),
      });
      outcomes.push({ id: write.id, outcome: 'error' });
    }
  }
  return outcomes;
}

async function finishBatch(
  req: AccessRequest,
  batchId: string,
  selected: string[],
  outcomes: CommitOutcome[],
  undoItems: (outcome: CommitOutcome) => UndoItem | null
): Promise<ModelAccessBulkResult> {
  const byId = new Map(outcomes.map(outcome => [outcome.id, outcome]));
  const results: ModelAccessBulkResult['results'] = selected.map(id => {
    const outcome = byId.get(id);
    if (!outcome) return { id, outcome: 'unchanged' };
    if (outcome.outcome === 'written') {
      return { id, outcome: 'updated', entry: outcome.entry ? toEntryView(outcome.entry) : null };
    }
    return { id, outcome: 'failed', reason: outcome.outcome === 'stale' ? 'stamp-moved' : 'write-error' };
  });
  const updated = results.filter(result => result.outcome === 'updated').length;
  const failed = results.filter(result => result.outcome === 'failed').length;
  const undo = outcomes.filter(outcome => outcome.outcome === 'written').map(undoItems);
  const undoPayload: UndoTokenPayload = {
    kind: 'model-access-undo',
    actor: actorOf(req),
    batchId,
    items: undo.filter((item): item is UndoItem => item !== null),
    exp: Date.now() + ACCESS_TOKEN_TTL_MS,
  };
  return {
    batchId,
    results,
    counts: { selected: selected.length, updated, unchanged: selected.length - updated - failed, failed },
    summary: summarize(updated, failed),
    undoToken: undoPayload.items.length > 0 ? signAccessToken(undoPayload) : null,
    revision: updated > 0 ? await bumpRevision(req) : null,
  };
}

/**
 * Apply a dry run. The selection is re-resolved and the stamps re-read; any difference from what the token
 * was minted over (actor, change, selection, id set, a stamp, or expiry) is a 409 carrying a fresh dry run, as
 * is a token already applied once. Entries are then written one by one, each conditional on its stamp, with no
 * transaction across them.
 */
export async function applyModelAccessBulk(
  req: AccessRequest,
  input: {
    selection: ModelAccessSelection;
    change: ModelAccessBulkChange;
    reason: string;
    dryRunToken: string;
    confirmAdminOnly?: boolean;
  }
): Promise<ModelAccessBulkResult> {
  const payload = readAccessToken(input.dryRunToken) as Partial<DryRunTokenPayload> | null;
  if (payload?.kind !== 'model-access-dry-run') {
    throw new BadRequestError('This preview is not valid. Preview the change again.');
  }
  const fresh = await plan(actorOf(req), input.selection, input.change);
  const mismatch =
    payload.actor !== actorOf(req) ||
    payload.change !== canonicalJson(input.change) ||
    payload.selection !== canonicalSelection(input.selection) ||
    payload.ids !== fresh.idSet;
  if (mismatch || typeof payload.jti !== 'string' || typeof payload.exp !== 'number' || payload.exp <= Date.now()) {
    throw new ConflictError('This preview no longer applies. Review the new one and apply again.', {
      dryRun: fresh.dryRun,
    });
  }
  if (payload.stamps !== fresh.digest) {
    throw new ConflictError('Model access changed since the preview. Review the new one and apply again.', {
      dryRun: fresh.dryRun,
    });
  }
  if (fresh.dryRun.adminOnlyIds.length > 0 && !input.confirmAdminOnly) {
    throw new UnprocessableEntityError(ADMIN_ONLY_MESSAGE, { adminOnlyIds: fresh.dryRun.adminOnlyIds });
  }
  // Spent before any write: after an undo restores the stamps, a replay would otherwise pass every check above.
  if (!(await claimDryRun(payload.jti, actorOf(req), ACCESS_TOKEN_TTL_MS))) {
    throw new ConflictError('This preview was already applied. Review the new one and apply again.', {
      dryRun: fresh.dryRun,
    });
  }

  const batchId = randomUUID();
  const writes = fresh.items
    .filter(item => item.changes)
    .map(({ id, current, after }) => ({
      id,
      expected: current?.updatedAt ?? null,
      before: current,
      next: buildEntry(id, after, nextStamp(current?.updatedAt)),
    }));
  const beforeById = new Map(writes.map(write => [write.id, write.before]));
  const outcomes = await commitEach(req, writes, input.reason, { batchId, bulkChange: input.change });
  return finishBatch(req, batchId, fresh.dryRun.ids, outcomes, ({ id, entry }) => {
    if (!entry?.updatedAt) return null;
    const before = beforeById.get(id) ?? null;
    return { id, stamp: entry.updatedAt.toISOString(), before: before && { id, ...accessFieldsOf(before) } };
  });
}

/**
 * Revert a batch: each entry it updated goes back to its access before the batch (or loses the entry the
 * batch created), in one write per entry, conditional on the stamp the batch wrote.
 */
export async function undoModelAccessBatch(
  req: AccessRequest,
  { undoToken, reason }: { undoToken: string; reason: string }
): Promise<ModelAccessBulkResult> {
  const payload = readAccessToken(undoToken) as Partial<UndoTokenPayload> | null;
  if (payload?.kind !== 'model-access-undo' || !Array.isArray(payload.items) || typeof payload.batchId !== 'string') {
    throw new BadRequestError('This undo is not valid.');
  }
  if (payload.actor !== actorOf(req)) throw new ForbiddenError('Only the admin who made this change can undo it');
  if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) {
    throw new ConflictError('This undo has expired. Change the models back from the list.');
  }
  const entries = await readAccessEntries();
  const batchId = randomUUID();
  const writes = payload.items.map(({ id, stamp, before }) => {
    const expected = new Date(stamp);
    return {
      id,
      expected,
      before: entries.get(id) ?? null,
      next: before ? buildEntry(id, accessFieldsOf({ ...before, id }), nextStamp(expected)) : null,
    };
  });
  const outcomes = await commitEach(req, writes, reason, { batchId, undoOf: payload.batchId });
  return finishBatch(
    req,
    batchId,
    writes.map(write => write.id),
    outcomes,
    () => null
  );
}
