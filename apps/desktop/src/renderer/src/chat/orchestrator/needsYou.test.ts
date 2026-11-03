import type { ChatMessage, ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import { assignPersonas } from './tavern/agentPersona';
import { buildRoster } from './roster';
import { enteredNeedsYou, needsYouBody, needsYouCount, needsYouTitle, rootSessionOf } from './needsYou';

const session = (id: string, parentId?: string, title = `Session ${id}`): ChatSessionSummary =>
  ({
    id,
    title,
    mode: 'code',
    messageCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...(parentId && { origin: { parentSessionId: parentId, seedPrompt: `seed ${id}` } }),
  }) as ChatSessionSummary;

const statuses = (entries: Record<string, ChatSessionStatus>): ReadonlyMap<string, ChatSessionStatus> =>
  new Map(Object.entries(entries));

describe('enteredNeedsYou', () => {
  it('lists only the sessions that just moved into needs-action', () => {
    const before = statuses({ a: 'processing', b: 'needs-action', c: 'done' });
    const after = statuses({ a: 'needs-action', b: 'needs-action', c: 'done', d: 'needs-action' });
    expect(enteredNeedsYou(before, after)).toEqual(['a', 'd']);
  });

  it('counts a session again after it left needs-action and came back', () => {
    const left = statuses({ a: 'processing' });
    expect(enteredNeedsYou(statuses({ a: 'needs-action' }), left)).toEqual([]);
    expect(enteredNeedsYou(left, statuses({ a: 'needs-action' }))).toEqual(['a']);
  });
});

describe('needsYouCount', () => {
  const listed = [session('a'), session('b'), session('c')];

  it('counts every listed session waiting on the user', () => {
    expect(needsYouCount(statuses({ a: 'needs-action', b: 'processing', c: 'needs-action' }), listed)).toBe(2);
    expect(needsYouCount(new Map(), listed)).toBe(0);
  });

  it('skips archived sessions and sessions that are no longer listed', () => {
    const sessions = [session('a'), { ...session('b'), archived: true }];
    expect(needsYouCount(statuses({ a: 'needs-action', b: 'needs-action', gone: 'needs-action' }), sessions)).toBe(1);
  });
});

describe('rootSessionOf', () => {
  it('walks up the spawn chain to the session that started it', () => {
    const sessions = [session('root'), session('child', 'root'), session('grandchild', 'child')];
    expect(rootSessionOf(sessions, 'grandchild')).toBe('root');
    expect(rootSessionOf(sessions, 'root')).toBe('root');
  });

  it('stops at the last listed ancestor, and survives a loop', () => {
    expect(rootSessionOf([session('child', 'gone')], 'child')).toBe('child');
    const looped = [session('a', 'b'), session('b', 'a')];
    expect(['a', 'b']).toContain(rootSessionOf(looped, 'a'));
  });
});

describe('needsYouTitle', () => {
  it('names an agent by the persona the Tavern shows, and a root by its title', () => {
    const sessions = [session('root', undefined, 'Audit'), session('child', 'root', 'Review the auth middleware')];
    const persona = assignPersonas(
      buildRoster({ sessions, statuses: new Map(), activity: new Map(), prSummaries: new Map(), rootId: 'root' })
    ).get('child');
    expect(needsYouTitle(sessions, new Map(), 'child', 'root')).toBe(`${persona?.label} needs you`);
    expect(needsYouTitle(sessions, new Map(), 'root', 'root')).toBe('Audit needs you');
  });

  it('falls back to a generic name for a session that is not listed', () => {
    expect(needsYouTitle([], new Map(), 'ghost', 'ghost')).toBe('A session needs you');
  });
});

describe('needsYouBody', () => {
  const at = '2026-10-01T00:00:00.000Z';
  it('describes the request parked at the approval gate', () => {
    const messages = [
      {
        id: 'm1',
        role: 'assistant',
        content: '',
        createdAt: at,
        toolCalls: [
          { id: 'c1', name: 'bash', input: { command: 'pnpm test' }, status: 'awaiting-approval', approvalId: 'ap1' },
        ],
      },
    ] as ChatMessage[];
    expect(needsYouBody(messages)).toBe('bash pnpm test');
  });

  it('says it is waiting when there is no parked call to describe', () => {
    expect(needsYouBody([])).toBe('Waiting for your answer');
  });
});
