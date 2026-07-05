import { describe, it, expect } from 'vitest';
import {
  MAX_CHECKPOINT_DEPTH,
  CHECKPOINT_DEPTH_WARNING,
  classifyCheckpointDepth,
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
