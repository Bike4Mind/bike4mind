import { describe, it, expect } from 'vitest';
import { AgentStepSchema } from './actions';

describe('AgentStepSchema confidence metadata', () => {
  it('keeps the self-reported reason when a step is parsed', () => {
    const step = AgentStepSchema.parse({
      type: 'observation',
      content: 'result',
      metadata: {
        timestamp: 1,
        confidence: 0.4,
        confidenceSource: 'llm_self_report',
        confidenceReason: 'search came back thin',
      },
    });

    expect(step.metadata).toMatchObject({
      confidenceSource: 'llm_self_report',
      confidenceReason: 'search came back thin',
    });
  });
});
