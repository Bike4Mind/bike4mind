import { describe, expect, it } from 'vitest';
import type { ChatSessionStatus } from '@shared/chat';
import { needsYouBadgeCount } from '@shared/needsYou';
import type { WorkerTask } from '@shared/orchestration';
import { sessionFixture } from '../orchestrator/sessionFixture';
import { FAILED_FALLBACK_DETAIL, WAITING_FALLBACK_DETAIL, agentsBoard } from './agentsBoard';

const at = (minute: number) => `2026-11-25T10:${String(minute).padStart(2, '0')}:00.000Z`;

const blockedOn = (question: string): WorkerTask =>
  ({
    resolvedDecisions: [],
    state: {
      status: 'blocked',
      reason: 'Needs a choice',
      evidence: [],
      decision: {
        id: 'd1',
        askedAt: at(0),
        question: {
          header: 'Branch',
          question,
          options: [
            { label: 'main', description: 'The default' },
            { label: 'develop', description: 'The next release' },
          ],
        },
      },
    },
  }) as unknown as WorkerTask;

const SESSIONS = [
  sessionFixture('root', undefined, { title: 'Release prep', mode: 'code', updatedAt: at(1) }),
  sessionFixture('asks', 'root', { title: 'Pick a branch', updatedAt: at(9), workerTask: blockedOn('Which branch?') }),
  sessionFixture('approve', undefined, { title: 'Clean up', mode: 'chat', updatedAt: at(5) }),
  sessionFixture('broke', 'root', {
    title: 'Run tests',
    updatedAt: at(7),
    lastOutcome: 'failed',
    lastSnippet: 'Exit 1',
  }),
  sessionFixture('read', undefined, { title: 'Summary', mode: 'chat', updatedAt: at(8), lastSnippet: ' All done. ' }),
  sessionFixture('older', undefined, {
    title: 'Older reply',
    mode: 'studio',
    updatedAt: at(2),
    lastOutcome: 'finished',
  }),
  sessionFixture('busy', undefined, { updatedAt: at(30) }),
  sessionFixture('calm', undefined, { updatedAt: at(31) }),
  sessionFixture('shelved', undefined, { archived: true, updatedAt: at(32) }),
  sessionFixture('shelved-a', 'shelved', { updatedAt: at(33) }),
  sessionFixture('side', 'approve', {
    title: 'Aside',
    updatedAt: at(3),
    origin: { parentSessionId: 'approve', depth: 1, seedPrompt: 's', kind: 'side-chat' },
  }),
];

const STATUSES = new Map<string, ChatSessionStatus>([
  ['asks', 'needs-action'],
  ['approve', 'needs-action'],
  ['broke', 'needs-action'],
  ['read', 'needs-action'],
  ['older', 'needs-action'],
  ['side', 'needs-action'],
  ['busy', 'processing'],
  ['calm', 'done'],
  ['shelved', 'needs-action'],
  ['shelved-a', 'needs-action'],
]);

const UNREAD = new Set(['broke', 'read', 'older']);

const board = () => agentsBoard(SESSIONS, STATUSES, UNREAD);
const entry = (id: string) =>
  board()
    .flatMap(group => group.entries)
    .find(candidate => candidate.id === id);

describe('agentsBoard', () => {
  it('groups what waits on the user first, then failed turns, then unread replies, newest first in each', () => {
    expect(board().map(group => [group.label, group.entries.map(candidate => candidate.id)])).toEqual([
      ['Waiting on you', ['asks', 'approve', 'side']],
      ['Failed', ['broke']],
      ['Finished', ['read', 'older']],
    ]);
  });

  it('lists exactly the sessions the dock badge counts', () => {
    const rows = board().flatMap(group => group.entries).length;
    expect(rows).toBe(needsYouBadgeCount(STATUSES, SESSIONS));
  });

  it('leaves out running, settled and archived sessions, and anything under an archived one', () => {
    for (const id of ['busy', 'calm', 'shelved', 'shelved-a', 'root']) expect(entry(id)).toBeUndefined();
  });

  it('quotes the decision an agent asked, and says what a plain session waits on otherwise', () => {
    expect(entry('asks')?.detail).toBe('Which branch?');
    expect(entry('approve')?.detail).toBe(WAITING_FALLBACK_DETAIL);
  });

  it('quotes the last reply for finished and failed turns, trimmed, and nothing when there is none', () => {
    expect(entry('read')?.detail).toBe('All done.');
    expect(entry('broke')?.detail).toBe('Exit 1');
    expect(entry('older')).not.toHaveProperty('detail');
  });

  it('says a failed turn errored when it left no text to quote', () => {
    const silent = SESSIONS.map(session => (session.id === 'broke' ? { ...session, lastSnippet: undefined } : session));
    const failed = agentsBoard(silent, STATUSES, UNREAD).find(group => group.key === 'failed');
    expect(failed?.entries[0]?.detail).toBe(FAILED_FALLBACK_DETAIL);
  });

  it('names the conversation an agent or side chat belongs to', () => {
    expect(entry('asks')?.context).toBe('Agent of Release prep');
    expect(entry('side')?.context).toBe('Side chat of Clean up');
    expect(entry('approve')).not.toHaveProperty('context');
  });

  it('carries each session mode, so an entry can open in its place', () => {
    expect(entry('approve')?.mode).toBe('chat');
    expect(entry('older')?.mode).toBe('studio');
  });

  it('is empty when nothing needs the user', () => {
    expect(agentsBoard(SESSIONS, new Map([['busy', 'processing']]), new Set())).toEqual([]);
  });
});
