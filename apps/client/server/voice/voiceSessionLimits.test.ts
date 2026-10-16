import { describe, it, expect } from 'vitest';
import { REALTIME_VOICE_HOLD_SECONDS, realtimeCreditsFloor, shouldReuseVoiceHold } from './voiceSessionLimits';

// Guards the money path: a reconnect must REUSE an existing credit hold rather
// than letting the bootstrap endpoint reserve (and charge) a second time. This
// tests the server's decision directly - inverting it would silently re-open the
// double-charge bug, which a client-side "did we send the flag?" assertion can't catch.
describe('shouldReuseVoiceHold', () => {
  const liveHold = { voiceReservedCredits: 100, voiceSessionStartedAt: new Date() };

  it('reuses the hold only on a reconnect into a session with a live reservation', () => {
    expect(shouldReuseVoiceHold(true, liveHold, false)).toBe(true);
  });

  it('does NOT reuse on a first connect (no reconnect flag), even with a live hold', () => {
    // Without this, a fresh connect to a session that still holds a reservation
    // would skip its own charge.
    expect(shouldReuseVoiceHold(false, liveHold, false)).toBe(false);
    expect(shouldReuseVoiceHold(undefined, liveHold, false)).toBe(false);
  });

  it('does NOT reuse on a reconnect when no live hold exists (raced with end / never recorded)', () => {
    expect(shouldReuseVoiceHold(true, null, false)).toBe(false);
    expect(shouldReuseVoiceHold(true, undefined, false)).toBe(false);
    expect(shouldReuseVoiceHold(true, { voiceReservedCredits: null, voiceSessionStartedAt: null }, false)).toBe(false);
  });

  it('requires BOTH reservation fields — a half-written record does not count as a live hold', () => {
    expect(shouldReuseVoiceHold(true, { voiceReservedCredits: 100, voiceSessionStartedAt: null }, false)).toBe(false);
    expect(shouldReuseVoiceHold(true, { voiceReservedCredits: null, voiceSessionStartedAt: new Date() }, false)).toBe(
      false
    );
  });

  it('treats only null as "no hold" — a numeric reservation (even 0) counts', () => {
    // The live-hold test is `!= null`, so the boundary is null vs. any number.
    // (In practice the field is a positive reserve when enforced, or null when not.)
    expect(shouldReuseVoiceHold(true, { voiceReservedCredits: 0, voiceSessionStartedAt: new Date() }, false)).toBe(
      true
    );
  });
});

describe('shouldReuseVoiceHold across call types', () => {
  const elevenLabsHold = { voiceReservedCredits: 100, voiceSessionStartedAt: new Date() };
  const realtimeHold = { ...elevenLabsHold, voiceBilledCredits: 0 };

  it('lets an ElevenLabs reconnect reuse only a hold without the realtime marker', () => {
    expect(shouldReuseVoiceHold(true, elevenLabsHold, false)).toBe(true);
    expect(shouldReuseVoiceHold(true, realtimeHold, false)).toBe(false);
    expect(shouldReuseVoiceHold(true, { ...elevenLabsHold, voiceBilledCredits: null }, false)).toBe(true);
  });

  it('lets a realtime reconnect reuse only a hold carrying the realtime marker', () => {
    expect(shouldReuseVoiceHold(true, realtimeHold, true)).toBe(true);
    expect(shouldReuseVoiceHold(true, { ...realtimeHold, voiceBilledCredits: 40 }, true)).toBe(true);
    expect(shouldReuseVoiceHold(true, elevenLabsHold, true)).toBe(false);
  });
});

describe('realtimeCreditsFloor', () => {
  it('is the hold pro rata over the hold duration, rounded up', () => {
    expect(realtimeCreditsFloor(77, 0)).toBe(0);
    expect(realtimeCreditsFloor(77, REALTIME_VOICE_HOLD_SECONDS / 2)).toBe(39);
  });

  it('never exceeds the hold', () => {
    expect(realtimeCreditsFloor(77, REALTIME_VOICE_HOLD_SECONDS * 3)).toBe(77);
  });
});

describe('shouldReuseVoiceHold past the hold window', () => {
  const now = new Date('2026-01-01T00:10:00Z');
  const startedAt = new Date(now.getTime() - 6 * 60 * 1000);

  it('refuses to reuse an ElevenLabs hold older than MAX_SESSION_SECONDS', () => {
    expect(
      shouldReuseVoiceHold(true, { voiceReservedCredits: 100, voiceSessionStartedAt: startedAt }, false, now)
    ).toBe(false);
  });

  it('refuses to reuse a realtime hold older than REALTIME_VOICE_HOLD_SECONDS', () => {
    const old = new Date(now.getTime() - (REALTIME_VOICE_HOLD_SECONDS + 1) * 1000);
    const hold = { voiceReservedCredits: 100, voiceSessionStartedAt: old, voiceBilledCredits: 0 };
    expect(shouldReuseVoiceHold(true, hold, true, now)).toBe(false);
    expect(shouldReuseVoiceHold(true, { ...hold, voiceSessionStartedAt: startedAt }, true, now)).toBe(true);
  });
});
