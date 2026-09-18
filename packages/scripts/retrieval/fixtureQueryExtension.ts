/**
 * Decide which of a question set's queries a capture already holds, and which must be embedded.
 *
 * PHASE E of the floor harness. Phases A-D produce a fixture and a question set independently, and
 * they routinely disagree: the `opti-knowledge` capture was taken with 89 negatives, and the floor
 * decision then needed 30 positives authored from its own passages. Re-capturing to ask the new
 * questions would re-read the whole corpus to learn nothing new about it - and, worse, read a
 * DIFFERENT corpus, because a live lake moves. Recall measured on one snapshot against a
 * false-positive rate measured on another is not one table.
 *
 * So the vectors already captured are reused and only the genuinely new questions are embedded. Two
 * things make that safe rather than merely convenient:
 *
 * REUSE IS KEYED ON THE QUESTION TEXT, NOT THE ID. A reworded question under an unchanged id is the
 * exact hazard `assertQuestionTextMatches` exists to catch: the vector embeds a question nobody is
 * asking any more, and nothing downstream notices - the arm is simply scored on different questions
 * than its neighbours. Here it would be introduced deliberately, so a hash mismatch re-embeds and
 * the report names the id.
 *
 * GROUND TRUTH COMES FROM THE QUESTION FILE, NEVER FROM THE FIXTURE. A reused vector carries its old
 * `supporting` set, and the question file is the thing that gets edited - the chunk-text screen
 * reclassified 44 of 89 negatives on this corpus. Keeping the fixture's copy would score the new
 * file's questions against the old file's answers, which renders as a quality change with no banner
 * on it.
 */

import type { ProbeQuestion } from './corpus';
import { hashQuestionText, type EmbeddingFixture } from './embeddingFixture';

export type CapturedQuery = EmbeddingFixture['queries'][number];

export type QueryExtensionPlan = {
  /** Reused vectors, `supporting` rebuilt from the question file. */
  reused: CapturedQuery[];
  /** Questions with no reusable vector, in question-file order - what the run has to pay for. */
  toEmbed: ProbeQuestion[];
  /** Ids the capture never held. */
  addedIds: string[];
  /** Ids it holds under DIFFERENT question text, so the old vector is of a question no longer asked. */
  rewordedIds: string[];
  /** Ids in the capture that the question file does not ask, so they leave the new one. */
  droppedIds: string[];
  /** Reused ids whose ground truth moved. The vector is still valid; the old answer was not. */
  supportingChangedIds: string[];
};

/** Order-insensitive, because a supporting set is a set and a reordering of one is not a change. */
const sameSupporting = (a: readonly string[] | undefined, b: readonly string[]): boolean => {
  if (a === undefined || a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((id, i) => id === right[i]);
};

export function planQueryExtension(args: {
  existing: readonly CapturedQuery[];
  questions: readonly ProbeQuestion[];
}): QueryExtensionPlan {
  const { existing, questions } = args;
  if (questions.length === 0) {
    throw new Error('Refusing to plan an extension against an empty question set.');
  }
  // A capture whose queries carry no `supporting` joins to the COMMITTED `PROBE_QUESTIONS` by id.
  // Extending it from an external file would convert it to an external set, which silently retires
  // the corpus.ts text pin that is the only thing keeping those ids honest.
  const committed = existing.filter(q => q.supporting === undefined).map(q => q.id);
  if (committed.length > 0) {
    throw new Error(
      `Capture carries ${committed.length} query(s) with no ground truth of their own ` +
        `(${committed.slice(0, 5).join(', ')}), so its ground truth is the committed PROBE_QUESTIONS, ` +
        'joined by id. Re-capture with --questions rather than splicing an external set onto it.'
    );
  }

  const byId = new Map(existing.map(q => [q.id, q]));
  const plan: QueryExtensionPlan = {
    reused: [],
    toEmbed: [],
    addedIds: [],
    rewordedIds: [],
    droppedIds: [],
    supportingChangedIds: [],
  };

  for (const question of questions) {
    const questionHash = hashQuestionText(question.question);
    const held = byId.get(question.id);
    if (held === undefined) {
      plan.addedIds.push(question.id);
      plan.toEmbed.push(question);
      continue;
    }
    if (held.questionHash !== questionHash) {
      plan.rewordedIds.push(question.id);
      plan.toEmbed.push(question);
      continue;
    }
    if (!sameSupporting(held.supporting, question.supporting)) {
      plan.supportingChangedIds.push(question.id);
    }
    plan.reused.push({ id: question.id, vector: held.vector, questionHash, supporting: question.supporting });
  }

  const asked = new Set(questions.map(q => q.id));
  plan.droppedIds = existing.filter(q => !asked.has(q.id)).map(q => q.id);
  return plan;
}

/**
 * The new capture's query list, in question-file order.
 *
 * Order is not cosmetic: the sweep pairs its per-query outcomes with the resolved query list
 * positionally, so a list in any other order produces a table whose rows are labelled with the
 * wrong questions.
 */
export function assembleExtendedQueries(args: {
  plan: QueryExtensionPlan;
  questions: readonly ProbeQuestion[];
  embedded: readonly number[][];
}): CapturedQuery[] {
  const { plan, questions, embedded } = args;
  if (embedded.length !== plan.toEmbed.length) {
    throw new Error(
      `Embedded ${embedded.length} vector(s) for ${plan.toEmbed.length} question(s). A provider that ` +
        'drops or reorders a batch would otherwise attach each vector to the wrong question.'
    );
  }
  const fresh = new Map(plan.toEmbed.map((q, i) => [q.id, embedded[i]]));
  const reused = new Map(plan.reused.map(q => [q.id, q]));
  return questions.map(question => {
    const held = reused.get(question.id);
    if (held !== undefined) return held;
    const vector = fresh.get(question.id);
    if (vector === undefined) {
      throw new Error(`Question "${question.id}" was neither reused nor embedded; this is not the plan assembled.`);
    }
    return {
      id: question.id,
      vector,
      questionHash: hashQuestionText(question.question),
      supporting: question.supporting,
    };
  });
}

export function formatQueryExtensionPlan(plan: QueryExtensionPlan): string {
  const list = (ids: readonly string[]) => (ids.length === 0 ? 'none' : ids.join(', '));
  const lines = [
    `reuse vectors for    : ${plan.reused.length} question(s)`,
    `embed                : ${plan.toEmbed.length} question(s) - ${plan.addedIds.length} new, ` +
      `${plan.rewordedIds.length} reworded`,
    `new ids              : ${list(plan.addedIds)}`,
  ];
  if (plan.rewordedIds.length > 0) {
    lines.push(
      `REWORDED ids         : ${list(plan.rewordedIds)}`,
      '  Their captured vectors embed text the question file no longer asks, so any earlier table',
      '  that used them measured a different question under the same id. Re-embedded here.'
    );
  }
  if (plan.supportingChangedIds.length > 0) {
    lines.push(
      `GROUND TRUTH MOVED   : ${list(plan.supportingChangedIds)}`,
      '  Same question, different supporting set. The vector is reused and the answer comes from the',
      '  question file, so numbers for these ids are not comparable with the earlier run.'
    );
  }
  if (plan.droppedIds.length > 0) {
    lines.push(
      `dropped from capture : ${plan.droppedIds.length} id(s) the question file does not ask`,
      `  ${list(plan.droppedIds)}`
    );
  }
  return lines.join('\n');
}
