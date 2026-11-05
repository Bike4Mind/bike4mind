import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundAgentManager } from '../agents/BackgroundAgentManager.js';
import type { SubagentOrchestrator } from '../agents/SubagentOrchestrator.js';
import { useCliStore } from '../store/index.js';
import {
  forgetBackgroundCompletions,
  forgetReleasedAgents,
  sessionBackgroundCallbacks,
} from './backgroundCallbacks.js';
import { releaseSession, type SessionResources } from './releaseSession.js';

const settle = () => new Promise(resolve => setImmediate(resolve));

afterEach(() => {
  useCliStore.setState({
    pendingBackgroundTrigger: false,
    completedGroupNotifications: [],
    backgroundAgents: [],
    liveSubagentUsage: {},
  });
});

/** A session whose one background agent, spawned in a turn, runs until it is aborted. */
function sessionWithBackgroundAgent(isCurrent: () => boolean) {
  const delegateToAgent = vi.fn(
    ({ abortSignal }: { abortSignal: AbortSignal }) =>
      new Promise((_resolve, reject) => abortSignal.addEventListener('abort', () => reject(new Error('aborted'))))
  );
  const manager = new BackgroundAgentManager({ delegateToAgent } as unknown as SubagentOrchestrator);
  const callbacks = sessionBackgroundCallbacks(isCurrent);
  manager.setOnStatusChange(callbacks.onBackgroundStatusChange);
  manager.setOnGroupCompletion(callbacks.onGroupCompletion);
  manager.setCurrentTurn('turn-1');
  manager.spawn({ task: 'survey the repo', agentName: 'explore', parentSessionId: 's', resumeId: 'r' });
  manager.setCurrentTurn(null);
  const resources: SessionResources = {
    abortTurn: null,
    killShellSessions: () => 0,
    killBangCommands: () => {},
    commandHistory: { whenIdle: async () => {} },
    saveSession: null,
    mcpManager: null,
    featureRegistry: null,
    wsManager: null,
    clearWebSocketToolExecutor: () => {},
    stopBridgePresence: async () => {},
    agent: null,
    backgroundManager: manager,
    imageStore: null,
  };
  return { manager, resources };
}

describe('sessionBackgroundCallbacks', () => {
  it('queues a background turn when a group of the current session finishes', async () => {
    const { manager } = sessionWithBackgroundAgent(() => true);

    manager.cancelJob(manager.listJobs()[0].id);
    await settle();

    expect(useCliStore.getState().pendingBackgroundTrigger).toBe(true);
  });

  it('starts no turn in the next session when a released session cancels its background agents', async () => {
    let generation = 1;
    const { resources } = sessionWithBackgroundAgent(() => generation === 1);

    generation = 2;
    await releaseSession(resources, 1_000);
    await settle();

    expect(useCliStore.getState().pendingBackgroundTrigger).toBe(false);
    expect(useCliStore.getState().completedGroupNotifications).toEqual([]);
  });
});

describe('forgetReleasedAgents', () => {
  it("shows none of a released session's agents as still running", async () => {
    let generation = 1;
    const { manager, resources } = sessionWithBackgroundAgent(() => generation === 1);
    useCliStore.getState().updateLiveSubagentUsage('run-old', 'explore', 10, 1);
    useCliStore.getState().updateLiveSubagentUsage('run-other', 'explore', 10, 1);
    const jobIds = manager.listJobs().map(job => job.id);
    expect(useCliStore.getState().backgroundAgents.map(job => job.id)).toEqual(jobIds);

    generation = 2;
    await releaseSession(resources, 1_000);
    await settle();
    forgetReleasedAgents(jobIds, ['run-old']);

    expect(useCliStore.getState().backgroundAgents).toEqual([]);
    expect(Object.keys(useCliStore.getState().liveSubagentUsage)).toEqual(['run-other']);
  });
});

describe('forgetBackgroundCompletions', () => {
  it('drops a background turn the released session left pending', () => {
    useCliStore.getState().addCompletedGroupNotification('[Background Agents Completed] 1 agent finished');
    useCliStore.getState().setPendingBackgroundTrigger(true);

    forgetBackgroundCompletions();

    expect(useCliStore.getState().pendingBackgroundTrigger).toBe(false);
    expect(useCliStore.getState().completedGroupNotifications).toEqual([]);
  });
});
