import type {
  IDataLakeCorpusAction,
  IDataLakeCorpusActionRepository,
  IDataLakeFindingDocument,
  IDataLakeFindingRepository,
  IFabFileRepository,
  LakeAuditPrincipal,
  LakeCorpusAction,
  LakeCorpusActionTarget,
} from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import type { IDataLakeDocument } from '@bike4mind/common';
import { assertLakeWritable } from './assertLakeAccess';
import { loadActiveLakeGrants } from './authorizeLakeManage';
import { canManageLake, resolveLakeManageRung } from './manageRule';
import { lakeMembershipSignals, type MembershipActor } from './lakeMembership';
import { removeFileFromDataLake, type RemoveFileFromDataLakeAdapters } from './removeFileFromDataLake';
import { setDataLakeFileTags, type SetDataLakeFileTagsAdapters } from './setDataLakeFileTags';
import { datalakeTagsFrom } from './getDataLakePrompts';

/**
 * The corpus half of finding triage (#3046): a curator who has decided which of two conflicting
 * passages is right, acting on it.
 *
 * COMPOSES, never reimplements. Each action delegates to the door that already owns that mutation,
 * so a member removed here mints the same 30-minute restore record as one removed from the browse,
 * a retag runs the same prefix gate and admission contract as the tag door, and a supersede writes
 * the marker `partitionBySupersession` (#2235) already collapses on rather than a second collapse
 * of its own. This module's own content is the three things none of those doors can know: that the
 * action answers a FINDING, that its targets are bounded by that finding, and that it is audited.
 *
 * CURATOR-INITIATED, AND STRUCTURALLY SO. Three properties enforce it, none of them a convention:
 *
 *  1. Every action requires a `findingId` that resolves to an OPEN finding in this lake. A detector
 *     produces findings; it has nothing to hand this that would let it act on one.
 *  2. Every targeted document must be cited in that finding's own `sources`. A caller cannot reach
 *     a document the finding does not implicate, so the blast radius of any single call is the
 *     handful of documents a human was looking at.
 *  3. The audit row carries a resolved manage rung, which comes from an actor with a real lake-side
 *     relationship. There is no `system` rung here - see `assertCuratorRung`.
 *
 * NOTHING SCHEDULED MAY CALL THIS. The detector (`detectLakeInconsistencies`), the recorder
 * (`recordLakeFindings`) and every queue handler are forbidden from reaching it, which
 * `applyCorpusAction.guardrail.test.ts` asserts by scanning the repository for importers rather
 * than trusting this paragraph.
 */

/** Keep one document, drop the others' membership of this lake. */
export interface MergeCorpusAction {
  action: 'merge';
  keepFabFileId: string;
  retireFabFileIds: string[];
}

/** Keep both documents, retire one from ranking behind the other. */
export interface SupersedeCorpusAction {
  action: 'supersede';
  /** The current generation. Stays servable and becomes the ruling's winner. */
  keepFabFileId: string;
  /** The retired generation. Leaves ranking, stays in the corpus and stays retrievable by id. */
  retireFabFileId: string;
}

/** Drop a supersede ruling, returning the document to ranking. The undo for `supersede`. */
export interface UnsupersedeCorpusAction {
  action: 'unsupersede';
  fabFileId: string;
}

/** Rewrite one document's tags under this lake's prefix. */
export interface RetagCorpusAction {
  action: 'retag';
  fabFileId: string;
  /** The COMPLETE desired set under the lake's prefix - `setDataLakeFileTags` is replace semantics. */
  tags: string[];
}

export type CorpusActionRequest = (
  MergeCorpusAction | SupersedeCorpusAction | UnsupersedeCorpusAction | RetagCorpusAction
) & {
  /** The curator's note, recorded on the audit row. */
  note?: string;
};

export interface ApplyCorpusActionAdapters {
  db: RemoveFileFromDataLakeAdapters['db'] &
    SetDataLakeFileTagsAdapters['db'] & {
      // Required here, though the shared interface declares them optional (see the field's own
      // doc comment in FabFileTypes.ts) - this door cannot function without a real implementation.
      fabFiles: Required<Pick<IFabFileRepository, 'setLakeSupersession' | 'clearLakeSupersession'>>;
      dataLakeFindings: Pick<IDataLakeFindingRepository, 'findById'>;
      dataLakeCorpusActions: Pick<IDataLakeCorpusActionRepository, 'record'>;
    };
  logger?: {
    warn?: (msg: string, ...args: unknown[]) => void;
    log?: (msg: string, ...args: unknown[]) => void;
    error?: (msg: string, ...args: unknown[]) => void;
  };
}

/** How many times the audit write is retried before the failure is surfaced. */
const AUDIT_RECORD_ATTEMPTS = 3;

export interface ApplyCorpusActionResult {
  action: LakeCorpusAction;
  findingId: string;
  targets: LakeCorpusActionTarget[];
  /** Whatever the delegated door reported, passed through so a surface can render the real outcome. */
  detail: Record<string, unknown>;
}

/**
 * The actor, plus what only a route can resolve about how it is acting. Mirrors the shape the
 * membership-decision door takes, so a curator's corpus action and their duplicate ruling describe
 * the same principal the same way.
 */
export type CorpusActionActor = MembershipActor & { auditPrincipal?: LakeAuditPrincipal };

/**
 * `system` is not a curator. It is what `recordLakeConfigChange` stamps when no principal drove a
 * write, so admitting it here would be admitting exactly the unattended path the issue forbids -
 * and `resolveLakeManageRung` never produces it, so this can only fire on a future caller that
 * invented one.
 */
function assertCuratorRung(
  lake: Pick<IDataLakeDocument, 'createdByUserId' | 'organizationId'>,
  actor: CorpusActionActor,
  grants: Parameters<typeof resolveLakeManageRung>[2]
) {
  const rung = resolveLakeManageRung(lake, actor, grants);
  if (!rung || rung === 'system') {
    throw new BadRequestError("You do not have permission to change this data lake's corpus");
  }
  return rung;
}

/** The principal the audit records. Falls back to the acting user, matching `recordLakeConfigChange`. */
function auditPrincipalFor(actor: CorpusActionActor): LakeAuditPrincipal {
  return (
    actor.auditPrincipal ?? {
      principalKind: 'user',
      principalId: actor.userId,
    }
  );
}

/** Ids this finding cites. The bound on what any single action may touch - see property 2 above. */
function citedFabFileIds(finding: IDataLakeFindingDocument): Set<string> {
  return new Set(finding.sources.map(s => s.fabFileId));
}

function assertCited(finding: IDataLakeFindingDocument, fabFileIds: readonly string[]) {
  const cited = citedFabFileIds(finding);
  const stranger = fabFileIds.find(id => !cited.has(id));
  if (stranger) {
    throw new BadRequestError(
      `Document ${stranger} is not one of the documents this finding is about. A corpus action can ` +
        'only touch the documents the finding cites.'
    );
  }
}

/** File names as the finding recorded them, so the audit row reads without a second collection. */
function nameFor(finding: IDataLakeFindingDocument, fabFileId: string): string | null {
  return finding.sources.find(s => s.fabFileId === fabFileId)?.fileName ?? null;
}

/**
 * How many distinct lakes this file's own meta-tags name. Mirrors the ambiguity check
 * `partitionBySupersession` makes with `attributeFileToLakeIds`, but scoped to what a single tag
 * list can say on its own: a file carrying more than one `datalake:<slug>` tag is a member of more
 * than one lake by meta-tag alone, so a ruling attributed to any ONE of them resolves to `lakeId:
 * null` at the collapse (`lakeIds.length === 1 ? lakeIds[0] : null`) and is never honored. Does not
 * catch the dynamic-lake prefix-only arm of ambiguity, which needs every other lake's prefix to
 * evaluate and this module has no reason to load - a narrower, local proxy for the same fact.
 */
function memberOfMoreThanOneLakeByMetaTag(file: { tags?: { name?: string }[] }): boolean {
  const names = (file.tags ?? []).map(t => t.name).filter((n): n is string => typeof n === 'string');
  return datalakeTagsFrom(names).length > 1;
}

/** Bounds the cycle walk below so a malformed or very long chain cannot spin. */
const SUPERSESSION_CYCLE_WALK_LIMIT = 64;

/**
 * True when `keepFabFileId` already carries a ruling chain, for this lake, that eventually names
 * `retireFabFileId` as ITS winner. Writing `retire -> superseded by keep` on top of that closes a
 * cycle: `retire`'s new entry says "superseded by keep" and the existing chain says keep is (perhaps
 * transitively) "superseded by retire" - the exact shape `resolveRuling`'s walk then declines for
 * every file in the loop, silently dropping the whole subject from ranking. Refusing the WRITE that
 * would close it is cheaper than detecting it after the fact.
 */
async function wouldCloseSupersessionCycle(
  keepFabFileId: string,
  retireFabFileId: string,
  lakeId: string,
  db: { fabFiles: Pick<IFabFileRepository, 'findById'> }
): Promise<boolean> {
  const seen = new Set<string>([retireFabFileId]);
  let current: string | undefined = keepFabFileId;
  for (let step = 0; current && step < SUPERSESSION_CYCLE_WALK_LIMIT; step += 1) {
    if (seen.has(current)) return false; // a cycle not involving retireFabFileId - not this write's problem
    seen.add(current);
    const file = await db.fabFiles.findById(current);
    const winner = file?.supersededInLakes?.find(r => r.dataLakeId === lakeId)?.supersededByFabFileId;
    if (!winner) return false;
    if (winner === retireFabFileId) return true;
    current = winner;
  }
  return false;
}

export const applyCorpusAction = async (
  actor: CorpusActionActor,
  dataLakeId: string,
  findingId: string,
  request: CorpusActionRequest,
  { db, logger }: ApplyCorpusActionAdapters
): Promise<ApplyCorpusActionResult> => {
  const lake = await db.dataLakes.findById(dataLakeId);
  if (!lake) throw new NotFoundError('Data lake not found');

  // Permission before any finding read, so a non-manager gets the permission answer rather than a
  // probe of whether a finding id exists - the same ordering `setDataLakeFileTags` uses.
  const grants = await loadActiveLakeGrants(lake, { db });
  if (!canManageLake(lake, actor, grants)) {
    throw new BadRequestError("You do not have permission to change this data lake's corpus");
  }
  const rung = assertCuratorRung(lake, actor, grants);
  // A fallback (static registry) lake has no document to hold membership, and detection never runs
  // against one, so it can have no finding to act on either.
  assertLakeWritable(lake);

  const finding = await db.dataLakeFindings.findById(findingId);
  // Belongs-to-lake is checked rather than trusted from the caller's path: the gate above
  // authorized a LAKE, so without this a curator of one lake could act on any finding id in the
  // database. Not-found rather than forbidden, so the refusal leaks nothing about other lakes.
  if (!finding || finding.lakeId !== lake.id) throw new NotFoundError('Finding not found');
  // OPEN only. A resolved or dismissed finding is a question a human already closed, and acting on
  // one would mean the corpus moved under a decision nobody is currently making. Reopen is
  // deliberately not a thing this model has, so the honest answer is to refuse.
  if (finding.status !== 'open') {
    throw new BadRequestError('This finding has already been ruled on');
  }

  const at = new Date();
  const principal = auditPrincipalFor(actor);

  /** The one write door for this collection, so every branch records the same shape. */
  const audit = async (targets: LakeCorpusActionTarget[], detail: Record<string, unknown>) => {
    const event: IDataLakeCorpusAction = {
      lakeId: lake.id,
      findingId: finding.id,
      action: request.action,
      targets,
      detail,
      note: request.note ?? null,
      actorUserId: actor.userId,
      principal,
      rung,
      at,
    };
    // The mutation above has already committed by the time this runs, so a rejected write here
    // is not "the action failed" - it is "the action happened and its audit row did not". Retried
    // a few times before that gap is surfaced, since a transient write hiccup is the likeliest
    // cause and every attempt after the first is cheap insurance against exactly the failure this
    // module exists to prevent: a corpus change with nothing recording who made it.
    let lastError: unknown;
    for (let attempt = 1; attempt <= AUDIT_RECORD_ATTEMPTS; attempt += 1) {
      try {
        await db.dataLakeCorpusActions.record(event);
        logger?.log?.('[dataLakes] curator corpus action applied', {
          dataLakeId: lake.id,
          findingId: finding.id,
          action: request.action,
          rung,
          targets,
        });
        return;
      } catch (err) {
        lastError = err;
      }
    }
    logger?.error?.('[dataLakes] curator corpus action applied but its audit record failed to write', {
      dataLakeId: lake.id,
      findingId: finding.id,
      action: request.action,
      rung,
      targets,
      err: lastError,
    });
    throw lastError;
  };

  let targets: LakeCorpusActionTarget[];
  let detail: Record<string, unknown>;

  if (request.action === 'merge') {
    const retire = [...new Set(request.retireFabFileIds)];
    if (retire.length === 0) throw new BadRequestError('A merge must retire at least one document');
    if (retire.includes(request.keepFabFileId)) {
      throw new BadRequestError('A merge cannot both keep and retire the same document');
    }
    assertCited(finding, [request.keepFabFileId, ...retire]);

    // The finding cites the kept document, but a citation is historical - the finding may be
    // stale and the kept file may since have left the lake itself. Without this check a merge on
    // a stale finding would remove every retired member and leave nothing standing, then audit a
    // "kept" document that was never actually a member at merge time.
    const keepFile = await db.fabFiles.findById(request.keepFabFileId);
    if (!keepFile || keepFile.deletedAt || !lakeMembershipSignals(lake, keepFile).inLake) {
      throw new NotFoundError('The document to keep is not a member of this data lake');
    }

    // Sequential, not concurrent: each removal recomputes the lake's stats, and two of those
    // interleaving would race each other to write a count neither of them read.
    //
    // A failure part-way through is NOT rolled back - each removal has already committed, and the
    // restore record is what undoes one. What must not happen is it going unrecorded: without the
    // catch, a merge that dropped one member and then threw left membership changed with nothing
    // saying who did it. So the partial outcome is audited, naming only the ids that really went,
    // and the error is rethrown so the caller still sees a failure.
    const removed: string[] = [];
    try {
      for (const fabFileId of retire) {
        await removeFileFromDataLake(actor, lake.id, fabFileId, { db, logger });
        removed.push(fabFileId);
      }
    } catch (error) {
      if (removed.length > 0) {
        await audit(
          [
            { fabFileId: request.keepFabFileId, fileName: nameFor(finding, request.keepFabFileId), role: 'kept' },
            ...removed.map(id => ({ fabFileId: id, fileName: nameFor(finding, id), role: 'retired' as const })),
          ],
          { removedFabFileIds: removed, partial: true, requestedFabFileIds: retire }
        );
      }
      throw error;
    }
    targets = [
      { fabFileId: request.keepFabFileId, fileName: nameFor(finding, request.keepFabFileId), role: 'kept' },
      ...removed.map(id => ({ fabFileId: id, fileName: nameFor(finding, id), role: 'retired' as const })),
    ];
    detail = { removedFabFileIds: removed };
  } else if (request.action === 'supersede') {
    if (request.keepFabFileId === request.retireFabFileId) {
      throw new BadRequestError('A document cannot supersede itself');
    }
    assertCited(finding, [request.keepFabFileId, request.retireFabFileId]);

    // BOTH must be live members of THIS lake. The winner especially: a ruling naming a non-member
    // is inert (`partitionBySupersession` declines a winner that is not in the scoped set), so
    // writing one would report success for a suppression that will never happen.
    let retiringFile: Awaited<ReturnType<IFabFileRepository['findById']>> | null = null;
    for (const fabFileId of [request.keepFabFileId, request.retireFabFileId]) {
      const file = await db.fabFiles.findById(fabFileId);
      if (!file || file.deletedAt || !lakeMembershipSignals(lake, file).inLake) {
        throw new NotFoundError('File not found in this data lake');
      }
      if (fabFileId === request.retireFabFileId) retiringFile = file;
    }

    // The retiring document must attribute to THIS lake alone. A document tagged into several
    // lakes resolves to `lakeId: null` at the collapse - the ruling would be written, reported as a
    // success, and never once honored on retrieval. See `memberOfMoreThanOneLakeByMetaTag`.
    if (retiringFile && memberOfMoreThanOneLakeByMetaTag(retiringFile)) {
      throw new BadRequestError(
        'This document belongs to more than one data lake, so a ruling here would never be honored ' +
          'on retrieval. Retag it into this lake alone before superseding it.'
      );
    }

    // Refuse a write that would close a cycle - see `wouldCloseSupersessionCycle`.
    if (await wouldCloseSupersessionCycle(request.keepFabFileId, request.retireFabFileId, lake.id, db)) {
      throw new BadRequestError(
        'The document to keep is already ruled superseded, directly or transitively, by the document ' +
          'to retire. Applying this ruling would create a cycle that suppresses both.'
      );
    }

    const wrote = await db.fabFiles.setLakeSupersession(request.retireFabFileId, {
      dataLakeId: lake.id,
      supersededByFabFileId: request.keepFabFileId,
      decidedByUserId: actor.userId,
      decidedAt: at,
    });
    if (!wrote) throw new NotFoundError('File not found in this data lake');

    targets = [
      { fabFileId: request.keepFabFileId, fileName: nameFor(finding, request.keepFabFileId), role: 'kept' },
      { fabFileId: request.retireFabFileId, fileName: nameFor(finding, request.retireFabFileId), role: 'retired' },
    ];
    // Named so the trail says what a supersede actually did, which is the thing about it most
    // easily misread: the document is still in the corpus and still retrievable by id or name.
    detail = { suppressedFromRanking: request.retireFabFileId, removedFromCorpus: false };
  } else if (request.action === 'unsupersede') {
    assertCited(finding, [request.fabFileId]);
    // No membership re-check, unlike `supersede`. Clearing a ruling only ever returns a document to
    // ranking, so refusing it for a file that has drifted out of the lake would strand the ruling
    // it exists to remove - and a ruling on a non-member is already inert at the collapse.
    const cleared = await db.fabFiles.clearLakeSupersession(request.fabFileId, lake.id);
    if (!cleared) throw new BadRequestError('This document is not superseded in this data lake');

    targets = [{ fabFileId: request.fabFileId, fileName: nameFor(finding, request.fabFileId), role: 'restored' }];
    detail = { returnedToRanking: request.fabFileId };
  } else {
    assertCited(finding, [request.fabFileId]);
    const result = await setDataLakeFileTags(actor, lake.id, request.fabFileId, request.tags, { db, logger });
    targets = [{ fabFileId: request.fabFileId, fileName: nameFor(finding, request.fabFileId), role: 'retagged' }];
    detail = { tags: result.tags, primaryTagCleared: result.primaryTagCleared };
  }

  // AFTER the mutation, deliberately. An audit row for an action that then failed would be a claim
  // about something that did not happen, which is worse than a missing row - and the mutations
  // above are all through doors that leave their own recoverable trail (a restore record, the tag
  // log line, the marker on the file itself). The one exception is a merge that failed PART WAY,
  // which is audited from its own catch above: there, something really did happen.
  await audit(targets, detail);

  return { action: request.action, findingId: finding.id, targets, detail };
};
