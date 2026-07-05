import { describe, it, expect } from 'vitest';
import { shouldAttemptSessionOpen } from './SessionContainer';

// Guards the fix for the 404 retry loop: changeSession must be attempted at most
// once per session id, even when the open keeps failing and contextSessionId
// never advances.
describe('shouldAttemptSessionOpen', () => {
  const SID = 'sess-1';

  it('attempts the open for a fresh, loaded session not yet in context', () => {
    expect(shouldAttemptSessionOpen(SID, null, false, null)).toBe(true);
  });

  it('does NOT re-attempt a session that was already attempted (failed-open safety net)', () => {
    // contextSessionId stayed null because the previous open rejected (404/5xx/network).
    // Without this guard the effect would re-fire changeSession on every render.
    expect(shouldAttemptSessionOpen(SID, null, false, SID)).toBe(false);
  });

  it('does NOT attempt when the session already matches context (successful open)', () => {
    expect(shouldAttemptSessionOpen(SID, SID, false, SID)).toBe(false);
  });

  it('does NOT attempt while the route is still loading', () => {
    expect(shouldAttemptSessionOpen(SID, null, true, null)).toBe(false);
  });

  it('does NOT attempt when there is no routed session id', () => {
    expect(shouldAttemptSessionOpen(undefined, null, false, null)).toBe(false);
  });

  it('attempts a newly selected session even if a different one was attempted before', () => {
    expect(shouldAttemptSessionOpen('sess-2', null, false, SID)).toBe(true);
  });
});
