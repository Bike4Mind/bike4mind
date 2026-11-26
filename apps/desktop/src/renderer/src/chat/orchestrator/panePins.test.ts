import { describe, expect, it } from 'vitest';
import type { ChatSessionSummary } from '@shared/chat';
import { sessionFixture as pinSession } from './sessionFixture';
import { MAX_OTHER_PIN_OPTIONS, pinLabel, pinOptions, relationTo, resolvePaneSession } from './panePins';

// grand -> active -> (c1, c2); other1 orchestrates; other2 has an agent; plain has neither.
const SESSIONS = [
  pinSession('grand', undefined, { orchestrate: true }),
  pinSession('active', 'grand'),
  pinSession('c1', 'active', { updatedAt: '2026-01-02T00:00:00.000Z' }),
  pinSession('c2', 'active', { updatedAt: '2026-01-03T00:00:00.000Z' }),
  pinSession('other1', undefined, { orchestrate: true, updatedAt: '2026-01-04T00:00:00.000Z' }),
  pinSession('other2', undefined, { updatedAt: '2026-01-05T00:00:00.000Z' }),
  pinSession('other2-agent', 'other2'),
  pinSession('plain'),
  pinSession('gone', undefined, { orchestrate: true, archived: true }),
];

describe('resolvePaneSession', () => {
  const context = { activeId: 'active', sessions: SESSIONS, split: true };

  it('shows the pinned session in a split', () => {
    expect(resolvePaneSession({ sessionId: 'other1' }, context)?.id).toBe('other1');
  });

  it.each([
    ['no pin', undefined],
    ['a pin to the active session', 'active'],
    ['a pin to a session no longer listed', 'deleted'],
  ])('follows the active session for %s', (_label, sessionId) => {
    expect(resolvePaneSession({ sessionId }, context)).toBeUndefined();
  });

  it('follows the active session in a single pane, whatever its pin', () => {
    expect(resolvePaneSession({ sessionId: 'other1' }, { ...context, split: false })).toBeUndefined();
  });
});

describe('relationTo', () => {
  it('names the parent, a child and anything else', () => {
    const byId = (id: string) => SESSIONS.find(session => session.id === id) as ChatSessionSummary;
    expect(relationTo(byId('grand'), 'active', SESSIONS)).toBe('parent');
    expect(relationTo(byId('c1'), 'active', SESSIONS)).toBe('child');
    expect(relationTo(byId('other1'), 'active', SESSIONS)).toBe('other');
  });
});

describe('pinOptions', () => {
  it('lists the parent, then the children newest first, then other orchestrations newest first', () => {
    expect(pinOptions('active', SESSIONS)).toEqual([
      { sessionId: 'grand', relation: 'parent', label: 'Parent: Title grand' },
      { sessionId: 'c2', relation: 'child', label: 'Child: Title c2' },
      { sessionId: 'c1', relation: 'child', label: 'Child: Title c1' },
      { sessionId: 'other2', relation: 'other', label: 'Title other2' },
      { sessionId: 'other1', relation: 'other', label: 'Title other1' },
    ]);
  });

  it('names sessions by relation alone in Presenter mode', () => {
    const labels = pinOptions('active', SESSIONS, { presenting: true }).map(option => option.label);
    expect(labels).toEqual(['Parent session', 'Child session 1', 'Child session 2', 'Session 1', 'Session 2']);
    expect(labels.join(' ')).not.toContain('Title');
  });

  it('caps the other orchestrations', () => {
    const many = Array.from({ length: MAX_OTHER_PIN_OPTIONS + 4 }, (_, index) =>
      pinSession(`o${index}`, undefined, { orchestrate: true })
    );
    expect(pinOptions(undefined, many)).toHaveLength(MAX_OTHER_PIN_OPTIONS);
  });
});

describe('pinLabel', () => {
  it("uses the option's label, and a generic one in Presenter mode for a session past the cap", () => {
    const grand = SESSIONS[0];
    expect(pinLabel(grand, 'active', SESSIONS)).toBe('Parent: Title grand');
    const plain = SESSIONS.find(session => session.id === 'plain') as ChatSessionSummary;
    expect(pinLabel(plain, 'active', SESSIONS)).toBe('Title plain');
    expect(pinLabel(plain, 'active', SESSIONS, { presenting: true })).toBe('Pinned session');
  });
});
