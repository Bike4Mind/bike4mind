import { describe, it, expect } from 'vitest';
import { isSessionActivatablePromptId, hasAuthoredSessionPrompt } from './sessionActivatablePrompts';

describe('isSessionActivatablePromptId', () => {
  it('admits the triage router', () => {
    expect(isSessionActivatablePromptId('triage_router')).toBe(true);
  });

  // `systemPromptId` arrives from the client via POST /api/sessions/create, so these are the cases
  // that matter: without the allowlist, any of them would resolve a real registry prompt and inject
  // it as the session's system message. Deleting the allowlist check turns these red.
  it('rejects an arbitrary client-supplied id', () => {
    expect(isSessionActivatablePromptId('anything')).toBe(false);
  });

  it('rejects a real registry prompt that is NOT session-activatable', () => {
    // Exists in the registry and would load fine; it is simply not a session-scoped mode.
    expect(isSessionActivatablePromptId('bike4mind_identity')).toBe(false);
  });

  it('rejects undefined and empty', () => {
    expect(isSessionActivatablePromptId(undefined)).toBe(false);
    expect(isSessionActivatablePromptId('')).toBe(false);
  });
});

describe('hasAuthoredSessionPrompt', () => {
  it('is true for raw authored text', () => {
    expect(hasAuthoredSessionPrompt({ systemPromptText: 'you are a bagel' })).toBe(true);
  });

  it('is true for an activatable registry id', () => {
    expect(hasAuthoredSessionPrompt({ systemPromptId: 'triage_router' })).toBe(true);
  });

  // The case this predicate exists for. A caller that tested `systemPromptId` for presence would
  // suppress the generic brand identity here, while the completion path resolves the id to null and
  // injects nothing - leaving the session with no authored prompt at all.
  it('is FALSE for a non-activatable id, so the generic prompt is not suppressed', () => {
    expect(hasAuthoredSessionPrompt({ systemPromptId: 'anything' })).toBe(false);
  });

  it('is false for no prompt at all', () => {
    expect(hasAuthoredSessionPrompt({})).toBe(false);
  });

  // Matches how ChatCompletionProcess resolves it (`systemPromptText?.trim()`), so the route and
  // the completion path cannot disagree about whether a session is authored.
  it('does not count whitespace-only text as authored', () => {
    expect(hasAuthoredSessionPrompt({ systemPromptText: '   ' })).toBe(false);
  });

  it('counts raw text even when a non-activatable id is also set', () => {
    expect(hasAuthoredSessionPrompt({ systemPromptText: 'real', systemPromptId: 'anything' })).toBe(true);
  });
});
