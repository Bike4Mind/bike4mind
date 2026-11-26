import { MAX_SPAWN_DEPTH, type ChatSessionSummary } from '@shared/chat';
import type { WorkerTask } from '@shared/orchestration';
import { describe, expect, it } from 'vitest';
import { orchestratorIds, orchestratorLabels, toggledOrchestratorLabel } from './orchestratorIds';

const workerTask = {} as WorkerTask;
const child = (id: string, parentSessionId: string, extra: Partial<ChatSessionSummary> = {}) => ({
  id,
  origin: { parentSessionId, depth: 1, seedPrompt: 'go' },
  ...extra,
});
const sideChat = (id: string, parentSessionId: string) => ({
  id,
  origin: { parentSessionId, depth: 1, seedPrompt: 'go', kind: 'side-chat' as const },
});

describe('orchestratorIds', () => {
  it('marks a session with Orchestrate on, even before it has agents', () => {
    expect([...orchestratorIds([{ id: 'root', orchestrate: true }])]).toEqual(['root']);
  });

  it('keeps marking a toggle-on orchestrator after a relaunch drops the launch-scoped flag', () => {
    expect([...orchestratorIds([{ id: 'root', orchestrator: true }])]).toEqual(['root']);
  });

  it('leaves a session at the spawn-depth cap unmarked, since main ignores its Orchestrate flag', () => {
    const capped = {
      id: 'capped',
      orchestrate: true,
      orchestrator: true,
      origin: { parentSessionId: 'mid', depth: MAX_SPAWN_DEPTH, seedPrompt: 'go' },
    };
    expect(orchestratorIds([capped]).has('capped')).toBe(false);
  });

  it('marks the parent of a worker child', () => {
    const ids = orchestratorIds([{ id: 'root' }, child('agent', 'root', { workerTask })]);
    expect(ids.has('root')).toBe(true);
    expect(ids.has('agent')).toBe(false);
  });

  it('marks a parent whose agent started free-text sub-sessions, as a prompt or skill does', () => {
    const ids = orchestratorIds([{ id: 'root' }, child('kid', 'root'), { id: 'other', orchestrate: false }]);
    expect([...ids]).toEqual(['root']);
  });

  it('counts an archived agent child', () => {
    expect(orchestratorIds([{ id: 'root' }, child('kid', 'root', { archived: true })]).has('root')).toBe(true);
  });

  it('leaves a parent of side chats only unmarked', () => {
    expect(orchestratorIds([{ id: 'root' }, sideChat('side', 'root')]).size).toBe(0);
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

describe('orchestratorLabels overrides', () => {
  it("lets 'off' hide a session the rule marks, and 'on' show one it does not", () => {
    const { shown, automatic } = orchestratorLabels([
      { id: 'toggled', orchestrate: true, orchestratorLabel: 'off' },
      { id: 'parent', orchestratorLabel: 'off' },
      child('kid', 'parent'),
      { id: 'plain', orchestratorLabel: 'on' },
    ]);
    expect([...shown]).toEqual(['plain']);
    expect([...automatic].sort()).toEqual(['parent', 'toggled']);
  });
});

describe('toggledOrchestratorLabel', () => {
  it('sets an override only when the flip departs from the automatic rule', () => {
    expect(toggledOrchestratorLabel(true, true)).toBe('off');
    expect(toggledOrchestratorLabel(false, false)).toBe('on');
    expect(toggledOrchestratorLabel(false, true)).toBe('auto');
    expect(toggledOrchestratorLabel(true, false)).toBe('auto');
  });
});
