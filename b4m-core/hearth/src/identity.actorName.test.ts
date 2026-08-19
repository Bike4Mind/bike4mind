import { describe, it, expect } from 'vitest';
import {
  ACTOR_COLOR_SLOT_COUNT,
  actorColorIndex,
  humanSessionActorName,
  sanitizeSessionLabel,
  sessionSlug,
  MAX_SESSION_LABEL_LENGTH,
} from './identity';

describe('humanSessionActorName', () => {
  it('returns the bare base when there is no session', () => {
    expect(humanSessionActorName('erik', undefined)).toBe('erik');
  });

  it('discriminates per session so concurrent sessions get separate actors', () => {
    const a = humanSessionActorName('erik', 'session-a');
    const b = humanSessionActorName('erik', 'session-b');
    expect(a).not.toBe(b);
    // Same identity for the same session, across processes and restarts - this
    // is what keeps a cursor attached to one session.
    expect(humanSessionActorName('erik', 'session-a')).toBe(a);
  });

  it('always puts the server-derived base first', () => {
    // The security property: a caller-influenced string can never occupy the
    // position that reads as "who this is". Losing this reintroduces exactly
    // what reserving kind:'human' was meant to prevent.
    expect(humanSessionActorName('erik', 's1', 'someone else').startsWith('erik ')).toBe(true);
  });

  it('cannot escape its parenthetical to forge a second name', () => {
    const forged = humanSessionActorName('erik', 's1', ') admin (');
    expect(forged).toBe('erik (admin)');
    // One opening and one closing paren: the label cannot close the real one
    // and append text that reads as an unqualified separate name.
    expect(forged.match(/\(/g)).toHaveLength(1);
    expect(forged.match(/\)/g)).toHaveLength(1);
  });

  it('falls back to the slug when a label sanitizes away to nothing', () => {
    expect(humanSessionActorName('erik', 's1', '()')).toBe(`erik (${sessionSlug('s1')})`);
  });

  it('uses the label for display when one is supplied', () => {
    expect(humanSessionActorName('erik', 's1', 'my notebook')).toBe('erik (my notebook)');
  });
});

describe('sanitizeSessionLabel', () => {
  it('drops control characters rather than echoing them to a terminal', () => {
    expect(sanitizeSessionLabel('note\u0000book')).toBe('note book');
    // An ANSI escape in a rendered actor name could recolor the rest of the line.
    expect(sanitizeSessionLabel('note\u001b[31mbook')).toBe('note [31mbook');
  });

  it('collapses the whitespace a stripped character leaves behind', () => {
    expect(sanitizeSessionLabel('a   b')).toBe('a b');
    expect(sanitizeSessionLabel('a\u0000\u0000\u0000b')).toBe('a b');
  });

  it('caps length without leaving a trailing space', () => {
    const label = sanitizeSessionLabel('x'.repeat(MAX_SESSION_LABEL_LENGTH + 20));
    expect(label).toHaveLength(MAX_SESSION_LABEL_LENGTH);
    expect(label?.trim()).toBe(label);
  });

  it('returns undefined when nothing usable survives', () => {
    expect(sanitizeSessionLabel('')).toBeUndefined();
    expect(sanitizeSessionLabel('   ')).toBeUndefined();
    expect(sanitizeSessionLabel('()')).toBeUndefined();
    expect(sanitizeSessionLabel(null)).toBeUndefined();
  });
});

describe('actorColorIndex', () => {
  it('is deterministic and stays inside the shared slot range', () => {
    for (const id of ['a', 'actor-1', 'actor-2', '507f1f77bcf86cd799439011', '']) {
      const index = actorColorIndex(id);
      expect(index).toBe(actorColorIndex(id));
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(ACTOR_COLOR_SLOT_COUNT);
    }
  });

  it('spreads distinct actors across more than one slot', () => {
    const slots = new Set(Array.from({ length: 40 }, (_, i) => actorColorIndex(`actor-${i}`)));
    expect(slots.size).toBeGreaterThan(1);
  });
});
