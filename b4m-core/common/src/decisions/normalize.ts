import type { DecisionAnswer, DecisionQuestion } from '../schemas/decisions';
import { choiceConfidence, scoreConfidence, weightedScore } from './confidence';

/**
 * What an adapter extracts from a vendor answer, before normalization. Distributions are keyed (choice value, level
 * index) rather than ordered, because vendors return them in arbitrary order; `normalizeDecisionAnswers` re-orders
 * them, picks the argmax and computes `score` and `confidence` the same way for every provider.
 */
export type RawDecisionAnswer =
  | { type: 'predicate'; probability: number }
  | { type: 'choice'; probabilities: Readonly<Record<string, number>> }
  | { type: 'score'; probabilities: Readonly<Record<number, number>> }
  | { type: 'refusal' };

/** The vendor answered something that does not fit the questions we sent. A provider fault, never the caller's. */
export class DecisionResponseMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionResponseMismatchError';
  }
}

const assertProbability = (probability: number | undefined, where: string, key: string | number): number => {
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new DecisionResponseMismatchError(`${where}: missing or invalid probability for ${JSON.stringify(key)}`);
  }
  return probability;
};

// Ties go to the earliest option in request order, so the pick is deterministic.
const argmax = (values: readonly number[]): number =>
  values.reduce((best, value, index) => (value > values[best] ? index : best), 0);

const normalizeAnswer = (question: DecisionQuestion, raw: RawDecisionAnswer, where: string): DecisionAnswer => {
  const { name } = question;
  if (raw.type === 'refusal') return { type: 'refusal', name };
  if (raw.type !== question.type) {
    throw new DecisionResponseMismatchError(`${where}: expected a ${question.type} answer, got ${raw.type}`);
  }
  if (raw.type === 'predicate') {
    return { type: 'predicate', name, probability: assertProbability(raw.probability, where, name) };
  }
  if (raw.type === 'choice' && question.type === 'choice') {
    const probabilities = question.choices.map(({ value }) => ({
      value,
      probability: assertProbability(raw.probabilities[value], where, value),
    }));
    const distribution = probabilities.map(entry => entry.probability);
    return {
      type: 'choice',
      name,
      choice: probabilities[argmax(distribution)].value,
      probabilities,
      confidence: choiceConfidence(distribution),
    };
  }
  if (raw.type === 'score' && question.type === 'score') {
    const probabilities = question.levels.map(({ label }, index) => ({
      value: index,
      label,
      probability: assertProbability(raw.probabilities[index], where, index),
    }));
    const distribution = probabilities.map(entry => entry.probability);
    return {
      type: 'score',
      name,
      score: weightedScore(distribution),
      probabilities,
      confidence: scoreConfidence(distribution),
    };
  }
  throw new DecisionResponseMismatchError(`${where}: unhandled answer type ${raw.type}`);
};

/** Pairs raw answers with the questions they answer, in question order. Throws on any count or type mismatch. */
export const normalizeDecisionAnswers = (
  questions: readonly DecisionQuestion[],
  rawAnswers: readonly RawDecisionAnswer[]
): DecisionAnswer[] => {
  if (rawAnswers.length !== questions.length) {
    throw new DecisionResponseMismatchError(`expected ${questions.length} answers, got ${rawAnswers.length}`);
  }
  return questions.map((question, index) => normalizeAnswer(question, rawAnswers[index], `answers[${index}]`));
};
