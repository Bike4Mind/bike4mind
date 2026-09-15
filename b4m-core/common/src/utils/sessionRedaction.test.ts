import { describe, it, expect } from 'vitest';
import { SERVER_OWNED_SESSION_FIELDS, redactSessionForClient, redactSessionsForClient } from './sessionRedaction';

describe('redactSessionForClient', () => {
  const base = {
    id: 'sess-1',
    name: 'My session',
    userId: 'user-1',
    systemPromptText: 'PROPRIETARY SERVER-OWNED PROMPT',
  };

  it('strips systemPromptText from the returned object', () => {
    const out = redactSessionForClient(base);
    expect(out).not.toHaveProperty('systemPromptText');
    expect(JSON.stringify(out)).not.toContain('PROPRIETARY');
  });

  it('preserves all other fields', () => {
    const out = redactSessionForClient(base);
    expect(out).toMatchObject({ id: 'sess-1', name: 'My session', userId: 'user-1' });
  });

  it('does NOT mutate the input (the engine reads systemPromptText off the shared object)', () => {
    const input = { ...base };
    redactSessionForClient(input);
    // Server-path safety: the in-memory session the completion engine consumes is untouched.
    expect(input.systemPromptText).toBe('PROPRIETARY SERVER-OWNED PROMPT');
  });

  it('passes null/undefined through unchanged', () => {
    expect(redactSessionForClient(null)).toBeNull();
    expect(redactSessionForClient(undefined)).toBeUndefined();
  });

  it('is a no-op (besides copy) when the field is absent', () => {
    const noPrompt = { id: 'sess-2', name: 'x', userId: 'u' };
    expect(redactSessionForClient(noPrompt)).toEqual(noPrompt);
  });

  it('normalizes a Mongoose-like document via toJSON before stripping', () => {
    // Mongoose docs hold data in internal state; spreading them is wrong - the helper must
    // call toJSON() first (duck-typed). Simulate a doc whose enumerable props are internal.
    const doc = {
      $__: { internal: true },
      _doc: { id: 'sess-3', name: 'doc', userId: 'u', systemPromptText: 'SECRET' },
      toJSON() {
        return { ...this._doc };
      },
    };
    const out = redactSessionForClient(doc as never) as Record<string, unknown>;
    expect(out).toMatchObject({ id: 'sess-3', name: 'doc' });
    expect(out).not.toHaveProperty('systemPromptText');
    expect(out).not.toHaveProperty('_doc');
    expect(out).not.toHaveProperty('$__');
  });

  it('keeps SERVER_OWNED_SESSION_FIELDS as the single source of truth', () => {
    expect(SERVER_OWNED_SESSION_FIELDS).toContain('systemPromptText');
  });
});

describe('redactSessionsForClient', () => {
  it('strips the field from every element', () => {
    const sessions = [
      { id: 'a', userId: 'u1', systemPromptText: 'P1' },
      { id: 'b', userId: 'u2', systemPromptText: 'P2' },
    ];
    const out = redactSessionsForClient(sessions);
    expect(out).toHaveLength(2);
    for (const s of out) {
      expect(s).not.toHaveProperty('systemPromptText');
    }
    // originals untouched
    expect(sessions[0].systemPromptText).toBe('P1');
  });

  it('returns an empty array unchanged', () => {
    expect(redactSessionsForClient([])).toEqual([]);
  });
});
