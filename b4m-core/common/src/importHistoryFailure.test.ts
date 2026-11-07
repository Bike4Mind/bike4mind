import { describe, it, expect } from 'vitest';
import { describeImportFailure, importSourceDisplayName } from './importHistoryFailure';

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

  // Exact yauzl 3.x / zlib messages for a zip that opens but whose entry cannot be read.
  it.each([
    'unexpected EOF',
    'unsupported compression method: 99',
    'entry is encrypted, and options.decodeFileData !== false',
    'entry is encrypted and compressed, and options.decompress !== false. See also option decodeFileData.',
    'strong encryption is not supported',
    'file data overflows file bounds: 30 + 0 + 5000 > 120',
    'multi-disk zip files are not supported: found disk number: 1',
    'invalid stored block lengths',
    'invalid distance too far back',
    'invalid code lengths set',
    'too many length or distance symbols',
    'unexpected end of file',
    'Unable to read conversations.json from archive',
  ])('treats %s as a damaged file', message => {
    expect(describeImportFailure(message, 'OpenAI')).toEqual({
      reason: 'This file is damaged or is not a usable export.',
      retryable: false,
    });
  });

  // Notebook imports share the job model but none of the archive rules apply to them.
  it.each([
    'Unexpected token } in JSON at position 12',
    'conversations.json not found in archive',
    'unexpected EOF',
    'end of central directory record signature not found',
  ])('keeps a Notebook failure generic and retryable for %s', message => {
    expect(describeImportFailure(message, 'Notebook')).toEqual(GENERIC);
  });

  it('shows OpenAI as ChatGPT', () => {
    expect(importSourceDisplayName('OpenAI')).toBe('ChatGPT');
    expect(importSourceDisplayName('Claude')).toBe('Claude');
  });

  it.each([
    'Unexpected end of JSON input',
    'Unexpected token } in JSON at position 12',
    `Unexpected token 'o', "not json" is not valid JSON`,
    `Unexpected token 'u', "unexpected EOF in central directory" is not valid JSON`,
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
