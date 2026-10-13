import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { z } from 'zod';
import type { DecisionQuestion } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { describeDecisionProviderConformance } from '../conformance';
import type { DecisionProviderRequest } from '../types';
import { SystemOneDecisionProvider, readSystemOneErrorMessage } from './SystemOneDecisionProvider';

const URL_SYSTEMONE = 'https://api.typesafe.ai/v1/systemone';

// Bare vendor bodies from the recorder (systemOne/__fixtures__/record.ts), with their HTTP statuses in statuses.json.
// Keys starting with '_' are metadata (e.g. `_provisional` while the files are hand-written).
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../__fixtures__/systemOne/${name}.json`, import.meta.url), 'utf8'));

const statuses = Object.fromEntries(
  Object.entries(z.record(z.string(), z.unknown()).parse(fixture('statuses'))).filter(([key]) => !key.startsWith('_'))
);
const statusOf = (name: string): number => z.number().int().parse(statuses[name]);

const VendorAnswersSchema = z.object({
  answers: z.record(z.string(), z.object({ confidence: z.number().optional() }).loose()),
});
const vendorConfidence = (name: string, question: string): number | undefined =>
  VendorAnswersSchema.parse(fixture(name)).answers[question].confidence;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const respond =
  (body: unknown, status = 200, headers: Record<string, string> = {}, url = URL_SYSTEMONE) =>
  () =>
    server.use(http.post(url, () => HttpResponse.json(body as Record<string, unknown>, { status, headers })));
const respondWithFixture = (name: string) => respond(fixture(name), statusOf(name));

const request = (
  questions: DecisionQuestion[],
  input: DecisionProviderRequest['input'] = 'Help, payouts failing.',
  model: DecisionProviderRequest['model'] = 'jev-1.13.0'
): DecisionProviderRequest => ({ model, input, questions });

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

const TEAM = choice('team', ['billing', 'technical', 'sales']);
const FRUSTRATION = score('frustration', ['calm', 'frustrated', 'angry']);
const LANGUAGE = choice('language', ['en', 'de', 'fr', 'es', 'it', 'pt', 'ja']);

describeDecisionProviderConformance('TypeSafe', {
  provider: () => new SystemOneDecisionProvider(),
  answers: [
    { label: 'a predicate', request: request([predicate('is_urgent')]), arm: respondWithFixture('noul') },
    {
      label: 'a choice',
      request: request([TEAM]),
      arm: respondWithFixture('choice'),
      vendorConfidence: [vendorConfidence('choice', 'team')],
    },
    {
      label: 'a choice with many options',
      request: request([LANGUAGE]),
      arm: respondWithFixture('choice_many'),
      vendorConfidence: [vendorConfidence('choice_many', 'language')],
    },
    {
      label: 'a score',
      request: request([FRUSTRATION]),
      arm: respondWithFixture('score'),
      vendorConfidence: [vendorConfidence('score', 'frustration')],
    },
    {
      label: 'an ambiguous score',
      request: request([score('severity', ['Cosmetic', 'Workaround available', 'Fully blocked'])]),
      arm: respondWithFixture('score_ambiguous'),
      vendorConfidence: [vendorConfidence('score_ambiguous', 'severity')],
    },
    {
      label: 'one of each question type',
      request: request([predicate('is_urgent'), TEAM, FRUSTRATION]),
      arm: respondWithFixture('multi'),
      vendorConfidence: [undefined, vendorConfidence('multi', 'team'), vendorConfidence('multi', 'frustration')],
    },
  ],
  errors: [
    { label: '529 overloaded', kind: 'overloaded', request: request([predicate('p')]), arm: respond({}, 529) },
    { label: '503 unavailable', kind: 'overloaded', request: request([predicate('p')]), arm: respond({}, 503) },
    { label: '429 rate limited', kind: 'overloaded', request: request([predicate('p')]), arm: respond({}, 429) },
    {
      label: '401 rejected key',
      kind: 'rejected_key',
      request: request([predicate('p')]),
      arm: respondWithFixture('err_bad_key'),
    },
    {
      label: 'a bad question type',
      kind: 'invalid_request',
      request: request([predicate('p')]),
      arm: respondWithFixture('err_bad_type'),
    },
    {
      label: 'empty choice criteria',
      kind: 'invalid_request',
      request: request([predicate('p')]),
      arm: respondWithFixture('err_bad_criteria'),
    },
    {
      label: 'too many choices',
      kind: 'invalid_request',
      request: request([predicate('p')]),
      arm: respondWithFixture('err_too_many_choices'),
    },
    {
      label: 'an unknown model (catalog drift)',
      kind: 'upstream',
      request: request([predicate('p')]),
      arm: respondWithFixture('err_unknown_model'),
    },
    {
      label: 'a 200 that does not parse',
      kind: 'upstream',
      request: request([predicate('p')]),
      arm: respond({ answers: 'nope' }),
    },
  ],
});

describe('SystemOneDecisionProvider wire mapping', () => {
  const ctx = () => ({ apiKey: 'ts-test', logger: new Logger(), signal: AbortSignal.timeout(5_000) });

  type Posted = { body: Record<string, unknown>; authorization: string | null };
  const capture = (name: string) => {
    const posted: Posted[] = [];
    server.use(
      http.post(URL_SYSTEMONE, async ({ request: incoming }) => {
        posted.push({
          body: z.record(z.string(), z.unknown()).parse(await incoming.json()),
          authorization: incoming.headers.get('authorization'),
        });
        return HttpResponse.json(fixture(name) as Record<string, unknown>, { status: statusOf(name) });
      })
    );
    return posted;
  };

  it('posts a string state, Bearer auth and one question of each type without a safety identifier', async () => {
    const posted = capture('multi');
    const questions: DecisionQuestion[] = [
      predicate('is_urgent'),
      { ...TEAM, choices: [{ value: 'billing', description: 'Payments' }, { value: 'technical' }, { value: 'sales' }] },
      {
        ...FRUSTRATION,
        levels: [{ label: 'calm', description: 'No irritation' }, { label: 'frustrated' }, { label: 'angry' }],
      },
    ];

    await new SystemOneDecisionProvider().decide({ ...request(questions), safetyIdentifier: 'abc' }, ctx());

    expect(posted).toHaveLength(1);
    expect(posted[0].authorization).toBe('Bearer ts-test');
    expect(posted[0].body).toEqual({
      model: 'jev-1.13.0',
      state: 'Help, payouts failing.',
      questions: {
        is_urgent: { type: 'noul', instructions: 'Is it true?' },
        team: {
          type: 'choice',
          instructions: 'Pick one.',
          criteria: { billing: 'Payments', technical: null, sales: null },
        },
        frustration: { type: 'score', instructions: 'Rate it.', criteria: ['No irritation', 'frustrated', 'angry'] },
      },
    });
    expect(posted[0].body).not.toHaveProperty('safety_identifier');
  });

  it('keeps choice criteria in request order', async () => {
    const posted = capture('choice_many');
    await new SystemOneDecisionProvider().decide(request([LANGUAGE]), ctx());
    const questions = z
      .record(z.string(), z.object({ criteria: z.record(z.string(), z.null()) }))
      .parse(posted[0].body.questions);
    expect(Object.keys(questions.language.criteria)).toEqual(['en', 'de', 'fr', 'es', 'it', 'pt', 'ja']);
  });

  it.each([
    ['a lone json part as the state itself', [{ type: 'json' as const, json: { plan: 'pro' } }], { plan: 'pro' }],
    ['a lone json array as a one-item string array', [{ type: 'json' as const, json: [1, 2] }], ['[1,2]']],
    [
      'several parts as strings, json serialized',
      [
        { type: 'text' as const, text: 'Payouts failing' },
        { type: 'json' as const, json: { plan: 'pro' } },
      ],
      ['Payouts failing', '{"plan":"pro"}'],
    ],
    ['a lone text part as a one-item array', [{ type: 'text' as const, text: 'Payouts failing' }], ['Payouts failing']],
  ])('sends %s', async (_label, input, expectedState) => {
    const posted = capture('noul');
    await new SystemOneDecisionProvider().decide(request([predicate('is_urgent')], input), ctx());
    expect(posted[0].body.state).toEqual(expectedState);
  });

  it('keeps a lone json object native and serializes a lone json array', async () => {
    const posted = capture('noul');
    const provider = new SystemOneDecisionProvider();
    await provider.decide(request([predicate('is_urgent')], [{ type: 'json', json: { plan: 'pro' } }]), ctx());
    await provider.decide(request([predicate('is_urgent')], [{ type: 'json', json: ['a', 'b'] }]), ctx());
    expect(posted.map(({ body }) => body.state)).toEqual([{ plan: 'pro' }, ['["a","b"]']]);
  });

  it('rejects an image part as an invalid request without calling the vendor', async () => {
    await expect(
      new SystemOneDecisionProvider().decide(
        request([predicate('is_urgent')], [{ type: 'image', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }]),
        ctx()
      )
    ).rejects.toMatchObject({ kind: 'invalid_request' });
  });

  it('re-orders choice probabilities to the request order and ignores the vendor confidence', async () => {
    respondWithFixture('choice_many')();
    // The recording came back in request order, so ask in reverse to make the two orders differ.
    const reversed = choice('language', ['ja', 'pt', 'it', 'es', 'fr', 'de', 'en']);
    const decision = await new SystemOneDecisionProvider().decide(request([reversed]), ctx());
    const [answer] = decision.answers;
    expect(answer.type).toBe('choice');
    if (answer.type !== 'choice') return;
    expect(Object.keys(answer.probabilities)).toEqual(['ja', 'pt', 'it', 'es', 'fr', 'de', 'en']);
    expect(answer.probabilities.de).toBe(1);
    expect(answer.probabilities.en).toBe(0);
    expect(answer).not.toHaveProperty('confidence');
  });

  it('turns score probabilities keyed by level index into a level-ordered distribution', async () => {
    respondWithFixture('score')();
    const decision = await new SystemOneDecisionProvider().decide(request([FRUSTRATION]), ctx());
    expect(decision.answers[0]).toEqual({ type: 'score', probabilities: { 0: 0.01, 1: 0.97, 2: 0.02 } });
  });

  it('returns the versioned model and the vendor usage as-is', async () => {
    respondWithFixture('choice')();
    const decision = await new SystemOneDecisionProvider().decide(
      request([TEAM], 'Help, payouts failing.', 'jev-latest'),
      ctx()
    );
    expect(decision).toMatchObject({ model: 'jev-1.13.0', usage: { inputTokens: 316, outputTokens: 38 } });
  });

  it('posts to a custom base URL', async () => {
    const posted: string[] = [];
    server.use(
      http.post('https://laya.internal.example/v1/systemone', ({ request: incoming }) => {
        posted.push(incoming.url);
        return HttpResponse.json(fixture('noul') as Record<string, unknown>);
      })
    );
    await new SystemOneDecisionProvider('https://laya.internal.example').decide(
      request([predicate('is_urgent')]),
      ctx()
    );
    expect(posted).toEqual(['https://laya.internal.example/v1/systemone']);
  });

  it.each([429, 529])('carries the vendor retry-after on a %i', async status => {
    respond({}, status, { 'retry-after': '3' })();
    await expect(new SystemOneDecisionProvider().decide(request([predicate('p')]), ctx())).rejects.toMatchObject({
      kind: 'overloaded',
      details: { status, retryAfterMs: 3000 },
    });
  });

  it.each(['err_bad_type', 'err_bad_criteria'])(
    'keeps the vendor wording out of the message and in raw for %s',
    async name => {
      respondWithFixture(name)();
      const error: unknown = await new SystemOneDecisionProvider()
        .decide(request([predicate('p')]), ctx())
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind: 'invalid_request', message: 'The decision provider rejected the request.' });
      expect((error as { details: { raw: { message: string } } }).details.raw.message).toMatch(/\S/);
    }
  );

  it.each([404, 405, 409, 413])('maps a %i to upstream, not a caller error', async status => {
    respond({ detail: 'Not Found' }, status)();
    await expect(new SystemOneDecisionProvider().decide(request([predicate('p')]), ctx())).rejects.toMatchObject({
      kind: 'upstream',
      message: `TypeSafe returned ${status}`,
      details: { status },
    });
  });

  it('logs the status but not the vendor message for a rejected request', async () => {
    respondWithFixture('err_bad_type')();
    const logger = new Logger();
    const warn = vi.spyOn(logger, 'warn');
    await expect(
      new SystemOneDecisionProvider().decide(request([predicate('p')]), { ...ctx(), logger })
    ).rejects.toMatchObject({ kind: 'invalid_request' });
    const expected = readSystemOneErrorMessage(fixture('err_bad_type'));
    expect(expected).toMatch(/\S/);
    expect(warn).toHaveBeenCalledWith(
      'systemone_request_rejected',
      expect.objectContaining({ status: 400, unknownModel: false })
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(expected);
  });

  it('accepts a single-level score body without judging it; level counts are enforced upstream of the adapter', async () => {
    respondWithFixture('err_one_level')();
    const decision = await new SystemOneDecisionProvider().decide(request([score('q', ['only'])]), ctx());
    expect(decision.answers[0]).toEqual({ type: 'score', probabilities: { 0: 1 } });
  });

  it('treats a choice probability key the question does not have as an upstream error', async () => {
    respond({
      model: 'jev-1.13.0',
      answers: {
        team: { type: 'choice', choice: 'billing', probabilities: { billing: 0.5, technical: 0.3, other: 0.2 } },
      },
      usage: { input_tokens: 10, output_tokens: 5 },
    })();
    await expect(new SystemOneDecisionProvider().decide(request([TEAM]), ctx())).rejects.toMatchObject({
      kind: 'upstream',
    });
  });

  it('treats a missing probability key as an upstream error', async () => {
    respond({
      model: 'jev-1.13.0',
      answers: { frustration: { type: 'score', score: 1, probabilities: { '0': 0.4, '1': 0.6 } } },
      usage: { input_tokens: 10, output_tokens: 5 },
    })();
    await expect(new SystemOneDecisionProvider().decide(request([FRUSTRATION]), ctx())).rejects.toMatchObject({
      kind: 'upstream',
    });
  });

  it('treats a missing or mistyped answer as an upstream error', async () => {
    respondWithFixture('noul')();
    await expect(new SystemOneDecisionProvider().decide(request([TEAM]), ctx())).rejects.toMatchObject({
      kind: 'upstream',
    });
  });
});
