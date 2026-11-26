import { describe, expect, it } from 'vitest';
import { createSessionTurnContract } from './sessionTurns.contract';
import { assertContractConventions } from '../assertContractConventions';
import { SessionTurnRequestSchema, SessionTurnStreamEventSchema } from '../../schemas/sessionTurns';

const validBody = { session_id: '664f1c2b9a1e4d0012ab34cd', message: 'hi', model: 'claude-opus-4-8' };

describe('createSessionTurn contract', () => {
  it('pins the operation id, path, verb, auth and scope', () => {
    const { operationId, method, path, auth, scopes, streaming } = createSessionTurnContract;
    expect({ operationId, method, path, auth, scopes, streaming }).toEqual({
      operationId: 'createSessionTurn',
      method: 'post',
      path: '/api/v1/turns',
      auth: 'apiKeyOrJwt',
      scopes: ['ai:chat'],
      streaming: true,
    });
  });

  it('passes the public API convention gate', () => {
    expect(() => assertContractConventions([createSessionTurnContract])).not.toThrow();
  });

  it('accepts a minimal turn and one carrying every optional field', () => {
    expect(SessionTurnRequestSchema.safeParse(validBody).success).toBe(true);
    const full = {
      ...validBody,
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 1000,
      thinking: { enabled: true, budget_tokens: 2000 },
      message_file_ids: ['f1'],
      fab_file_ids: ['f2'],
      history_count: 0,
      prompt_mode: 'raw',
      organization_id: null,
      client_submitted_at: 1_700_000_000_000,
    };
    expect(SessionTurnRequestSchema.safeParse(full).success).toBe(true);
  });

  it.each([
    ['a missing session_id', { message: 'hi', model: 'm' }],
    ['an empty message', { ...validBody, message: '' }],
    ['a missing model', { session_id: 's', message: 'hi' }],
    ['a negative history_count', { ...validBody, history_count: -1 }],
    ['an unknown prompt_mode', { ...validBody, prompt_mode: 'bare' }],
    ['a temperature out of range', { ...validBody, temperature: 3 }],
  ])('rejects %s', (_label, body) => {
    expect(SessionTurnRequestSchema.safeParse(body).success).toBe(false);
  });

  it('parses every event the stream sends', () => {
    const events = [
      { type: 'meta', requestId: 'r1' },
      { type: 'turn', quest_id: 'q1', session_id: 's1' },
      { type: 'delta', quest_id: 'q1', slot: 0, text: 'Hel' },
      { type: 'replace', quest_id: 'q1', slot: 1, text: 'Rewritten' },
      {
        type: 'settled',
        quest_id: 'q1',
        status: 'stopped',
        failed: true,
        credits_used: 3,
        error_code: 'insufficient_credits',
      },
      { type: 'error', message: 'Lost track of the turn', requestId: 'r1' },
    ];
    for (const event of events) expect(SessionTurnStreamEventSchema.safeParse(event).success).toBe(true);
  });

  it('rejects a settled event with a non-terminal status', () => {
    expect(SessionTurnStreamEventSchema.safeParse({ type: 'settled', quest_id: 'q1', status: 'running' }).success).toBe(
      false
    );
  });
});
