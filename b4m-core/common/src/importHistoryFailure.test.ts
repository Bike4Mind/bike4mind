import { describe, it, expect } from 'vitest';
import { describeImportFailure } from './importHistoryFailure';

const GENERIC = { reason: 'Something went wrong on our side while processing this import.', retryable: true };

describe('describeImportFailure', () => {
  it('names the expected export for a zip without conversations.json, per source', () => {
    expect(describeImportFailure('conversations.json not found in archive', 'OpenAI')).toEqual({
      reason: "This file doesn't look like a ChatGPT export (no conversations.json).",
      retryable: false,
    });
    expect(describeImportFailure('conversations.json not found in archive', 'Claude').reason).toContain(
      'a Claude export'
    );
    expect(describeImportFailure('conversations.json not found in archive', 'Notebook').reason).toContain(
      'a ChatGPT or Claude export'
    );
    expect(describeImportFailure('conversations.json not found in archive').reason).toContain(
      'a ChatGPT or Claude export'
    );
  });

  it.each([
    'end of central directory record signature not found',
    'invalid central directory file header signature: 0x6f6f6f6f',
    'invalid local file header signature: 0x0',
    'Unable to open archive: /tmp/abc123/upload.zip',
  ])('treats %s as a non-zip upload', message => {
    expect(describeImportFailure(message)).toEqual({
      reason: 'This file is not a valid .zip archive.',
      retryable: false,
    });
  });

  it('reports a damaged archive when conversations.json cannot be read', () => {
    expect(describeImportFailure('Unable to read conversations.json from archive')).toEqual({
      reason: 'This archive is damaged and conversations.json could not be read.',
      retryable: false,
    });
  });

  it.each([
    'Unexpected end of JSON input',
    'Unexpected token } in JSON at position 12',
    `Unexpected token 'o', "not json" is not valid JSON`,
  ])('treats %s as invalid JSON', message => {
    expect(describeImportFailure(message)).toEqual({
      reason: 'conversations.json in this file is not valid JSON.',
      retryable: false,
    });
  });

  it.each([undefined, null, '', '   ', 'Unknown error', 'User not found: 64b0f0f0f0f0f0f0f0f0f0f0'])(
    'falls back to the generic retryable reason for %j',
    message => {
      expect(describeImportFailure(message)).toEqual(GENERIC);
    }
  );

  it('never echoes the raw message', () => {
    const raw = 'ENOENT: no such file or directory, open /tmp/import-64b0f0/history.zip';
    const { reason } = describeImportFailure(raw, 'OpenAI');
    expect(reason).not.toContain('/tmp');
    expect(reason).not.toContain('64b0f0');
    expect(describeImportFailure('Unable to open archive: /tmp/import-64b0f0/x.zip').reason).not.toContain('/tmp');
  });
});
