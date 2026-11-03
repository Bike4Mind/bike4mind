import { describe, expect, it } from 'vitest';
import { toolResultStatus } from './toolsHandler.shared';

describe('toolResultStatus', () => {
  it('answers 200 for a tool that ran', () => {
    expect(toolResultStatus({ success: true })).toBe(200);
  });

  it('answers 422 for a billed tool the caller cannot afford, the status every credit refusal uses', () => {
    expect(toolResultStatus({ success: false, errorCode: 'insufficient_credits' })).toBe(422);
  });

  it.each([undefined, 'spend_cap_exceeded', 'something_else'])('answers 500 for any other failure (%s)', errorCode => {
    expect(toolResultStatus({ success: false, errorCode })).toBe(500);
  });
});
