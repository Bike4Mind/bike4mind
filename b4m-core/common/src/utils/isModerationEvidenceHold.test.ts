import { describe, it, expect } from 'vitest';
import { isModerationEvidenceHold } from './isModerationEvidenceHold';

describe('isModerationEvidenceHold', () => {
  it('holds a content block', () => {
    expect(isModerationEvidenceHold({ moderationStatus: 'blocked' })).toBe(true);
  });

  it('holds a block with any other reason (only unsupported_format is exempt)', () => {
    expect(isModerationEvidenceHold({ moderationStatus: 'blocked', blockReason: 'explicit' })).toBe(true);
  });

  it('does not hold an unsupported_format block', () => {
    expect(isModerationEvidenceHold({ moderationStatus: 'blocked', blockReason: 'unsupported_format' })).toBe(false);
  });

  it('does not hold an unblocked file', () => {
    for (const moderationStatus of ['clean', 'pending', 'scanning', null, undefined]) {
      expect(isModerationEvidenceHold({ moderationStatus })).toBe(false);
    }
  });
});
