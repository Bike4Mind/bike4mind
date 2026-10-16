import { describe, expect, it } from 'vitest';
import {
  MAX_BATCH_EVENTS,
  MAX_DURATION_MS,
  clampDuration,
  isValidEvent,
  nextBatch,
  toolCategory,
  type ActivityEvent,
} from './activityContract';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');

const session = (id: string, over: Partial<ActivityEvent> = {}): ActivityEvent =>
  ({
    eventId: id,
    occurredAt: new Date(NOW - 60_000).toISOString(),
    durationMs: 1000,
    type: 'session',
    sessionId: 'session-0001',
    ...over,
  }) as ActivityEvent;

describe('isValidEvent mirrors Fleet', () => {
  it('accepts session, tool and repository events', () => {
    expect(isValidEvent(session('event-0001'), NOW)).toBe(true);
    expect(isValidEvent({ ...session('event-0002'), type: 'tool', tool: { type: 'shell' } }, NOW)).toBe(true);
    expect(
      isValidEvent(
        { ...session('event-0003'), type: 'repository', repository: { owner: 'acme', name: 'app', action: 'edit' } },
        NOW
      )
    ).toBe(true);
  });

  it('refuses what Fleet refuses', () => {
    expect(isValidEvent(session('short'), NOW)).toBe(false);
    expect(isValidEvent(session('event-0001', { occurredAt: '2026-10-16T11:59:00Z' }), NOW)).toBe(false);
    expect(
      isValidEvent(session('event-0001', { occurredAt: new Date(NOW - 31 * 86_400_000).toISOString() }), NOW)
    ).toBe(false);
    expect(isValidEvent(session('event-0001', { occurredAt: new Date(NOW + 10 * 60_000).toISOString() }), NOW)).toBe(
      false
    );
    expect(isValidEvent(session('event-0001', { durationMs: MAX_DURATION_MS + 1 }), NOW)).toBe(false);
    expect(isValidEvent(session('event-0001', { durationMs: 1.5 }), NOW)).toBe(false);
    expect(
      isValidEvent(
        { ...session('event-0003'), type: 'repository', repository: { owner: '-bad', name: 'app', action: 'edit' } },
        NOW
      )
    ).toBe(false);
  });
});

describe('nextBatch', () => {
  it('takes at most 24 events with unique ids', () => {
    const events = Array.from({ length: 30 }, (_, i) => session(`event-${String(i).padStart(4, '0')}`));
    const batch = nextBatch([...events, events[0]]);
    expect(batch?.events).toHaveLength(MAX_BATCH_EVENTS);
    expect(new Set(batch?.events.map(event => event.eventId)).size).toBe(MAX_BATCH_EVENTS);
    expect(batch).toMatchObject({ version: 1, consent: true });
  });

  it('returns null for an empty queue', () => {
    expect(nextBatch([])).toBeNull();
  });
});

describe('toolCategory', () => {
  it('maps tool names to the categories Fleet accepts, never passing the name through', () => {
    expect(toolCategory('bash_execute')).toBe('shell');
    expect(toolCategory('file_edit')).toBe('editor');
    expect(toolCategory('apply_patch')).toBe('editor');
    expect(toolCategory('browser_click')).toBe('browser');
    expect(toolCategory('mcp__github__create_issue')).toBe('mcp');
    expect(toolCategory('session_spawn')).toBe('agent');
    expect(toolCategory('generate_image')).toBe('other');
  });
});

describe('clampDuration', () => {
  it('clamps into 0..24h and rounds', () => {
    expect(clampDuration(-5)).toBe(0);
    expect(clampDuration(Number.NaN)).toBe(0);
    expect(clampDuration(12.6)).toBe(13);
    expect(clampDuration(MAX_DURATION_MS * 2)).toBe(MAX_DURATION_MS);
  });
});
