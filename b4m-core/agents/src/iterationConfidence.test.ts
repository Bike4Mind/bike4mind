import { describe, it, expect } from 'vitest';
import { usableEvidenceConfidence } from './iterationConfidence';

describe('usableEvidenceConfidence', () => {
  it('is null when no call ran', () => {
    expect(usableEvidenceConfidence([])).toBeNull();
  });

  it('is null when every call failed', () => {
    expect(
      usableEvidenceConfidence([
        { confidence: 0.1, toolFailed: true },
        { confidence: 0.1, toolFailed: true },
      ])
    ).toBeNull();
  });

  it('takes the strongest score, so one usable result outweighs an empty one', () => {
    expect(usableEvidenceConfidence([{ confidence: 0.3 }, { confidence: 0.7 }])).toBe(0.7);
  });

  it('stays low when every call that ran was weak', () => {
    expect(usableEvidenceConfidence([{ confidence: 0.3 }, { confidence: 0.1 }])).toBe(0.3);
  });

  it('ignores a failed call even when it carries the highest score', () => {
    expect(usableEvidenceConfidence([{ confidence: 0.9, toolFailed: true }, { confidence: 0.3 }])).toBe(0.3);
  });
});
