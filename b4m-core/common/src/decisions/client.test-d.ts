import { describe, expectTypeOf, it } from 'vitest';
import { createDecisionsClient } from './client';

const client = createDecisionsClient({ baseUrl: 'https://b4m.test', apiKey: 'k' });

describe('decide answer types', () => {
  it('infers literal answer types from inline question definitions', async () => {
    const decision = await client.decide({
      model: 'gpt-6-luna',
      input: 'x',
      questions: [
        { type: 'predicate', name: 'is_urgent', instructions: 'Needs a reply within 24 hours.' },
        {
          type: 'choice',
          name: 'team',
          instructions: 'Which team?',
          choices: [{ value: 'billing' }, { value: 'sales' }],
        },
        { type: 'score', name: 'mood', instructions: 'How upset?', levels: [{ label: 'calm' }, { label: 'angry' }] },
      ],
    });

    const { team, is_urgent: urgent, mood } = decision.byName;
    expectTypeOf(team.type).toEqualTypeOf<'choice' | 'refusal'>();
    if (team.type === 'choice') {
      expectTypeOf(team.choice).toEqualTypeOf<'billing' | 'sales'>();
      expectTypeOf(team.probabilities[0].value).toEqualTypeOf<'billing' | 'sales'>();
    }
    if (urgent.type === 'predicate') expectTypeOf(urgent.probability).toEqualTypeOf<number>();
    if (mood.type === 'score') expectTypeOf(mood.probabilities[0].label).toEqualTypeOf<'calm' | 'angry'>();
    expectTypeOf(decision.byName).not.toHaveProperty('missing');
  });
});
