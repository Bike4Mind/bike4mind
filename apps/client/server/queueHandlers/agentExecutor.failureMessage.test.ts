import { describe, it, expect } from 'vitest';
import { toUserFacingFailureMessage } from './agentExecutor.failureMessage';

describe('toUserFacingFailureMessage', () => {
  it('classifies billing/quota failures (402 / payment / credit)', () => {
    expect(toUserFacingFailureMessage('Request failed with status code 402')).toMatch(/billing\/quota issue \(402\)/);
    expect(toUserFacingFailureMessage('Payment Required')).toMatch(/billing\/quota issue \(402\)/);
    expect(toUserFacingFailureMessage('You have insufficient credit')).toMatch(/billing\/quota issue \(402\)/);
  });

  it('classifies timeout failures', () => {
    expect(toUserFacingFailureMessage('Socket timeout')).toMatch(/timed out/);
    expect(toUserFacingFailureMessage('The request timed out')).toMatch(/timed out/);
    expect(toUserFacingFailureMessage('connect ETIMEDOUT 1.2.3.4:443')).toMatch(/timed out/);
  });

  it('classifies rate-limit failures (429)', () => {
    expect(toUserFacingFailureMessage('Request failed with status code 429')).toMatch(
      /rate limit was exceeded \(429\)/
    );
    expect(toUserFacingFailureMessage('Rate limit reached for requests')).toMatch(/rate limit was exceeded \(429\)/);
  });

  it('classifies auth failures (401 / 403 / unauthorized)', () => {
    expect(toUserFacingFailureMessage('Request failed with status code 401')).toMatch(/denied access \(auth error\)/);
    expect(toUserFacingFailureMessage('Request failed with status code 403')).toMatch(/denied access \(auth error\)/);
    expect(toUserFacingFailureMessage('Unauthorized')).toMatch(/denied access \(auth error\)/);
    expect(toUserFacingFailureMessage('Access denied to resource')).toMatch(/denied access \(auth error\)/);
  });

  it('stays generic for unrecognized errors', () => {
    expect(toUserFacingFailureMessage('Something exploded in the tool loop')).toBe('Agent execution failed');
    expect(toUserFacingFailureMessage('')).toBe('Agent execution failed');
  });

  it('does not misclassify status-code digits embedded in unrelated numbers', () => {
    // Word-boundary matching: these contain "402"/"429"/"401" as substrings of larger tokens
    // (token counts, ids, timestamps) and must stay generic.
    expect(toUserFacingFailureMessage('processed 4029 tokens before failing')).toBe('Agent execution failed');
    expect(toUserFacingFailureMessage('record id 14029 not found')).toBe('Agent execution failed');
    expect(toUserFacingFailureMessage('value 4010 out of range')).toBe('Agent execution failed');
  });

  it('never leaks the raw error text', () => {
    const raw = 'Internal: secret-bucket/path/key.json missing at 0xdeadbeef';
    expect(toUserFacingFailureMessage(raw)).toBe('Agent execution failed');
    expect(toUserFacingFailureMessage(raw)).not.toContain('secret-bucket');
  });
});
