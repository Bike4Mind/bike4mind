import { describe, expect, it } from 'vitest';
import { DecisionsRequestSchema, type DecisionsRequest } from '../schemas/decisions';
import { DECISION_MODEL_CATALOG } from './catalog';
import type { DecisionModelCapabilities } from './types';
import { validateDecisionRequest } from './validate';

const caps = DECISION_MODEL_CATALOG['gpt-6-luna'];
const textOnlyCaps: DecisionModelCapabilities = { ...caps, limits: { ...caps.limits, maxImages: 0 } };
const tightCaps: DecisionModelCapabilities = {
  ...caps,
  limits: { ...caps.limits, maxQuestions: 1, maxChoices: 2, maxLevels: 3, maxImages: 1 },
};
const PIXEL = 'data:image/png;base64,iVBORw0KGgo=';

const request = (overrides: Partial<DecisionsRequest> = {}): DecisionsRequest => ({
  model: 'gpt-6-luna',
  input: 'Help! My payouts have been failing for 3 days.',
  questions: [{ type: 'predicate', name: 'is_urgent', instructions: 'Needs a reply within 24 hours.' }],
  ...overrides,
});

const choice = (name: string, values: string[]) => ({
  type: 'choice' as const,
  name,
  instructions: 'Pick one.',
  choices: values.map(value => ({ value })),
});

describe('validateDecisionRequest', () => {
  it('accepts a request within every cap', () => {
    expect(validateDecisionRequest(request(), caps).ok).toBe(true);
  });

  it('rejects duplicate question names, naming the second occurrence', () => {
    const result = validateDecisionRequest(
      request({ questions: [choice('a', ['x', 'y']), choice('a', ['x', 'y'])] }),
      caps
    );
    expect(result).toMatchObject({ ok: false, code: 'invalid_request', param: 'questions[1].name' });
  });

  it('rejects duplicate choice values', () => {
    const result = validateDecisionRequest(request({ questions: [choice('team', ['billing', 'billing'])] }), caps);
    expect(result).toMatchObject({ ok: false, code: 'invalid_request', param: 'questions[0].choices[1].value' });
  });

  it.each([
    {
      cap: 'maxQuestions',
      overrides: { questions: [choice('a', ['x', 'y']), choice('b', ['x', 'y'])] },
      param: 'questions',
    },
    { cap: 'maxChoices', overrides: { questions: [choice('a', ['x', 'y', 'z'])] }, param: 'questions[0].choices' },
    {
      cap: 'maxLevels',
      overrides: {
        questions: [
          {
            type: 'score' as const,
            name: 's',
            instructions: 'Rate.',
            levels: ['a', 'b', 'c', 'd'].map(label => ({ label })),
          },
        ],
      },
      param: 'questions[0].levels',
    },
    {
      cap: 'maxImages',
      overrides: {
        input: [
          { type: 'image' as const, image_url: PIXEL },
          { type: 'image' as const, image_url: PIXEL },
        ],
      },
      param: 'input[1]',
    },
  ])('rejects a request over the per-model $cap with limit_exceeded', ({ overrides, param }) => {
    expect(validateDecisionRequest(request(overrides), tightCaps)).toMatchObject({
      ok: false,
      code: 'limit_exceeded',
      param,
    });
  });

  it('rejects images on a text-only model', () => {
    const result = validateDecisionRequest(request({ input: [{ type: 'image', file_id: 'file_1' }] }), textOnlyCaps);
    expect(result).toMatchObject({ ok: false, code: 'unsupported_input', param: 'input[0]' });
  });

  it.each([
    { part: { type: 'image' as const }, label: 'neither source' },
    { part: { type: 'image' as const, file_id: 'f', image_url: PIXEL }, label: 'both sources' },
  ])('rejects an image part with $label', ({ part }) => {
    expect(validateDecisionRequest(request({ input: [part] }), caps)).toMatchObject({
      ok: false,
      code: 'invalid_request',
      param: 'input[0]',
    });
  });
});

describe('DecisionsRequestSchema platform ceilings', () => {
  it.each([
    { label: 'an http(s) image URL', input: [{ type: 'image', image_url: 'https://example.com/cat.png' }] },
    { label: 'an empty input array', input: [] },
  ])('rejects $label', ({ input }) => {
    expect(DecisionsRequestSchema.safeParse(request({ input: input as DecisionsRequest['input'] })).success).toBe(
      false
    );
  });

  it.each([
    { label: 'a single choice', question: choice('a', ['only']) },
    {
      label: 'a single score level',
      question: { type: 'score', name: 's', instructions: 'Rate.', levels: [{ label: 'one' }] },
    },
    { label: 'an unknown question type', question: { type: 'rank', name: 'r', instructions: 'Rank.' } },
  ])('rejects $label', ({ question }) => {
    const parsed = DecisionsRequestSchema.safeParse({ ...request(), questions: [question] });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown model', () => {
    expect(DecisionsRequestSchema.safeParse({ ...request(), model: 'gpt-nope' }).success).toBe(false);
  });
});
