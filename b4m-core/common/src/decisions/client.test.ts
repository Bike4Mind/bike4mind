import { describe, expect, it, vi } from 'vitest';
import type { DecisionResponse } from '../schemas/decisions';
import { createDecisionsClient, DecisionsApiError } from './client';

const response: DecisionResponse = {
  id: 'dec_1',
  object: 'decision',
  model: 'gpt-6-luna',
  answers: [
    { type: 'predicate', name: 'is_urgent', probability: 0.93 },
    {
      type: 'choice',
      name: 'team',
      choice: 'billing',
      probabilities: [
        { value: 'billing', probability: 0.9 },
        { value: 'sales', probability: 0.1 },
      ],
      confidence: 0.8,
    },
  ],
  usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 },
};

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

const questions = [
  { type: 'predicate', name: 'is_urgent', instructions: 'Needs a reply within 24 hours.' },
  { type: 'choice', name: 'team', instructions: 'Which team?', choices: [{ value: 'billing' }, { value: 'sales' }] },
] as const;

describe('createDecisionsClient', () => {
  it('posts the request with the bearer key and indexes answers by name', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(response));
    const client = createDecisionsClient({ baseUrl: 'https://b4m.test/', apiKey: 'b4m_live_x', fetch: fetchMock });

    const decision = await client.decide({ model: 'gpt-6-luna', input: 'Payouts failing', questions });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://b4m.test/api/v1/decisions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer b4m_live_x' }),
      })
    );
    expect(decision.byName.team).toMatchObject({ type: 'choice', choice: 'billing' });
    expect(decision.byName.is_urgent).toMatchObject({ probability: 0.93 });
  });

  it('surfaces the error envelope, param and Retry-After on failure', async () => {
    const client = createDecisionsClient({
      baseUrl: 'https://b4m.test',
      apiKey: 'k',
      fetch: async () =>
        jsonResponse(
          { error: 'Provider overloaded', errorCode: 'provider_overloaded' },
          { status: 503, headers: { 'retry-after': '2' } }
        ),
    });

    const error = await client
      .decide({ model: 'gpt-6-luna', input: 'x', questions })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DecisionsApiError);
    expect(error).toMatchObject({ status: 503, errorCode: 'provider_overloaded', retryAfterSeconds: 2 });
  });

  it('decideMany keeps input order, caps concurrency and isolates failures', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight -= 1;
      const { input } = JSON.parse(String(init?.body)) as { input: string };
      return input === 'bad'
        ? jsonResponse({ error: 'nope' }, { status: 422 })
        : jsonResponse({ ...response, id: input });
    });
    const client = createDecisionsClient({ baseUrl: 'https://b4m.test', apiKey: 'k', fetch: fetchMock });

    const results = await client.decideMany(
      ['a', 'bad', 'c', 'd'],
      { model: 'gpt-6-luna', questions },
      { concurrency: 2 }
    );

    expect(peak).toBe(2);
    expect(results.map(result => (result.ok ? result.decision.id : 'error'))).toEqual(['a', 'error', 'c', 'd']);
  });
});
