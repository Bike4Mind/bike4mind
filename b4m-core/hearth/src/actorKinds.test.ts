import { describe, it, expect } from 'vitest';
import { ACTOR_KIND_LABELS, ACTOR_KIND_MARKERS, actorKindLabel, actorKindMarker } from './actorKinds';
import { actorKindSchema } from './schemas';
import type { ActorKind } from './types';

describe('actor kind labels', () => {
  // The badge is rendered unconditionally on every row, so a kind the maps do
  // not cover is a blank chip - and blank reads as "no kind stated", the
  // opposite of what the anti-spoofing badge is there to say.
  it('covers every kind the boundary schema accepts', () => {
    for (const kind of actorKindSchema.options) {
      expect(ACTOR_KIND_LABELS[kind]).toBeTruthy();
      expect(ACTOR_KIND_MARKERS[kind]).toHaveLength(1);
    }
  });

  it('falls back to Unknown rather than blank for a kind this build does not know', () => {
    // What the SPA actually receives when a newer server adds a kind: the WS
    // payload is a bare cast, so the value arrives unvalidated.
    const future = 'satellite' as ActorKind;
    expect(actorKindLabel(future)).toBe('Unknown');
    expect(actorKindMarker(future)).toBe('?');
    expect(actorKindLabel(undefined)).toBe('Unknown');
    expect(actorKindMarker(undefined)).toBe('?');
  });
});
