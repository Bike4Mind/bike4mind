import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';
import type { LakeAuditPrincipal, LakeManageRung } from './LakeConfigChangeEventTypes';

// -- Data Lake Corpus Action -----------------------------------------------------------------
//
// One row per curator action that CHANGED A LAKE'S CORPUS in response to a finding (#3046).
//
// A third audit collection, next to LakeAccessEvent (one read turn) and LakeConfigChangeEvent (one
// config write), because neither can hold this. The config event's diff is typed as a total map
// over `keyof IDataLake` - deliberately, so a new lake field cannot go unaudited - and these
// actions move no lake field at all: they retire a FabFile from ranking, drop its membership or
// rewrite its tags. Widening that map to admit a foreign entity would cost it the exhaustiveness
// that is its whole point.
//
// APPEND-ONLY, and the trail rather than the state. What a supersede currently says lives on the
// file (`IFabFile.supersededInLakes`); what a merge did is visible in the membership it removed.
// A reader comparing the two can tell a ruling that still stands from one that was later undone.
//
// CURATOR-INITIATED ONLY. Every row here was requested by a human looking at a finding. No
// detector, queue handler or scheduled sweep may write one, because none of them may perform the
// action in the first place - see the guardrail on `applyCorpusAction`.

/**
 * What the curator did to the corpus.
 *
 * Each delegates to the door that already owns that mutation rather than reimplementing it, which
 * is why the vocabulary is this short: these are the four shapes a finding can be acted on in, not
 * three new ways to write to a lake.
 *
 * - `merge`   - keep one document, drop the others' MEMBERSHIP of this lake (`removeFileFromDataLake`,
 *               so each removal mints the usual 30-minute restore record and stays undoable).
 * - `supersede` - keep both documents in the corpus, but retire one from RANKING behind the other
 *               (`IFabFile.supersededInLakes`, honored by `partitionBySupersession`).
 * - `unsupersede` - drop a supersede ruling, returning the document to ranking. The UNDO for the
 *               action above, not a fourth capability: a merge is undone by the removal door's
 *               30-minute restore record and a retag by another retag, so without this one of the
 *               three would be the only one a curator could not take back.
 * - `retag`   - rewrite one document's tags under this lake's prefix (`setDataLakeFileTags`).
 */
export const LAKE_CORPUS_ACTIONS = ['merge', 'supersede', 'unsupersede', 'retag'] as const;
export type LakeCorpusAction = (typeof LAKE_CORPUS_ACTIONS)[number];

/**
 * What one document's part in the action was.
 *
 * `kept` and `retired` are spelled separately rather than derived from position because the pair is
 * the whole content of a merge or a supersede: "which one survived" is the question an audit of
 * these is read to answer, and an ordered id list would leave it to be inferred.
 */
export const LAKE_CORPUS_ACTION_ROLES = ['kept', 'retired', 'restored', 'retagged'] as const;
export type LakeCorpusActionRole = (typeof LAKE_CORPUS_ACTION_ROLES)[number];

export interface LakeCorpusActionTarget {
  fabFileId: string;
  /** Captured at action time. The file may be renamed or destroyed later; the trail should not move. */
  fileName: string | null;
  role: LakeCorpusActionRole;
}

/** Longest note a curator may attach to a corpus action. Mirrors the finding resolution cap. */
export const LAKE_CORPUS_ACTION_NOTE_MAX_CHARS = 500;

export interface IDataLakeCorpusAction {
  lakeId: string;
  /**
   * The finding this action answers. REQUIRED, and the structural half of the curator-only
   * guardrail: there is no way to record a corpus action that is not a response to something a
   * human was looking at.
   */
  findingId: string;
  action: LakeCorpusAction;
  /** Every document the action touched, kept and retired alike. */
  targets: LakeCorpusActionTarget[];
  /**
   * What changed, beyond the targets, in the action's own vocabulary: the tag diff for a `retag`,
   * empty for the other two, whose targets already say everything. Free-form rather than a union
   * because it is read by humans and never branched on.
   */
  detail?: Record<string, unknown> | null;
  /** The curator's note, if they left one. */
  note?: string | null;
  /**
   * WHO. `actorUserId` is the acting user; `principal` distinguishes that user acting by hand from
   * an API key acting for them, using the same vocabulary as both sibling audit models rather than
   * a third spelling of the same fact.
   */
  actorUserId: string;
  principal: LakeAuditPrincipal;
  /** Which manage rung authorized it - the field that makes a platform admin's action visible AS SUCH. */
  rung: LakeManageRung;
  at: Date;
}

export type IDataLakeCorpusActionDocument = IDataLakeCorpusAction & IMongoDocument;

/** How a surface narrows one lake's corpus-action history. Every filter is optional. */
export interface ListLakeCorpusActionsOptions {
  findingId?: string;
  action?: LakeCorpusAction;
  limit?: number;
}

export interface IDataLakeCorpusActionRepository extends IBaseRepository<IDataLakeCorpusActionDocument> {
  /** Append one action. Never updates: a corrected ruling is a new action, not an edited record. */
  record(input: IDataLakeCorpusAction): Promise<IDataLakeCorpusActionDocument>;
  /** One lake's history, newest first. */
  listByLake(lakeId: string, options?: ListLakeCorpusActionsOptions): Promise<IDataLakeCorpusActionDocument[]>;
  /**
   * Drop a deleted lake's history, called by the lake teardown sweep.
   *
   * Deliberately NOT swept when a DOCUMENT is purged, unlike `DataLakeFindingModel`. A finding
   * quotes a 240-char excerpt of a document's prose and so carries a retention obligation; a row
   * here carries ids, a file NAME and a curator's own note - the record of an action a human took,
   * which is the last thing an audit trail should lose because its subject was later destroyed.
   */
  deleteForLake(lakeId: string): Promise<number>;
}
