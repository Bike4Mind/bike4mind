import { describe, it, expect } from 'vitest';
import { OrchestrationDefaultsSchema } from './settings';

describe('OrchestrationDefaultsSchema confidence gate fields', () => {
  it('defaults to a 0.6 threshold, both sites and self-report on', () => {
    expect(OrchestrationDefaultsSchema.parse({})).toMatchObject({
      confidenceGateThreshold: 0.6,
      confidenceGateMode: 'both',
      confidenceGateSelfReport: true,
    });
  });

  it('keeps a threshold of 0 rather than falling back to the default', () => {
    expect(OrchestrationDefaultsSchema.parse({ confidenceGateThreshold: 0 }).confidenceGateThreshold).toBe(0);
  });

  it('rejects an out-of-range threshold, an unknown mode and a non-boolean self-report', () => {
    expect(OrchestrationDefaultsSchema.safeParse({ confidenceGateThreshold: 1.5 }).success).toBe(false);
    expect(OrchestrationDefaultsSchema.safeParse({ confidenceGateThreshold: -0.1 }).success).toBe(false);
    expect(OrchestrationDefaultsSchema.safeParse({ confidenceGateMode: 'sometimes' }).success).toBe(false);
    expect(OrchestrationDefaultsSchema.safeParse({ confidenceGateSelfReport: 'yes' }).success).toBe(false);
  });
});
