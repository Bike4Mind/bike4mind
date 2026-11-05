import { describe, expect, it } from 'vitest';
import { describeImportHistoryFailure } from './importHistoryFailure';

describe('describeImportHistoryFailure', () => {
  it.each([
    ['conversations.json not found in archive', 'not_an_export'],
    ['end of central directory record signature not found', 'not_a_zip'],
    ['Unable to open archive: /tmp/1700000000000.zip', 'not_a_zip'],
    ['invalid central directory file header signature: 0x0', 'not_a_zip'],
    ['Unexpected end of JSON input', 'damaged_export'],
    ['Unexpected token < in JSON at position 0', 'damaged_export'],
    [`Unexpected token 'x', "xyz" is not valid JSON`, 'damaged_export'],
    ['Unable to read conversations.json from archive', 'damaged_export'],
    ['invalid stored block lengths', 'damaged_export'],
    ['incorrect header check', 'damaged_export'],
  ])('maps %j to %s', (raw, kind) => {
    expect(describeImportHistoryFailure(raw).kind).toBe(kind);
  });

  it('marks structurally invalid uploads as not retryable', () => {
    expect(describeImportHistoryFailure('conversations.json not found in archive').retryable).toBe(false);
    expect(describeImportHistoryFailure('end of central directory record signature not found').retryable).toBe(false);
    expect(describeImportHistoryFailure('Unexpected end of JSON input').retryable).toBe(false);
  });

  it.each([undefined, null, '', 'User not found: 64f0c0ffee', 'connect ECONNRESET 10.0.0.1:27017'])(
    'falls back to a generic, retryable reason for %j',
    raw => {
      const reason = describeImportHistoryFailure(raw);
      expect(reason.kind).toBe('unknown');
      expect(reason.retryable).toBe(true);
    }
  );

  it('never echoes the raw error, which can carry ids, paths or hosts', () => {
    const raw = 'Unable to open archive: /tmp/1700000000000.zip';
    expect(describeImportHistoryFailure(raw).message).not.toContain('/tmp');
    expect(describeImportHistoryFailure('User not found: 64f0c0ffee').message).not.toContain('64f0c0ffee');
  });
});
