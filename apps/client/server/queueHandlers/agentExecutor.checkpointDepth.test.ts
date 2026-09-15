import { describe, it, expect, vi } from 'vitest';
import {
  MAX_CHECKPOINT_DEPTH,
  CHECKPOINT_DEPTH_WARNING,
  classifyCheckpointDepth,
  enforceCheckpointDepth,
} from './agentExecutor.checkpointDepth';
// Import the REAL schemas (not mirrors) so these tests break if someone accidentally
// removes checkpointDepth or changes it from optional to required.
import { ContinuationSchema, TaggedQueueMessageSchema } from './agentExecutor.schemas';

// Constants: load-bearing relationship checks
describe('checkpoint depth constants', () => {
  it('warning threshold is positive and strictly below the hard limit', () => {
    expect(CHECKPOINT_DEPTH_WARNING).toBeGreaterThan(0);
    expect(CHECKPOINT_DEPTH_WARNING).toBeLessThan(MAX_CHECKPOINT_DEPTH);
  });

  it('hard limit is at least 50 (documented 12.5h wall-clock budget)', () => {
    expect(MAX_CHECKPOINT_DEPTH).toBeGreaterThanOrEqual(50);
  });
});

// classifyCheckpointDepth: boundary behaviour
describe('classifyCheckpointDepth', () => {
  it('returns ok below the warning threshold', () => {
    expect(classifyCheckpointDepth(0)).toBe('ok');
    expect(classifyCheckpointDepth(CHECKPOINT_DEPTH_WARNING - 1)).toBe('ok');
  });

  it('returns warn at exactly the warning boundary', () => {
    expect(classifyCheckpointDepth(CHECKPOINT_DEPTH_WARNING)).toBe('warn');
  });

  it('returns warn between warning and hard limit', () => {
    expect(classifyCheckpointDepth(CHECKPOINT_DEPTH_WARNING + 1)).toBe('warn');
    expect(classifyCheckpointDepth(MAX_CHECKPOINT_DEPTH - 1)).toBe('warn');
  });

  it('returns terminate at exactly the hard limit', () => {
    expect(classifyCheckpointDepth(MAX_CHECKPOINT_DEPTH)).toBe('terminate');
  });

  it('returns terminate above the hard limit', () => {
    expect(classifyCheckpointDepth(MAX_CHECKPOINT_DEPTH + 1)).toBe('terminate');
    expect(classifyCheckpointDepth(MAX_CHECKPOINT_DEPTH + 100)).toBe('terminate');
  });
});

// ContinuationSchema: checkpointDepth field contract
describe('ContinuationSchema checkpointDepth', () => {
  const base = { executionId: 'exec-1', connectionId: 'conn-1' };

  it('is optional — messages without the field still parse', () => {
    const result = ContinuationSchema.safeParse(base);
    expect(result.success).toBe(true);
    expect(result.data?.checkpointDepth).toBeUndefined();
  });

  it('accepts depth 0', () => {
    const result = ContinuationSchema.safeParse({ ...base, checkpointDepth: 0 });
    expect(result.success).toBe(true);
    expect(result.data?.checkpointDepth).toBe(0);
  });

  it('accepts depths up to and including the hard limit', () => {
    expect(ContinuationSchema.safeParse({ ...base, checkpointDepth: MAX_CHECKPOINT_DEPTH }).success).toBe(true);
  });

  it('rejects negative depths', () => {
    expect(ContinuationSchema.safeParse({ ...base, checkpointDepth: -1 }).success).toBe(false);
  });

  it('rejects non-integer depths', () => {
    expect(ContinuationSchema.safeParse({ ...base, checkpointDepth: 1.5 }).success).toBe(false);
  });
});

// TaggedQueueMessageSchema continuation branch: same field contract
describe('TaggedQueueMessageSchema continuation branch checkpointDepth', () => {
  const base = { kind: 'continuation' as const, executionId: 'exec-1', connectionId: 'conn-1' };

  it('is optional — tagged messages without the field still parse', () => {
    const result = TaggedQueueMessageSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'continuation') {
      expect(result.data.checkpointDepth).toBeUndefined();
    }
  });

  it('accepts a valid non-negative integer depth', () => {
    const result = TaggedQueueMessageSchema.safeParse({ ...base, checkpointDepth: CHECKPOINT_DEPTH_WARNING });
    expect(result.success).toBe(true);
  });

  it('rejects negative depths', () => {
    expect(TaggedQueueMessageSchema.safeParse({ ...base, checkpointDepth: -1 }).success).toBe(false);
  });

  it('rejects non-integer depths', () => {
    expect(TaggedQueueMessageSchema.safeParse({ ...base, checkpointDepth: 0.5 }).success).toBe(false);
  });
});

// enforceCheckpointDepth: the side effects processExecution relies on. The classifier above
// is pure; these tests pin what the guard actually DOES at each verdict, which is the part
// that silently regresses (a dropped markFailed leaves the execution hung in `running`).
describe('enforceCheckpointDepth', () => {
  const makeDeps = () => ({
    executionId: 'exec-1',
    logger: { warn: vi.fn(), error: vi.fn() },
    emitMetric: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    sendWs: vi.fn().mockResolvedValue(undefined),
  });

  const metricNames = (deps: ReturnType<typeof makeDeps>) => deps.emitMetric.mock.calls.map(call => call[1]);

  it('does nothing below the warning threshold', async () => {
    const deps = makeDeps();
    await expect(enforceCheckpointDepth(0, deps)).resolves.toBe(false);
    expect(deps.emitMetric).not.toHaveBeenCalled();
    expect(deps.markFailed).not.toHaveBeenCalled();
    expect(deps.sendWs).not.toHaveBeenCalled();
  });

  it('warns without terminating between the warning threshold and the hard limit', async () => {
    const deps = makeDeps();
    await expect(enforceCheckpointDepth(CHECKPOINT_DEPTH_WARNING, deps)).resolves.toBe(false);
    expect(metricNames(deps)).toEqual(['CheckpointDepthWarning']);
    // The execution must survive a warn - only the hard limit is allowed to kill it.
    expect(deps.markFailed).not.toHaveBeenCalled();
    expect(deps.sendWs).not.toHaveBeenCalled();
  });

  it('terminates at the hard limit: emits the exceeded metric, marks failed, notifies the client', async () => {
    const deps = makeDeps();
    await expect(enforceCheckpointDepth(MAX_CHECKPOINT_DEPTH, deps)).resolves.toBe(true);

    expect(metricNames(deps)).toEqual(['CheckpointDepthWarning', 'CheckpointDepthExceeded']);
    expect(deps.emitMetric).toHaveBeenCalledWith('Lumina5/AgentExecutor', 'CheckpointDepthExceeded', 1, {
      executionId: 'exec-1',
    });
    expect(deps.markFailed).toHaveBeenCalledWith('exec-1', {
      message: expect.stringContaining(`maximum self-dispatch depth (${MAX_CHECKPOINT_DEPTH})`),
    });
    // The client listens for this exact reason string to render the runaway-loop failure.
    expect(deps.sendWs).toHaveBeenCalledWith('failed', {
      executionId: 'exec-1',
      reason: 'max_checkpoint_depth_exceeded',
    });
  });

  it('terminates above the hard limit', async () => {
    const deps = makeDeps();
    await expect(enforceCheckpointDepth(MAX_CHECKPOINT_DEPTH + 10, deps)).resolves.toBe(true);
    expect(metricNames(deps)).toContain('CheckpointDepthExceeded');
    expect(deps.markFailed).toHaveBeenCalledTimes(1);
  });

  it('marks the execution failed before notifying the client, so a failed send cannot leave it running', async () => {
    const deps = makeDeps();
    const order: string[] = [];
    deps.markFailed.mockImplementation(async () => void order.push('markFailed'));
    deps.sendWs.mockImplementation(async () => void order.push('sendWs'));

    await enforceCheckpointDepth(MAX_CHECKPOINT_DEPTH, deps);

    expect(order).toEqual(['markFailed', 'sendWs']);
  });
});
