import { describe, it, expect } from 'vitest';
import { exceedsTtsResponseLimit, TTS_MAX_RESPONSE_BYTES } from './ttsResponseLimit';

describe('exceedsTtsResponseLimit', () => {
  it('allows audio at or under the limit', () => {
    expect(exceedsTtsResponseLimit(TTS_MAX_RESPONSE_BYTES)).toBe(false);
    expect(exceedsTtsResponseLimit(TTS_MAX_RESPONSE_BYTES - 1)).toBe(false);
    expect(exceedsTtsResponseLimit(0)).toBe(false);
  });

  it('rejects audio over the limit', () => {
    expect(exceedsTtsResponseLimit(TTS_MAX_RESPONSE_BYTES + 1)).toBe(true);
  });

  it('keeps the limit safely under the ~6MB API Gateway/Lambda payload cap', () => {
    // Both binary and base64 responses inflate ~33% in the Lambda proxy envelope,
    // so the raw ceiling must leave room: 4MB * 1.33 ~= 5.3MB < 6MB.
    expect(TTS_MAX_RESPONSE_BYTES * 1.34).toBeLessThan(6 * 1024 * 1024);
  });
});
