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
 * Backstop on a single walk. `visited` already terminates a cycle; this bounds the pathological
 * case where a chain is legitimately long enough that the reads are no longer worth serving.
 */
const MAX_CHAIN_DEPTH = 50;

/**
 * The correction hops of a session that can be paired soundly, oldest first.
 *
 * Walks backwards from each corrected turn through `correctsQuestId` and pairs each turn with the
 * one it corrects. `visited` spans the whole session rather than one chain: the links come back
 * oldest first, so by the time a later retry is walked its predecessors are already paired, and
 * re-walking them would emit the same hop twice.
 *
 * A hop is dropped rather than repaired when it cannot be trusted: the target is gone, lives in
 * another session, or either turn never recorded an answer. The caller gets a shorter list instead
 * of a triple with an empty answer on it, because this feeds an eval export, where an empty
 * "original answer" reads as the model having said nothing rather than as a missing read.
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

    let current: CorrectionTurnRecord | undefined = link;
    for (let depth = 0; current && depth < MAX_CHAIN_DEPTH; depth++) {
      visited.add(current.id);

      const targetId = current.correctsQuestId;
      if (!targetId || targetId === current.id) break;

      const target = linksById.get(targetId) ?? (await reader.findById(targetId)) ?? undefined;
      if (!target) break;

      // Positive check, matching resolveCorrectionContext: a reject-on-mismatch form lets a hop
      // through when BOTH ids are absent, and this walk feeds an export, so a stale pointer into
      // another session would carry that session's prose out.
      if (!(target.sessionId && current.sessionId && target.sessionId === current.sessionId)) break;

      const pair = toEvalPair(target, current);
      if (pair) pairs.push(pair);

      const next = linksById.get(targetId);
      if (!next || visited.has(next.id)) break;
      current = next;
    }
  }

  return pairs;
}

/** Null when either side of the hop has no prose to compare - see the drop rule above. */
function toEvalPair(corrected: CorrectionTurnRecord, correction: CorrectionTurnRecord): EvalPair | null {
  const originalAnswer = readAnswerText(corrected);
  const correctedAnswer = readAnswerText(correction);
  if (!originalAnswer || !correctedAnswer) return null;

  return {
    correctedQuestId: corrected.id,
    originalAnswer,
    critique: correction.prompt?.trim() ?? '',
    correctedAnswer,
    timestamp: correction.timestamp,
  };
}
