import { describe, expect, it } from 'vitest';
import type { DecisionAnswer } from '@bike4mind/common';
import { feedbackQuestions, nearestFeedback, readFeedbackAnswers } from './feedbackDecision';

const choice = (name: string, value: string): DecisionAnswer => ({
  type: 'choice',
  name,
  choice: value,
  confidence: 0.9,
  probabilities: [{ value, probability: 0.95 }],
});
const answers: DecisionAnswer[] = [
  choice('area', 'chat'),
  choice('severity', 'major'),
  { type: 'predicate', name: 'actionable', probability: 0.9 },
  { type: 'predicate', name: 'needsReply', probability: 0.1 },
];
describe('feedback typed decisions', () => {
  it('uses fixed questions and treats user text as data', () => {
    const questions = feedbackQuestions(2);
    expect(questions).toHaveLength(5);
    expect(questions.every(q => q.instructions.includes('untrusted data'))).toBe(true);
    expect(questions[4]).toMatchObject({
      choices: [{ value: 'none' }, { value: 'candidate_0' }, { value: 'candidate_1' }],
    });
  });
  it('reads bounded labels and minimum confidence without a duplicate', () => {
    expect(readFeedbackAnswers(answers, [])).toEqual({
      labels: { area: 'chat', severity: 'major', actionable: true, needsReply: false, duplicateId: null },
      confidence: 0.9,
    });
  });
  it('maps only a real candidate alias back to an internal id', () => {
    const id = '64b7f0c2a1b2c3d4e5f60718';
    expect(readFeedbackAnswers([...answers, choice('duplicate', 'candidate_0')], [id]).labels.duplicateId).toBe(id);
    expect(() => readFeedbackAnswers([...answers, choice('duplicate', 'candidate_9')], [id])).toThrow();
    expect(() => readFeedbackAnswers([...answers, choice('duplicate', id)], [id])).toThrow();
  });
  it('rejects refusal, missing answers and out-of-taxonomy labels', () => {
    expect(() => readFeedbackAnswers([{ type: 'refusal', name: 'area' }], [])).toThrow();
    expect(() => readFeedbackAnswers([choice('area', 'invented'), ...answers.slice(1)], [])).toThrow();
  });
  it('ranks cosine candidates, bounds list, rejects bad dimensions and zero vectors', () => {
    expect(
      nearestFeedback(
        [1, 0],
        [
          { id: 'far', vector: [0, 1] },
          { id: 'close', vector: [1, 0] },
          { id: 'bad', vector: [1] },
          { id: 'zero', vector: [0, 0] },
        ]
      )
    ).toEqual([{ id: 'close', similarity: 1 }]);
    expect(nearestFeedback([0, 0], [{ id: 'x', vector: [1, 0] }])).toEqual([]);
    expect(
      nearestFeedback(
        [1],
        Array.from({ length: 10 }, (_, i) => ({ id: String(i), vector: [1] }))
      )
    ).toHaveLength(5);
  });
});
