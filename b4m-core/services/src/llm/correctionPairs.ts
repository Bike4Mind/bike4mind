import { readAnswerText, type CorrectedTurn } from './buildCorrectionContext';

/**
 * A corrected turn as the walk reads it: the prose fields `readAnswerText` needs, plus identity.
 * Mirrors `CorrectionLinkView` in QuestModel.ts (@bike4mind/database), which is what the route
 * passes in; taking it as a plain reader is what keeps this module DB-free.
 */
export type CorrectionTurnRecord = CorrectedTurn & {
  id: string;
  sessionId: string;
  correctsQuestId?: string | null;
  timestamp?: Date;
};

/** Just enough of the quest store to walk a correction chain. */
export type CorrectionPairReader = {
  /** The session's corrected turns, oldest first. */
  findCorrectionLinks: (sessionId: string) => Promise<CorrectionTurnRecord[]>;
  /** The chain root, which carries no `correctsQuestId` and so is not in the link list. */
  findById: (id: string) => Promise<CorrectionTurnRecord | null | undefined>;
  /**
   * Optional, but a dropped hop is invisible without it: the only symptom is a shorter export,
   * which reads as "this session had fewer retries" rather than as a link that could not be read.
   */
  logger?: { warn: (message: string) => void };
};

/**
 * One correction hop as an eval triple: what the model said, what the user said was wrong with it,
 * and what it said next. `correctedQuestId` names the turn being corrected, so a chain of retries
 * yields one pair per hop rather than one per chain.
 */
export type EvalPair = {
  correctedQuestId: string;
  originalAnswer: string;
  critique: string;
  correctedAnswer: string;
  timestamp?: Date;
};

/**
 * The correction hops of a session that can be paired soundly, oldest first.
 *
 * Walks backwards from each corrected turn through `correctsQuestId` and pairs each turn with the
 * one it corrects. `visited` spans the whole session rather than one chain: the links come back
 * oldest first, so by the time a later retry is walked its predecessors are already paired, and
 * re-walking them would emit the same hop twice.
 *
 * A hop is dropped rather than repaired when it cannot be trusted: the target is gone, lives in
 * another session, closes a cycle, or either side of the triple has no prose. The caller gets a
 * shorter list instead of a triple with an empty leg on it, because this feeds an eval export,
 * where an empty "original answer" reads as the model having said nothing rather than as a
 * missing read.
 */
export async function buildCorrectionPairs(
  sessionId: string | undefined,
  reader: CorrectionPairReader
): Promise<EvalPair[]> {
  if (sessionId === undefined || sessionId === null || sessionId.length < 1) return [];

  const links = await reader.findCorrectionLinks(sessionId);
  if (links.length === 0) return [];

  const linksById = new Map(links.map(link => [link.id, link]));
  const pairs: EvalPair[] = [];
  const visited = new Set<string>();

  for (const link of links) {
    if (visited.has(link.id)) continue;

    // Scoped to this walk, unlike `visited`: a hop pointing back into the chain we are currently
    // walking is corrupt data, not a retry, and emitting it would present one answer as both the
    // original and the correction. Subsumes the self-referential case (`a` corrects `a`).
    const path = new Set<string>();
    // Terminates without a depth cap: every step marks its turn visited and only advances to an
    // unvisited link, and the link list is finite. A cap would not bound the work anyway - the
    // outer loop picks the same chain back up at the link the cap stopped on. The per-request
    // bound is the caller's (see MAX_EXPORTED_LINKS in the route).
    let current: CorrectionTurnRecord | undefined = link;
    while (current) {
      visited.add(current.id);
      path.add(current.id);

      const targetId = current.correctsQuestId;
      if (!targetId) break;
      if (path.has(targetId)) {
        reader.logger?.warn(`[CORRECTION-PAIRS] Dropping cyclic correction link: ${current.id} -> ${targetId}`);
        break;
      }

      const target = linksById.get(targetId) ?? (await reader.findById(targetId)) ?? undefined;
      if (!target) {
        reader.logger?.warn(`[CORRECTION-PAIRS] Dropping hop whose corrected turn is gone: ${targetId}`);
        break;
      }

      // Positive check, matching resolveCorrectionContext: a reject-on-mismatch form lets a hop
      // through when BOTH ids are absent, and this walk feeds an export, so a stale pointer into
      // another session would carry that session's prose out.
      if (!(target.sessionId && current.sessionId && target.sessionId === current.sessionId)) {
        reader.logger?.warn(
          `[CORRECTION-PAIRS] Dropping cross-session correction link: ${targetId} is not in ${sessionId}`
        );
        break;
      }

      const pair = toEvalPair(target, current);
      if (pair) {
        pairs.push(pair);
      } else {
        reader.logger?.warn(`[CORRECTION-PAIRS] Dropping hop with an empty leg: ${targetId} -> ${current.id}`);
      }

      const next = linksById.get(targetId);
      if (!next || visited.has(next.id)) break;
      current = next;
    }
  }

  return pairs;
}

/**
 * Null when any leg of the triple has no prose - see the drop rule above. The critique is held to
 * the same bar as the two answers: it is the "what was wrong" the export exists to carry, and a
 * blank one leaves a pair that cannot be graded.
 */
function toEvalPair(corrected: CorrectionTurnRecord, correction: CorrectionTurnRecord): EvalPair | null {
  const originalAnswer = readAnswerText(corrected);
  const correctedAnswer = readAnswerText(correction);
  const critique = correction.prompt?.trim() ?? '';
  if (!originalAnswer || !correctedAnswer || !critique) return null;

  return {
    correctedQuestId: corrected.id,
    originalAnswer,
    critique,
    correctedAnswer,
    timestamp: correction.timestamp,
  };
}
