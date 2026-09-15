import { describe, expect, it } from 'vitest';
import { AGENT_EXECUTION_STATUSES } from '@bike4mind/common';
import { nodeStatusFromExecution } from './nodeStatusFromExecution';

describe('nodeStatusFromExecution', () => {
  it('completes a node when its run completed', () => {
    expect(nodeStatusFromExecution('completed')).toBe('completed');
  });

  it('fails a node when its run failed', () => {
    expect(nodeStatusFromExecution('failed')).toBe('failed');
  });

  it('fails a node when its run was aborted', () => {
    expect(nodeStatusFromExecution('aborted')).toBe('failed');
  });

  it.each(['pending', 'running', 'continuing', 'paused'] as const)('leaves the node alone while %s', status => {
    expect(nodeStatusFromExecution(status)).toBeNull();
  });

  // An execution parked on a permission prompt or a child run is NOT finished.
  // Mapping either to a terminal node status would let the Phase 2 scheduler
  // treat a paused run as done and release its dependents early.
  it.each(['awaiting_permission', 'awaiting_subagent', 'awaiting_dag_children'] as const)(
    'treats %s as still in flight',
    status => {
      expect(nodeStatusFromExecution(status)).toBeNull();
    }
  );

  it('handles every execution status without falling through to undefined', () => {
    for (const status of AGENT_EXECUTION_STATUSES) {
      const result = nodeStatusFromExecution(status);
      expect(result === null || typeof result === 'string').toBe(true);
    }
  });
});
