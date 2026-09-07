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

  it.each(['deploy.sh', 'movie.srt', 'config.yaml'])(
    'rejects %s even though Slack labels it text/plain (#2025 - the client label must not decide the gate)',
    name => {
      const result = validateSlackFileForIngest(attachment({ name, mimetype: 'text/plain' }));

      expect(result).toMatchObject({ ok: false, reason: 'unsupported_type' });
    }
  );

  it.each(['Dockerfile', 'LICENSE', 'Makefile'])(
    "still accepts a genuinely extension-less file %s (regression guard, matches create.ts's own fallback)",
    name => {
      const result = validateSlackFileForIngest(attachment({ name, mimetype: 'text/plain' }));

      expect(result.ok).toBe(true);
    }
  );

  it.each(['.env', '.eslintrc', '.prettierrc', '.exe'])(
    'accepts dotfile %s - `path.extname` reports no extension for it, same as a bare LICENSE/Dockerfile name, so it must not be refused as unsupported (regression: main accepts these)',
    name => {
      const result = validateSlackFileForIngest(attachment({ name, mimetype: 'text/plain' }));

      expect(result.ok).toBe(true);
    }
  );

  it('rejects payload. - a trailing dot resolves no extension too, but is malformed rather than extension-less, so it must not get the dotfile fallback', () => {
    const result = validateSlackFileForIngest(attachment({ name: 'payload.', mimetype: 'text/plain' }));

    expect(result).toMatchObject({ ok: false, reason: 'unsupported_type' });
    if (result.ok) throw new Error('expected rejection');
    expect(result.message).toBe('File "payload." has no recognized file type.');
  });

  it.each(['Meeting notes 2026.09.07', 'My Report v1.2'])(
    'rejects %s without naming a bare digit fragment as the type (a date/version suffix is not an extension)',
    name => {
      const result = validateSlackFileForIngest(attachment({ name, mimetype: 'text/plain' }));

      expect(result).toMatchObject({ ok: false, reason: 'unsupported_type' });
      if (result.ok) throw new Error('expected rejection');
      expect(result.message).toBe(`File "${name}" has no recognized file type.`);
    }
  );

  it('accepts an attachment with no client-reported mimetype - nothing downstream reads that field', () => {
    const result = validateSlackFileForIngest(attachment({ name: 'notes.pdf', mimetype: undefined }));

    expect(result.ok).toBe(true);
  });

  it('holds a real image to the tighter cap even when it claims a non-image mimetype (#2025 sibling)', () => {
    // The extension says PNG; the claimed mimetype tries to dodge the tighter image cap.
    const result = validateSlackFileForIngest(
      attachment({
        name: 'shot.png',
        mimetype: 'application/octet-stream',
        size: SLACK_MAX_IMAGE_SIZE_BYTES + 1,
      })
    );

    expect(result).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it('does not hold a non-image to the tighter cap merely because it claims an image mimetype', () => {
    // The extension says PDF; the claimed mimetype falsely says image/png. Resolved type, not the
    // claim, must decide the cap - so this stays under the general 50MB limit.
    const result = validateSlackFileForIngest(
      attachment({
        name: 'notes.pdf',
        mimetype: 'image/png',
        size: SLACK_MAX_IMAGE_SIZE_BYTES + 1,
      })
    );

    expect(result.ok).toBe(true);
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
