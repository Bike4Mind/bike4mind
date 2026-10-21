import type { DecisionModelId, RawDecisionAnswer } from '@bike4mind/common';
import {
  DecisionProviderError,
  type DecisionProvider,
  type DecisionProviderRequest,
  type ProviderDecision,
  type ResolvedDecisionInput,
} from '../types';

/** Markers in the input text that drive the outcome, so tests and keyless previews can exercise every path. */
export const TEST_DECISION_MARKERS = { overloaded: '[overloaded]', refuse: '[refuse]', badKey: '[bad-key]' } as const;

// FNV-1a: stable across runs and platforms, so the same request always gets the same answer.
const hash = (text: string): number => {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
};

/** A distribution over `count` options that peaks at a seed-chosen option, holding 70% of the mass. */
const peakedDistribution = (count: number, seed: number): number[] => {
  const peak = seed % count;
  const rest = 0.3 / (count - 1);
  return Array.from({ length: count }, (_value, index) => (index === peak ? 0.7 : rest));
};

const inputText = (input: ResolvedDecisionInput): string =>
  typeof input === 'string'
    ? input
    : input
        .map(part => (part.type === 'text' ? part.text : part.type === 'json' ? JSON.stringify(part.json) : ''))
        .join('\n');

/** Deterministic, free and offline. Registered only when ENABLE_TEST_DECISION_PROVIDER=true, never in production. */
export class TestDecisionProvider implements DecisionProvider {
  readonly id = 'test' as const;
  readonly models: readonly DecisionModelId[] = ['test-decisions'];

  async decide(request: DecisionProviderRequest): Promise<ProviderDecision> {
    const text = inputText(request.input);
    if (text.includes(TEST_DECISION_MARKERS.overloaded)) {
      throw new DecisionProviderError('overloaded', 'test provider overloaded', { status: 529 });
    }
    if (text.includes(TEST_DECISION_MARKERS.badKey)) {
      throw new DecisionProviderError('rejected_key', 'test provider rejected the key', { status: 401 });
    }
    const refuse = text.includes(TEST_DECISION_MARKERS.refuse);
    const answers = request.questions.map((question): RawDecisionAnswer => {
      if (refuse) return { type: 'refusal' };
      const seed = hash(`${text}\n${question.name}`);
      if (question.type === 'predicate') return { type: 'predicate', probability: (seed % 101) / 100 };
      if (question.type === 'choice') {
        const distribution = peakedDistribution(question.choices.length, seed);
        return {
          type: 'choice',
          probabilities: Object.fromEntries(question.choices.map(({ value }, index) => [value, distribution[index]])),
        };
      }
      return { type: 'score', probabilities: { ...peakedDistribution(question.levels.length, seed) } };
    });
    // Rough token estimate (4 chars/token) so usage and metrics paths see non-zero numbers.
    return { model: 'test-decisions', answers, usage: { inputTokens: Math.ceil(text.length / 4), outputTokens: 0 } };
  }
}
