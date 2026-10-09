import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { DecisionQuestion } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { describeDecisionProviderConformance } from '../conformance';
import type { DecisionProviderRequest } from '../types';
import { OpenAiDecisionProvider } from './OpenAiDecisionProvider';

const URL_DECISIONS = 'https://api.openai.com/v1/decisions';
const PIXEL = 'data:image/png;base64,iVBORw0KGgo=';

// Recorded live response bodies (2026-10-08). Status codes are not in the recordings; each case pairs the body with the
// status the probe observed.
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../__fixtures__/openaiDecisions/${name}.json`, import.meta.url), 'utf8'));

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const respond =
  (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  () =>
    server.use(http.post(URL_DECISIONS, () => HttpResponse.json(body as Record<string, unknown>, { status, headers })));

const request = (
  questions: DecisionQuestion[],
  input: DecisionProviderRequest['input'] = 'Help, payouts failing.'
) => ({
  model: 'gpt-6-luna' as const,
  input,
  questions,
});

const choice = (name: string, values: string[]): DecisionQuestion => ({
  type: 'choice',
  name,
  instructions: 'Pick one.',
  choices: values.map(value => ({ value })),
});
const score = (name: string, labels: string[]): DecisionQuestion => ({
  type: 'score',
  name,
  instructions: 'Rate it.',
  levels: labels.map(label => ({ label })),
});
const predicate = (name: string): DecisionQuestion => ({ type: 'predicate', name, instructions: 'Is it true?' });

describeDecisionProviderConformance('OpenAI', {
  provider: () => new OpenAiDecisionProvider(),
  answers: [
    { label: 'a predicate', request: request([predicate('is_urgent')]), arm: respond(fixture('predicate')) },
    {
      label: 'a choice',
      request: request([choice('team', ['billing', 'technical', 'sales'])]),
      arm: respond(fixture('choice')),
      vendorConfidence: [1],
    },
    {
      label: 'a score',
      request: request([score('frustration', ['calm', 'frustrated', 'angry'])]),
      arm: respond(fixture('score')),
      vendorConfidence: [1],
    },
    {
      label: 'an ambiguous score',
      request: request([score('severity', ['Cosmetic', 'Workaround available', 'Fully blocked'])]),
      arm: respond(fixture('score_ambiguous')),
      vendorConfidence: [0.46],
    },
    {
      label: 'an image input',
      request: request([choice('color', ['red', 'green', 'blue'])], [{ type: 'image', dataUrl: PIXEL }]),
      arm: respond(fixture('image')),
      vendorConfidence: [0.99],
    },
    {
      label: 'answers returned with null names',
      request: request([predicate('is_english'), choice('language', ['en', 'other'])]),
      arm: respond(fixture('multi_no_names')),
      vendorConfidence: [undefined, 1],
    },
  ],
  refusal: {
    label: 'a refusal',
    request: request([predicate('best_route')]),
    arm: respond(fixture('refusal_attempt')),
  },
  errors: [
    { label: '529 overloaded', kind: 'overloaded', request: request([predicate('p')]), arm: respond({}, 529) },
    { label: '503 unavailable', kind: 'overloaded', request: request([predicate('p')]), arm: respond({}, 503) },
    { label: '429 rate limited', kind: 'overloaded', request: request([predicate('p')]), arm: respond({}, 429) },
    {
      label: '401 rejected key',
      kind: 'rejected_key',
      request: request([predicate('p')]),
      arm: respond({ error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } }, 401),
    },
    {
      label: '404 unknown model',
      kind: 'upstream',
      request: request([predicate('p')]),
      arm: respond(fixture('err_unknown_model'), 404),
    },
    {
      label: '400 duplicate names',
      kind: 'invalid_request',
      request: request([predicate('p')]),
      arm: respond(fixture('err_dup_names'), 400),
    },
    {
      label: '400 bad question type',
      kind: 'invalid_request',
      request: request([predicate('p')]),
      arm: respond(fixture('err_bad_type'), 400),
    },
    {
      label: '400 context overflow',
      kind: 'context_length',
      request: request([predicate('p')]),
      arm: respond({ error: { message: 'Input too long', code: 'context_length_exceeded', param: 'input' } }, 400),
    },
    {
      label: 'a 200 that does not parse',
      kind: 'upstream',
      request: request([predicate('p')]),
      arm: respond({ answers: 'nope' }),
    },
  ],
});

describe('OpenAiDecisionProvider wire mapping', () => {
  const ctx = () => ({ apiKey: 'sk-test', logger: new Logger(), signal: AbortSignal.timeout(5_000) });

  it('sends json parts as text, images as input_image, and the safety identifier', async () => {
    let sent: unknown;
    server.use(
      http.post(URL_DECISIONS, async ({ request: incoming }) => {
        sent = await incoming.json();
        return HttpResponse.json(fixture('predicate') as Record<string, unknown>);
      })
    );

    await new OpenAiDecisionProvider().decide(
      {
        ...request(
          [predicate('is_urgent')],
          [
            { type: 'text', text: 'Payouts failing' },
            { type: 'json', json: { plan: 'pro' } },
            { type: 'image', dataUrl: PIXEL },
          ]
        ),
        safetyIdentifier: 'abc',
      },
      ctx()
    );

    expect(sent).toMatchObject({
      model: 'gpt-6-luna',
      safety_identifier: 'abc',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Payouts failing' },
            { type: 'input_text', text: '{"plan":"pro"}' },
            { type: 'input_image', image_url: PIXEL },
          ],
        },
      ],
      questions: [{ type: 'predicate', name: 'is_urgent' }],
    });
  });

  it('reads usage and the resolved model, and carries the vendor retry-after on overload', async () => {
    respond(fixture('choice'))();
    const decision = await new OpenAiDecisionProvider().decide(
      request([choice('team', ['billing', 'technical', 'sales'])]),
      ctx()
    );
    expect(decision).toMatchObject({ model: 'gpt-6-luna', usage: { inputTokens: 148, outputTokens: 0 } });

    respond({}, 529, { 'retry-after': '3' })();
    await expect(new OpenAiDecisionProvider().decide(request([predicate('p')]), ctx())).rejects.toMatchObject({
      kind: 'overloaded',
      details: { retryAfterMs: 3000 },
    });
  });

  it("maps the vendor's wrapped input path back to the caller's input index", async () => {
    respond(fixture('err_url_image'), 400)();
    await expect(new OpenAiDecisionProvider().decide(request([predicate('p')]), ctx())).rejects.toMatchObject({
      kind: 'invalid_request',
      details: { param: 'input[0]' },
    });
  });

  it('does not retry an exhausted quota as overload', async () => {
    respond({ error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } }, 429)();
    await expect(new OpenAiDecisionProvider().decide(request([predicate('p')]), ctx())).rejects.toMatchObject({
      kind: 'upstream',
    });
  });

  it('keeps the vendor param on an invalid request', async () => {
    respond(fixture('err_one_level'), 400)();
    await expect(new OpenAiDecisionProvider().decide(request([predicate('p')]), ctx())).rejects.toMatchObject({
      kind: 'invalid_request',
      details: { param: 'questions[0].levels' },
    });
  });
});
