import { describe, it, expect, vi, beforeEach } from 'vitest';

// These tests pin the contract between the persisted `error.timedOut`
// flag and the snapshot's `isTimeout` field. Locks in the read side of the
// "no more substring matching on error.message" refactor.

const { mockFindChildExecutions } = vi.hoisted(() => ({
  mockFindChildExecutions: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  agentExecutionRepository: {
    findChildExecutions: mockFindChildExecutions,
  },
}));

import { buildChildExecutionSnapshots } from './childExecutionSnapshot';

function makeChild(overrides: Record<string, unknown>) {
  return {
    id: 'child-1',
    status: 'failed',
    model: 'claude-sonnet-4-6',
    subagentConfig: { agentName: 'Explore' },
    result: undefined,
    checkpoint: undefined,
    error: undefined,
    totalCreditsUsed: 0,
    ...overrides,
  };
}

describe('buildChildExecutionSnapshots — isTimeout sourced from error.timedOut', () => {
  beforeEach(() => {
    mockFindChildExecutions.mockReset();
  });

  it('surfaces isTimeout: true when error.timedOut is true', async () => {
    mockFindChildExecutions.mockResolvedValueOnce([
      makeChild({
        error: { message: 'Subagent stopped before Lambda deadline', timedOut: true },
      }),
    ]);
    mockFindChildExecutions.mockResolvedValueOnce([]); // recursive: no grandchildren

    const snapshots = await buildChildExecutionSnapshots('parent-1');

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].isTimeout).toBe(true);
  });

  it('surfaces isTimeout: false when error.timedOut is false', async () => {
    mockFindChildExecutions.mockResolvedValueOnce([
      makeChild({
        error: { message: 'LLM API returned 500', timedOut: false },
      }),
    ]);
    mockFindChildExecutions.mockResolvedValueOnce([]); // recursive: no grandchildren

    const snapshots = await buildChildExecutionSnapshots('parent-1');

    expect(snapshots[0].isTimeout).toBe(false);
  });

  it('surfaces isTimeout: undefined for legacy docs without the field', async () => {
    // Legacy doc written before the typed field landed - must NOT be guessed
    // from message text. The previous substring heuristic would have
    // false-positived on "fetch timeout" here; the new code surfaces undefined.
    mockFindChildExecutions.mockResolvedValueOnce([
      makeChild({
        error: { message: 'fetch timeout while reading subagent metadata' },
      }),
    ]);
    mockFindChildExecutions.mockResolvedValueOnce([]); // recursive: no grandchildren

    const snapshots = await buildChildExecutionSnapshots('parent-1');

    expect(snapshots[0].isTimeout).toBeUndefined();
  });

  it('surfaces isTimeout: undefined when error is absent (no failure)', async () => {
    mockFindChildExecutions.mockResolvedValueOnce([
      makeChild({ status: 'completed', error: undefined, result: { answer: 'done', steps: [] } }),
    ]);
    mockFindChildExecutions.mockResolvedValueOnce([]); // recursive: no grandchildren

    const snapshots = await buildChildExecutionSnapshots('parent-1');

    expect(snapshots[0].isTimeout).toBeUndefined();
  });
});

// Replay path must include grandchildren so the "Show reasoning"
// disclosure renders the full nesting tree, not just the first level.
describe('buildChildExecutionSnapshots — recursive grandchild inclusion', () => {
  beforeEach(() => {
    mockFindChildExecutions.mockReset();
  });

  it('includes grandchildren nested under their direct parent child snapshot', async () => {
    // First call: direct children of the top-level execution.
    mockFindChildExecutions.mockResolvedValueOnce([
      makeChild({ id: 'sub-1', status: 'completed', result: { answer: 'sub answer', steps: [] } }),
    ]);
    // Second call (recursive): children of sub-1 - the grandchild.
    mockFindChildExecutions.mockResolvedValueOnce([
      makeChild({ id: 'leaf-1', status: 'completed', result: { answer: 'leaf answer', steps: [] } }),
    ]);
    // Third call (recursive): children of leaf-1 - none (leaf node).
    mockFindChildExecutions.mockResolvedValueOnce([]);

    const snapshots = await buildChildExecutionSnapshots('parent-1');

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].executionId).toBe('sub-1');
    expect(snapshots[0].children).toHaveLength(1);
    expect(snapshots[0].children?.[0].executionId).toBe('leaf-1');
    // Leaf has no children of its own, so the field should be absent.
    expect(snapshots[0].children?.[0].children).toBeUndefined();
  });

  it('omits the children field entirely for leaf nodes (no grandchildren)', async () => {
    mockFindChildExecutions.mockResolvedValueOnce([
      makeChild({ id: 'sub-1', status: 'completed', result: { answer: 'done', steps: [] } }),
    ]);
    // Recursive call returns empty - no grandchildren.
    mockFindChildExecutions.mockResolvedValueOnce([]);

    const snapshots = await buildChildExecutionSnapshots('parent-1');

    expect(snapshots[0].children).toBeUndefined();
  });
});
