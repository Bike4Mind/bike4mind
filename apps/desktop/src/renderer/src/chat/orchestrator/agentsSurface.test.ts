// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isOrchestratorSession, type ChatSessionSummary } from '@shared/chat';
import { archivedAgentsOf } from '@shared/spawnTree';
import { agentStates } from './roster';
import { agentsSurfaceAvailable } from './agentsSurface';
import { readSurface } from './orchestratorPrefs';

const NOW = '2026-11-26T00:00:00.000Z';

function session(id: string, extra: Partial<ChatSessionSummary> = {}): ChatSessionSummary {
  return {
    id,
    title: id,
    model: 'm',
    createdAt: NOW,
    updatedAt: NOW,
    mode: 'code',
    approvalMode: 'ask',
    messageCount: 1,
    ...extra,
  } as ChatSessionSummary;
}

const child = (id: string, parentId: string, extra: Partial<ChatSessionSummary> = {}) =>
  session(id, { origin: { parentSessionId: parentId, depth: 1, seedPrompt: 'go' }, ...extra });

/** What ChatShell asks, from the same inputs it has: the session list and the root. */
function surfaceFor(sessions: ChatSessionSummary[], rootId: string, orchestrateCapable = true): boolean {
  return agentsSurfaceAvailable({
    session: sessions.find(candidate => candidate.id === rootId),
    hasAgents: agentStates(sessions, new Map(), rootId).length > 0,
    hasArchivedAgents: archivedAgentsOf(sessions, rootId).length > 0,
    orchestrateCapable,
  });
}

describe('isOrchestratorSession', () => {
  it('is true while Orchestrate is on, and after it expires with the launch', () => {
    expect(isOrchestratorSession({ orchestrate: true })).toBe(true);
    expect(isOrchestratorSession({ orchestrator: true })).toBe(true);
    expect(isOrchestratorSession({})).toBe(false);
  });
});

describe('agentsSurfaceAvailable', () => {
  it('keeps Agent View for an orchestrator once every agent is archived', () => {
    const sessions = [
      session('root', { orchestrate: true, orchestrator: true }),
      child('a', 'root', { archived: true }),
    ];
    expect(surfaceFor(sessions, 'root')).toBe(true);
  });

  it('keeps it after a relaunch has expired the orchestrate flag', () => {
    const sessions = [session('root', { orchestrator: true }), child('a', 'root', { archived: true })];
    expect(surfaceFor(sessions, 'root')).toBe(true);
  });

  it('keeps it for a session whose agents were started without Orchestrate and then archived', () => {
    const sessions = [session('root'), child('a', 'root', { archived: true })];
    expect(surfaceFor(sessions, 'root')).toBe(true);
    expect(surfaceFor(sessions, 'root', false), 'archived agents need no spawn capability').toBe(true);
  });

  it('still opens such a session on chat: availability does not pick the view', () => {
    window.localStorage.clear();
    expect(surfaceFor([session('root'), child('a', 'root', { archived: true })], 'root')).toBe(true);
    expect(readSurface('root')).toBe('chat');
  });

  it('does not give it to a session that never started an agent', () => {
    expect(
      surfaceFor(
        [
          session('root'),
          child('side', 'root', {
            origin: { parentSessionId: 'root', depth: 1, seedPrompt: 'q', kind: 'side-chat' },
            archived: true,
          }),
        ],
        'root'
      )
    ).toBe(false);
  });

  it('still shows live agents of any session', () => {
    expect(surfaceFor([session('root'), child('a', 'root')], 'root')).toBe(true);
  });

  it('gives no empty stage to an orchestrator that could start no agent', () => {
    expect(surfaceFor([session('root', { orchestrator: true })], 'root', false)).toBe(false);
  });

  it('is false with no session', () => {
    expect(
      agentsSurfaceAvailable({
        session: undefined,
        hasAgents: false,
        hasArchivedAgents: false,
        orchestrateCapable: true,
      })
    ).toBe(false);
  });
});

describe('archivedAgentsOf', () => {
  it('lists agents archived out of the live tree, newest first, not those shelved under an archived one', () => {
    const sessions = [
      session('root', { orchestrator: true }),
      child('old', 'root', { archived: true, createdAt: '2026-11-25T00:00:00.000Z' }),
      child('new', 'root', { archived: true, createdAt: '2026-11-26T01:00:00.000Z' }),
      child('live', 'root'),
      child('nested', 'live', { archived: true, origin: { parentSessionId: 'live', depth: 2, seedPrompt: 'go' } }),
      child('shelved', 'old', { archived: true, origin: { parentSessionId: 'old', depth: 2, seedPrompt: 'go' } }),
      child('side', 'root', {
        archived: true,
        origin: { parentSessionId: 'root', depth: 1, seedPrompt: 'q', kind: 'side-chat' },
      }),
      child('elsewhere', 'other', { archived: true }),
    ];
    expect(archivedAgentsOf(sessions, 'root').map(agent => agent.id)).toEqual(['new', 'nested', 'old']);
  });
});
