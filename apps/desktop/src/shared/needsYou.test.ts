import { describe, expect, it } from 'vitest';
import { assignPersonas } from './agentPersona';
import {
  alertableSessions,
  enteredNeedsYou,
  needsYouBadgeCount,
  needsYouBody,
  needsYouCount,
  needsYouTitle,
  rootSessionOf,
} from './needsYou';
import {
  NEEDS_YOU_AMBER,
  NEEDS_YOU_MIN_DELTA_E,
  contrastRatio,
  deltaE,
  looksLikeNeedsYou,
  needsYouLookalikeKeys,
} from './needsYouColor';
import type { ChatMessage, ChatSessionStatus, ChatSessionSummary } from './chat';

describe('needsYou', () => {
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
    const listed = [session('a'), session('b'), session('a1', 'a'), session('b1', 'b')];

    it('counts waiting sessions in an agent tree, parent and agents alike', () => {
      expect(needsYouCount(statuses({ a: 'needs-action', a1: 'needs-action', b1: 'processing' }), listed)).toBe(2);
      expect(needsYouCount(new Map(), listed)).toBe(0);
    });

    it('counts task attention only while its sidebar status needs action', () => {
      const task = (state: object, id: string) =>
        ({ ...session(id, 'root'), workerTask: { state } }) as unknown as ChatSessionSummary;
      const sessions = [
        session('root'),
        task({ status: 'completed', accepted: false }, 'done-unaccepted'),
        task({ status: 'completed', accepted: true }, 'done-accepted'),
        task({ status: 'queued' }, 'queued'),
        task({ status: 'running' }, 'running'),
      ];
      expect(needsYouCount(statuses({}), sessions)).toBe(0);
      expect(needsYouCount(statuses({ 'done-unaccepted': 'needs-action' }), sessions)).toBe(1);
    });

    it('skips plain sessions, archived ones, those under an archived agent, and unlisted ones', () => {
      const sessions = [
        session('plain'),
        session('root'),
        { ...session('shelved', 'root'), archived: true },
        session('under', 'shelved'),
        session('live', 'root'),
      ];
      const waiting = statuses({
        plain: 'needs-action',
        shelved: 'needs-action',
        under: 'needs-action',
        live: 'needs-action',
        gone: 'needs-action',
      });
      expect(needsYouCount(waiting, sessions)).toBe(1);
      expect([...alertableSessions(sessions)].sort()).toEqual(['live', 'root']);
      expect([...alertableSessions(sessions, 'agents')].sort()).toEqual(['live', 'root']);
    });

    it('with the all scope, counts plain sessions too, but still not archived or unlisted ones', () => {
      const sessions = [
        session('plain'),
        { ...session('stored'), archived: true },
        session('root'),
        { ...session('shelved', 'root'), archived: true },
        session('under', 'shelved'),
        session('live', 'root'),
      ];
      const waiting = statuses({
        plain: 'needs-action',
        stored: 'needs-action',
        shelved: 'needs-action',
        under: 'needs-action',
        live: 'needs-action',
        gone: 'needs-action',
      });
      expect(needsYouCount(waiting, sessions, 'all')).toBe(2);
      expect([...alertableSessions(sessions, 'all')].sort()).toEqual(['live', 'plain', 'root']);
    });

    it('with the all scope, counts a lone plain session that is waiting', () => {
      const sessions = [session('chat')];
      expect(needsYouCount(statuses({ chat: 'needs-action' }), sessions, 'all')).toBe(1);
      expect(needsYouCount(statuses({ chat: 'needs-action' }), sessions, 'agents')).toBe(0);
      expect(needsYouCount(statuses({ chat: 'processing' }), sessions, 'all')).toBe(0);
    });
  });

  describe('needsYouBadgeCount', () => {
    it('counts a waiting plain session that the default notify scope leaves out', () => {
      const sessions = [session('chat'), session('root'), session('agent', 'root')];
      const waiting = statuses({ chat: 'needs-action', agent: 'needs-action' });
      expect(needsYouCount(waiting, sessions)).toBe(1);
      expect(needsYouBadgeCount(waiting, sessions)).toBe(2);
    });

    it('leaves archived and deleted sessions out', () => {
      const sessions = [{ ...session('shelved'), archived: true }, session('live')];
      const waiting = statuses({ shelved: 'needs-action', live: 'needs-action', gone: 'needs-action' });
      expect(needsYouBadgeCount(waiting, sessions)).toBe(1);
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
      const persona = assignPersonas([
        {
          id: 'child',
          createdAt: '2026-10-01T00:00:00.000Z',
          title: 'Review the auth middleware',
          seedPrompt: 'seed child',
        },
      ]).get('child');
      expect(persona?.epithet).toBe('Warden');
      expect(persona?.label).toBe(persona?.name);
      expect(needsYouTitle(sessions, 'child', 'root')).toBe(`${persona?.label} needs you`);
      expect(needsYouTitle(sessions, 'root', 'root')).toBe('Audit needs you');
    });

    it('falls back to a generic name for a session that is not listed', () => {
      expect(needsYouTitle([], 'ghost', 'ghost')).toBe('A session needs you');
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
});

describe('needsYouColor', () => {
  describe('looksLikeNeedsYou', () => {
    it.each([
      ['the exact amber', NEEDS_YOU_AMBER, true],
      ['a near amber', '#f0c050', true],
      ['a saturated gold', '#ffcc00', true],
      ['the built-in working orange', '#ff9d3c', false],
      ['a clearly different blue', '#3cc8ff', false],
    ])('%s (%s): %s', (_label, color, expected) => {
      expect(looksLikeNeedsYou(color)).toBe(expected);
    });

    it('measures distance in Lab, symmetric and zero for the same colour', () => {
      expect(deltaE(NEEDS_YOU_AMBER, NEEDS_YOU_AMBER)).toBe(0);
      expect(deltaE('#f0c050', NEEDS_YOU_AMBER)).toBeCloseTo(deltaE(NEEDS_YOU_AMBER, '#f0c050'));
      expect(deltaE('#ff9d3c', NEEDS_YOU_AMBER)).toBeGreaterThan(NEEDS_YOU_MIN_DELTA_E);
    });
  });

  describe('contrastRatio', () => {
    it('is 21 for black on white, 1 for a colour on itself, and symmetric', () => {
      expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21);
      expect(contrastRatio('#3cc8ff', '#3cc8ff')).toBe(1);
      expect(contrastRatio('#0f1a24', '#f0f4f8')).toBeCloseTo(contrastRatio('#f0f4f8', '#0f1a24'));
    });
  });

  describe('needsYouLookalikeKeys', () => {
    it('names each state and surface key too close to the amber, not the needs-you state itself', () => {
      const keys = needsYouLookalikeKeys({
        states: { 'needs-you': NEEDS_YOU_AMBER, working: '#f0c050', done: '#b48cff' },
        surfaces: { stage: '#0f1a24', card: NEEDS_YOU_AMBER },
      });
      expect(keys).toEqual(['states.working', 'surfaces.card']);
    });

    it('is empty for a skin with no colours', () => {
      expect(needsYouLookalikeKeys({})).toEqual([]);
    });
  });
});
