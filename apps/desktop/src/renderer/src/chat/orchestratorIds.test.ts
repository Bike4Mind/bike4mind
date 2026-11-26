import { MAX_SPAWN_DEPTH, type ChatSessionSummary } from '@shared/chat';
import type { WorkerTask } from '@shared/orchestration';
import { describe, expect, it } from 'vitest';
import { orchestratorIds } from './orchestratorIds';

const workerTask = {} as WorkerTask;
const child = (id: string, parentSessionId: string, extra: Partial<ChatSessionSummary> = {}) => ({
  id,
  origin: { parentSessionId, depth: 1, seedPrompt: 'go' },
  ...extra,
});

describe('orchestratorIds', () => {
  it('marks a session with Orchestrate on, even before it has agents', () => {
    expect([...orchestratorIds([{ id: 'root', orchestrate: true }])]).toEqual(['root']);
  });

  it('leaves a session at the spawn-depth cap unmarked, since main ignores its Orchestrate flag', () => {
    const capped = {
      id: 'capped',
      orchestrate: true,
      origin: { parentSessionId: 'mid', depth: MAX_SPAWN_DEPTH, seedPrompt: 'go' },
    };
    expect(orchestratorIds([capped]).size).toBe(0);
  });

  it('marks the parent of a worker child once the orchestrate flag has lapsed', () => {
    const ids = orchestratorIds([{ id: 'root' }, child('agent', 'root', { workerTask })]);
    expect(ids.has('root')).toBe(true);
    expect(ids.has('agent')).toBe(false);
  });

  it('leaves a parent of plain spawned sub-sessions unmarked', () => {
    expect(orchestratorIds([{ id: 'root' }, child('kid', 'root'), { id: 'other', orchestrate: false }]).size).toBe(0);
  });

  it('marks an agent that orchestrates workers of its own', () => {
    const ids = orchestratorIds([
      { id: 'root', orchestrate: true },
      child('lead', 'root', { workerTask }),
      child('worker', 'lead', { workerTask }),
    ]);
    expect([...ids].sort()).toEqual(['lead', 'root']);
  });
});
