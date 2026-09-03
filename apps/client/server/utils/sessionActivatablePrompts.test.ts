import { describe, it, expect } from 'vitest';
import { isSessionActivatablePromptId } from './sessionActivatablePrompts';

describe('isSessionActivatablePromptId', () => {
  it('admits the triage router', () => {
    expect(isSessionActivatablePromptId('triage_router')).toBe(true);
  });

  // `systemPromptId` arrives from the client via POST /api/sessions/create, so these are the cases
  // that matter: without the allowlist, any of them would resolve a real registry prompt and inject
  // it as the session's system message.
  //
  // What these tests do and do not prove: deleting the membership check INSIDE this module turns
  // them red, so the policy itself is regression-locked. They do NOT prove the policy is enforced -
  // the call in sessionSystemPromptResolver is what enforces it, and no unit test here can see that
  // call go missing. sessionSystemPromptWiring.test.ts covers that separately.
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
