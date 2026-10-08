import { describe, it, expect } from 'vitest';
import { QUESTS_NAMESPACE, QUEST_METRICS } from '../questMetricSpecs.js';

// Literals on purpose: every emitter and test imports these constants, so only a pin here makes a
// rename (which orphans the live CloudWatch series, history and dashboards) fail loudly.
describe('questMetricSpecs', () => {
  it('pins the namespace and metric names emitted to CloudWatch', () => {
    expect(QUESTS_NAMESPACE).toBe('Lumina5/Quests');
    expect(QUEST_METRICS).toEqual({
      ProcessingFailed: 'ProcessingFailed',
      TimeoutSweepRuns: 'TimeoutSweepRuns',
      TimeoutSweepCandidates: 'TimeoutSweepCandidates',
      TimeoutSweepRecovered: 'TimeoutSweepRecovered',
      TimeoutSweepCallbacksRedispatched: 'TimeoutSweepCallbacksRedispatched',
      TimeoutSweepStaleCallbacksReenqueued: 'TimeoutSweepStaleCallbacksReenqueued',
    });
  });
});
