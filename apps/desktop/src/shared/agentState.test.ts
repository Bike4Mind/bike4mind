import { describe, expect, it } from 'vitest';
import type { WorkerTask } from './orchestration';
import { deriveTaskAgentState, isUpdateOnlyTask, MISSING_TASK_RESULT_REASON } from './agentState';

const completed = (accepted: boolean): WorkerTask['state'] => ({
  status: 'completed',
  accepted,
  changedPaths: [],
  verification: [],
  unmetCriteria: [],
  handoff: 'Ready',
});
const states: [string, WorkerTask['state'], boolean][] = [
  ['accepted', completed(true), true],
  ['unaccepted', completed(false), false],
  ['missing result', { status: 'blocked', reason: MISSING_TASK_RESULT_REASON, evidence: [] }, true],
  ['blocker', { status: 'blocked', reason: 'Missing access', evidence: [] }, false],
  [
    'decision',
    {
      status: 'blocked',
      reason: MISSING_TASK_RESULT_REASON,
      evidence: [],
      decision: {
        id: 'decision',
        askedAt: '2026-11-19',
        question: {
          header: 'Branch',
          question: 'Which branch?',
          options: [
            { label: 'main', description: '' },
            { label: 'develop', description: '' },
          ],
        },
      },
    },
    false,
  ],
];

describe.each(states)('%s attention', (_label, state, updateOnly) => {
  it.each([true, false, undefined])('preserves required decisions when attentionViewed=%s', attentionViewed => {
    const workerTask = { state, attentionViewed } as WorkerTask;
    const done =
      updateOnly && (attentionViewed === true || (state.status === 'completed' && attentionViewed === undefined));
    expect(isUpdateOnlyTask(state)).toBe(updateOnly);
    expect(deriveTaskAgentState({ workerTask, lastOutcome: 'finished' }, undefined)).toBe(done ? 'done' : 'needs-you');
    expect(deriveTaskAgentState({ workerTask, lastOutcome: 'finished' }, 'needs-action')).toBe('needs-you');
    expect(deriveTaskAgentState({ workerTask, lastOutcome: 'finished' }, 'processing')).toBe('working');
  });
});
