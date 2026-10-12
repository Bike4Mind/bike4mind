import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeDecisionAnswers, weightedScore } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import {
  DecisionProviderError,
  type DecisionProvider,
  type DecisionProviderErrorKind,
  type DecisionProviderRequest,
} from './types';

/** Vendors round to 2 decimals, so their confidence matches ours within this. */
const VENDOR_CONFIDENCE_TOLERANCE = 0.01;
const PROBABILITY_SUM_TOLERANCE = 0.02;

export type DecisionConformanceCase = {
  label: string;
  request: DecisionProviderRequest;
  /** Arms fixture state for this case (e.g. an msw handler serving a recorded response). */
  arm?: () => void;
  /** The vendor's own confidence per answer, when it reports one; ours must match it within 0.01. */
  vendorConfidence?: readonly (number | undefined)[];
};

export type DecisionConformanceErrorCase = Omit<DecisionConformanceCase, 'vendorConfidence'> & {
  kind: DecisionProviderErrorKind;
};

/**
 * Every adapter must pass this, driven by recorded golden fixtures. Test-only: never export from index.ts (it imports
 * vitest). `answers` must cover predicate, choice and score; `errors` must include an `overloaded` case.
 */
export type DecisionConformanceSetup = {
  provider: () => DecisionProvider;
  answers: readonly DecisionConformanceCase[];
  refusal: DecisionConformanceCase;
  errors: readonly DecisionConformanceErrorCase[];
  beforeEach?: () => Promise<void> | void;
  afterEach?: () => Promise<void> | void;
};

const decide = (setup: DecisionConformanceSetup, testCase: DecisionConformanceCase | DecisionConformanceErrorCase) => {
  testCase.arm?.();
  return setup.provider().decide(testCase.request, {
    apiKey: 'test-key',
    logger: new Logger(),
    signal: AbortSignal.timeout(5_000),
  });
};

export function describeDecisionProviderConformance(name: string, setup: DecisionConformanceSetup): void {
  describe(`${name} decision provider conformance`, () => {
    if (setup.beforeEach) beforeEach(setup.beforeEach);
    if (setup.afterEach) afterEach(setup.afterEach);

    it('covers every question type and an overloaded error', () => {
      const types = new Set(
        setup.answers.flatMap(testCase => testCase.request.questions.map(question => question.type))
      );
      expect([...types].sort()).toEqual(['choice', 'predicate', 'score']);
      expect(setup.errors.map(error => error.kind)).toContain('overloaded');
    });

    it.each(setup.answers.map(testCase => [testCase.label, testCase] as const))(
      'normalizes %s',
      async (_label, testCase) => {
        const decision = await decide(setup, testCase);
        const answers = normalizeDecisionAnswers(testCase.request.questions, decision.answers);

        expect(decision.model).toMatch(/\S/);
        expect(answers.map(answer => answer.name)).toEqual(testCase.request.questions.map(question => question.name));
        for (const [index, answer] of answers.entries()) {
          if (answer.type !== 'choice' && answer.type !== 'score') continue;
          const distribution = answer.probabilities.map(entry => entry.probability);
          const total = distribution.reduce((sum, probability) => sum + probability, 0);
          expect(Math.abs(total - 1)).toBeLessThanOrEqual(PROBABILITY_SUM_TOLERANCE);
          if (answer.type === 'score') expect(answer.score).toBeCloseTo(weightedScore(distribution), 10);
          const vendor = testCase.vendorConfidence?.[index];
          if (vendor !== undefined) {
            expect(Math.abs(answer.confidence - vendor)).toBeLessThanOrEqual(VENDOR_CONFIDENCE_TOLERANCE);
          }
        }
        for (const tokens of [decision.usage.inputTokens, decision.usage.outputTokens]) {
          expect(Number.isInteger(tokens) && tokens >= 0).toBe(true);
        }
      }
    );

    it('maps a refusal to a refusal answer that keeps the question name', async () => {
      const decision = await decide(setup, setup.refusal);
      const answers = normalizeDecisionAnswers(setup.refusal.request.questions, decision.answers);
      expect(answers.some(answer => answer.type === 'refusal')).toBe(true);
      expect(answers.map(answer => answer.name)).toEqual(
        setup.refusal.request.questions.map(question => question.name)
      );
    });

    it.each(setup.errors.map(testCase => [testCase.label, testCase] as const))('maps %s', async (_label, testCase) => {
      const error = await decide(setup, testCase).then(
        () => undefined,
        (caught: unknown) => caught
      );
      expect(error).toBeInstanceOf(DecisionProviderError);
      expect((error as DecisionProviderError).kind).toBe(testCase.kind);
    });
  });
}
