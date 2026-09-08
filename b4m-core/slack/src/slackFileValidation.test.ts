import { describe, it, expect } from 'vitest';
import {
  validateSlackFileForIngest,
  SLACK_MAX_FILE_SIZE_BYTES,
  SLACK_MAX_IMAGE_SIZE_BYTES,
  type SlackAttachment,
} from './slackFileValidation';

const attachment = (overrides: Partial<SlackAttachment> = {}): SlackAttachment => ({
  id: 'F123',
  name: 'notes.pdf',
  mimetype: 'application/pdf',
  url_private_download: 'https://files.slack.com/notes.pdf',
  size: 1024,
  ...overrides,
});

describe('validateSlackFileForIngest', () => {
  it('accepts a complete, supported, in-size attachment and narrows the required fields', () => {
    const result = validateSlackFileForIngest(attachment());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected acceptance');
    // The narrowing is the contract: callers must not have to re-guard these.
    expect(result.file.name).toBe('notes.pdf');
    expect(result.file.url_private_download).toBe('https://files.slack.com/notes.pdf');
    expect(result.file.size).toBe(1024);
  });

  it.each([
    ['mimetype', { mimetype: undefined }],
    ['name', { name: undefined }],
    ['url_private_download', { url_private_download: undefined }],
    ['size', { size: undefined }],
  ])('reports a partial Slack file object missing %s as incomplete', (_field, overrides) => {
    const result = validateSlackFileForIngest(attachment(overrides));

    expect(result).toMatchObject({ ok: false, reason: 'incomplete' });
  });

  it('rejects a type outside the Slack allow-list even though the wizard accepts it', () => {
    // CSV is a SupportedFabFileMimeType but deliberately NOT in the narrower Slack list.
    const result = validateSlackFileForIngest(attachment({ name: 'rows.csv', mimetype: 'text/csv' }));

    expect(result).toMatchObject({ ok: false, reason: 'unsupported_type' });
    if (result.ok) throw new Error('expected rejection');
    expect(result.message).toContain('text/csv');
  });

  it('rejects a non-image over the 50MB limit', () => {
    const result = validateSlackFileForIngest(attachment({ size: SLACK_MAX_FILE_SIZE_BYTES + 1 }));

    expect(result).toMatchObject({ ok: false, reason: 'too_large' });
    if (result.ok) throw new Error('expected rejection');
    expect(result.message).toContain('50MB');
  });

  it('holds an image to the tighter 10MB limit', () => {
    const overLimit = validateSlackFileForIngest(
      attachment({ name: 'shot.png', mimetype: 'image/png', size: SLACK_MAX_IMAGE_SIZE_BYTES + 1 })
    );
    expect(overLimit).toMatchObject({ ok: false, reason: 'too_large' });

    // The same size is fine for a non-image, proving the limit is type-dependent.
    const sameSizeDocument = validateSlackFileForIngest(attachment({ size: SLACK_MAX_IMAGE_SIZE_BYTES + 1 }));
    expect(sameSizeDocument.ok).toBe(true);
  });

  it('accepts a file exactly at the limit (boundary is exclusive)', () => {
    const result = validateSlackFileForIngest(attachment({ size: SLACK_MAX_FILE_SIZE_BYTES }));
    expect(result.ok).toBe(true);
  });
});
