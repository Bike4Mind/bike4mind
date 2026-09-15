import { describe, it, expect } from 'vitest';
import { buildWorkflowState, withFlushedWorkflowState, type WorkflowStores } from './workflowState.js';
import type { Session, SessionHandoff, WorkflowDecision, WorkflowBlocker } from '../storage/types.js';

const decision: WorkflowDecision = {
  id: 'd1',
  summary: 'use zod',
  rationale: 'runtime validation',
  timestamp: '2026-01-01T00:00:00.000Z',
};

const blocker: WorkflowBlocker = {
  id: 'b1',
  description: 'waiting on preview deploy',
  status: 'open',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const handoff: SessionHandoff = {
  summary: 'prior session summary',
  keyFindings: [],
  nextSteps: [],
  pendingDecisions: [],
  blockers: [],
  generatedAt: '2026-01-01T00:00:00.000Z',
};

function stores(overrides: Partial<WorkflowStores> = {}): WorkflowStores {
  return {
    decisionStore: { decisions: [] },
    blockerStore: { blockers: [] },
    reviewGateStore: { reviewGates: [] },
    ...overrides,
  };
}

function session(workflow?: Session['metadata']['workflow']): Session {
  return {
    id: 's1',
    name: 's',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    model: 'claude-sonnet-4-6',
    messages: [],
    metadata: { totalTokens: 0, totalCost: 0, toolCallCount: 0, ...(workflow ? { workflow } : {}) },
  };
}

describe('buildWorkflowState', () => {
  it('returns undefined when every store is empty', () => {
    expect(buildWorkflowState(stores())).toBeUndefined();
  });

  it('assembles state from the stores', () => {
    const result = buildWorkflowState(stores({ decisionStore: { decisions: [decision] } }));
    expect(result).toEqual({ decisions: [decision], blockers: [], handoff: undefined, reviewGates: [] });
  });

  it('preserves the existing handoff', () => {
    const result = buildWorkflowState(stores({ blockerStore: { blockers: [blocker] } }), handoff);
    expect(result?.handoff).toBe(handoff);
  });

  it('copies the store arrays so the result does not alias the live stores', () => {
    const decisions = [decision];
    const result = buildWorkflowState(stores({ decisionStore: { decisions } }));
    decisions.push({ ...decision, id: 'd2' });
    // A push into the store after assembly must not leak into the snapshot.
    expect(result?.decisions).toHaveLength(1);
  });

  it('is non-empty when only review gates are present', () => {
    const result = buildWorkflowState(
      stores({
        reviewGateStore: {
          reviewGates: [
            { id: 'g1', timestamp: '2026-01-01T00:00:00.000Z', description: 'approve deploy', status: 'approved' },
          ],
        },
      })
    );
    expect(result).toBeDefined();
  });
});

describe('withFlushedWorkflowState', () => {
  it('returns the same reference when stores are empty (no hollow write)', () => {
    const s = session();
    expect(withFlushedWorkflowState(s, stores())).toBe(s);
  });

  it('flushes store state onto a copy without mutating the input', () => {
    const s = session();
    const flushed = withFlushedWorkflowState(s, stores({ decisionStore: { decisions: [decision] } }));
    expect(flushed).not.toBe(s);
    expect(flushed.metadata.workflow?.decisions).toEqual([decision]);
    expect(s.metadata.workflow).toBeUndefined();
  });

  it('carries an existing handoff forward through the flush', () => {
    const s = session({ decisions: [], blockers: [], handoff });
    const flushed = withFlushedWorkflowState(s, stores({ decisionStore: { decisions: [decision] } }));
    expect(flushed.metadata.workflow?.handoff).toBe(handoff);
    expect(flushed.metadata.workflow?.decisions).toEqual([decision]);
  });
});
