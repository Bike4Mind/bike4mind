import { describe, expect, it } from 'vitest';
import { effectiveEvaluationArms, evaluationConfigSchema, evaluationStages } from './liveEvaluation';

describe('effective evaluation arms', () => {
  it('skips unsupported loading/TTL duplicates but retains independent compaction for OpenAI', () => {
    const arms = effectiveEvaluationArms({ id: 'gpt-6.1-sol', name: 'Pinned model', backend: 'openai' });
    expect(arms).toMatchObject([
      { name: 'reference', deferred: false, skip: false },
      { name: 'deferred-zero', deferred: false, skip: true },
      { name: 'ttl-only', ttl: '5m', skip: true },
      { name: 'compaction-only', compact: true, skip: false },
    ]);
    expect(arms.filter(arm => !arm.skip)).toHaveLength(2);
  });

  it('does not treat an unknown backend as supporting deferral', () => {
    expect(effectiveEvaluationArms({ id: 'unknown', name: 'Unknown' }).filter(arm => !arm.skip)).toHaveLength(2);
  });

  it('keeps pause, restart, compaction and tool replay independent', () => {
    const config = evaluationConfigSchema.parse({ version: 1, warm: false, longLoop: false, toolChange: false });
    expect(evaluationStages(config, false)).toEqual(['fresh']);
    expect(evaluationStages({ ...config, restart: true }, false)).toEqual(['fresh', 'process-restart', 'post-restart']);
    expect(evaluationStages({ ...config, pauseMs: 310_000 }, false)).toEqual(['fresh', 'ttl-pause', 'post-pause']);
    expect(evaluationStages(config, true)).toEqual(['fresh', 'compact', 'post-compact']);
    expect(evaluationStages({ ...config, toolChange: true }, false)).toEqual(['fresh', 'tool-change', 'tool-replay']);
  });

  it('refuses credential/model overrides and excessive loop depth', () => {
    expect(() => evaluationConfigSchema.parse({ version: 1, apiKey: 'not-a-key' })).toThrow();
    expect(() => evaluationConfigSchema.parse({ version: 1, model: 'opus' })).toThrow();
    expect(() => evaluationConfigSchema.parse({ version: 1, loopDepth: 1000 })).toThrow();
  });
});
