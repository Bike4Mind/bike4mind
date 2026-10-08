import { describe, expect, it } from 'vitest';
import type { DecisionQuestion } from '../schemas/decisions';
import { DecisionResponseMismatchError, normalizeDecisionAnswers } from './normalize';

const questions: DecisionQuestion[] = [
  { type: 'predicate', name: 'is_urgent', instructions: 'Needs a reply within 24 hours.' },
  {
    type: 'choice',
    name: 'team',
    instructions: 'Which team?',
    choices: [{ value: 'billing' }, { value: 'technical' }, { value: 'sales' }],
  },
  {
    type: 'score',
    name: 'frustration',
    instructions: 'How frustrated?',
    levels: [{ label: 'calm' }, { label: 'frustrated' }, { label: 'angry' }],
  },
];

describe('normalizeDecisionAnswers', () => {
  it('re-orders vendor distributions to request order and computes choice, score and confidence', () => {
    const [predicate, choice, score] = normalizeDecisionAnswers(questions, [
      { type: 'predicate', probability: 0.93 },
      { type: 'choice', probabilities: { sales: 0.02, technical: 0.1, billing: 0.88 } },
      { type: 'score', probabilities: { 2: 0.2, 0: 0.1, 1: 0.7 } },
    ]);
    expect(predicate).toEqual({ type: 'predicate', name: 'is_urgent', probability: 0.93 });
    expect(choice).toMatchObject({
      choice: 'billing',
      probabilities: [
        { value: 'billing', probability: 0.88 },
        { value: 'technical', probability: 0.1 },
        { value: 'sales', probability: 0.02 },
      ],
    });
    expect(choice.type === 'choice' && choice.confidence).toBeCloseTo(0.82);
    expect(score).toMatchObject({
      score: expect.closeTo(1.1),
      probabilities: [
        { value: 0, label: 'calm', probability: 0.1 },
        { value: 1, label: 'frustrated', probability: 0.7 },
        { value: 2, label: 'angry', probability: 0.2 },
      ],
      confidence: expect.closeTo(0.55),
    });
  });

  it('keeps a refusal for one question without failing the others', () => {
    const answers = normalizeDecisionAnswers(questions, [
      { type: 'predicate', probability: 0.5 },
      { type: 'refusal' },
      { type: 'score', probabilities: { 0: 1, 1: 0, 2: 0 } },
    ]);
    expect(answers[1]).toEqual({ type: 'refusal', name: 'team' });
    expect(answers[2].type).toBe('score');
  });

  it('breaks a tie towards the earliest choice', () => {
    const [, choice] = normalizeDecisionAnswers(questions, [
      { type: 'predicate', probability: 0.5 },
      { type: 'choice', probabilities: { billing: 0.4, technical: 0.4, sales: 0.2 } },
      { type: 'score', probabilities: { 0: 1, 1: 0, 2: 0 } },
    ]);
    expect(choice.type === 'choice' && choice.choice).toBe('billing');
  });

  it.each([
    { label: 'an answer count mismatch', raw: [{ type: 'predicate' as const, probability: 0.5 }] },
    {
      label: 'a type mismatch',
      raw: [{ type: 'choice' as const, probabilities: {} }, { type: 'refusal' as const }, { type: 'refusal' as const }],
    },
    {
      label: 'a missing choice probability',
      raw: [
        { type: 'predicate' as const, probability: 0.5 },
        { type: 'choice' as const, probabilities: { billing: 1 } },
        { type: 'refusal' as const },
      ],
    },
    {
      label: 'an out-of-range probability',
      raw: [
        { type: 'predicate' as const, probability: 1.5 },
        { type: 'refusal' as const },
        { type: 'refusal' as const },
      ],
    },
  ])('throws DecisionResponseMismatchError on $label', ({ raw }) => {
    expect(() => normalizeDecisionAnswers(questions, raw)).toThrow(DecisionResponseMismatchError);
  });
});
