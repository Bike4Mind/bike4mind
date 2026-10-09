import { describe, expect, it } from 'vitest';
import type { DecisionQuestion } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { describeDecisionProviderConformance } from '../conformance';
import { TEST_DECISION_MARKERS, TestDecisionProvider } from './TestDecisionProvider';

const questions: DecisionQuestion[] = [
  { type: 'predicate', name: 'is_urgent', instructions: 'Needs a reply within 24 hours.' },
  { type: 'choice', name: 'team', instructions: 'Which team?', choices: [{ value: 'billing' }, { value: 'sales' }] },
  { type: 'score', name: 'mood', instructions: 'How upset?', levels: [{ label: 'calm' }, { label: 'angry' }] },
];
const request = (input: string) => ({ model: 'test-decisions' as const, input, questions });

describeDecisionProviderConformance('Test', {
  provider: () => new TestDecisionProvider(),
  answers: [
    { label: 'every question type', request: request('Payouts failing for 3 days') },
    {
      label: 'mixed input parts',
      request: {
        ...request(''),
        input: [
          { type: 'text', text: 'hi' },
          { type: 'json', json: { plan: 'pro' } },
        ],
      },
    },
  ],
  refusal: { label: 'a refusal marker', request: request(`please ${TEST_DECISION_MARKERS.refuse}`) },
  errors: [
    { label: 'the overloaded marker', kind: 'overloaded', request: request(TEST_DECISION_MARKERS.overloaded) },
    { label: 'the bad-key marker', kind: 'rejected_key', request: request(TEST_DECISION_MARKERS.badKey) },
  ],
});

describe('TestDecisionProvider', () => {
  it('answers the same request the same way every time', async () => {
    const ctx = { apiKey: 'k', logger: new Logger(), signal: AbortSignal.timeout(1_000) };
    const provider = new TestDecisionProvider();
    const first = await provider.decide(request('same input'), ctx);
    const second = await provider.decide(request('same input'), ctx);
    expect(second).toEqual(first);
  });
});
