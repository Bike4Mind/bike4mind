import { describe, it, expect } from 'vitest';
import { shouldReuseVoiceHold } from './voiceSessionLimits';

// Guards the money path: a reconnect must REUSE an existing credit hold rather
// than letting the bootstrap endpoint reserve (and charge) a second time. This
// tests the server's decision directly - inverting it would silently re-open the
// double-charge bug, which a client-side "did we send the flag?" assertion can't catch.
describe('shouldReuseVoiceHold', () => {
  const liveHold = { voiceReservedCredits: 100, voiceSessionStartedAt: new Date(0) };

  it('reuses the hold only on a reconnect into a session with a live reservation', () => {
    expect(shouldReuseVoiceHold(true, liveHold)).toBe(true);
  });

  it('does NOT reuse on a first connect (no reconnect flag), even with a live hold', () => {
    // Without this, a fresh connect to a session that still holds a reservation
    // would skip its own charge.
    expect(shouldReuseVoiceHold(false, liveHold)).toBe(false);
    expect(shouldReuseVoiceHold(undefined, liveHold)).toBe(false);
  });

  it('does NOT reuse on a reconnect when no live hold exists (raced with end / never recorded)', () => {
    expect(shouldReuseVoiceHold(true, null)).toBe(false);
    expect(shouldReuseVoiceHold(true, undefined)).toBe(false);
    expect(shouldReuseVoiceHold(true, { voiceReservedCredits: null, voiceSessionStartedAt: null })).toBe(false);
  });

  it('requires BOTH reservation fields — a half-written record does not count as a live hold', () => {
    expect(shouldReuseVoiceHold(true, { voiceReservedCredits: 100, voiceSessionStartedAt: null })).toBe(false);
    expect(shouldReuseVoiceHold(true, { voiceReservedCredits: null, voiceSessionStartedAt: new Date(0) })).toBe(false);
  });

  it('treats only null as "no hold" — a numeric reservation (even 0) counts', () => {
    // The live-hold test is `!= null`, so the boundary is null vs. any number.
    // (In practice the field is a positive reserve when enforced, or null when not.)
    expect(shouldReuseVoiceHold(true, { voiceReservedCredits: 0, voiceSessionStartedAt: new Date(0) })).toBe(true);
  });
});
