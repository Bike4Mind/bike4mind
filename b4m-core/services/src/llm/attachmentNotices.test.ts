import { describe, it, expect } from 'vitest';
import type { FabFileNotice } from '@bike4mind/utils';
import {
  MAX_ATTACHMENT_NOTICE_LINES,
  buildAttachmentNoticePrompt,
  toAttachmentNoticeStrings,
} from './attachmentNotices';

const notice = (over: Partial<FabFileNotice> = {}): FabFileNotice => ({
  fabFileId: 'f1',
  fileName: 'context.md',
  band: 'read_failed',
  message: '"context.md" could not be read and was not sent.',
  delivered: false,
  ...over,
});

describe('toAttachmentNoticeStrings', () => {
  it('passes each message through as its own transcript line', () => {
    expect(toAttachmentNoticeStrings([notice(), notice({ message: 'second' })])).toEqual([
      '"context.md" could not be read and was not sent.',
      'second',
    ]);
  });

  it('caps a long list and says how many were left out', () => {
    const many = Array.from({ length: MAX_ATTACHMENT_NOTICE_LINES + 3 }, (_, i) => notice({ message: `m${i}` }));

    const lines = toAttachmentNoticeStrings(many);

    expect(lines).toHaveLength(MAX_ATTACHMENT_NOTICE_LINES + 1);
    expect(lines.at(-1)).toContain('3 more');
  });
});

describe('buildAttachmentNoticePrompt', () => {
  it('states plainly that an undelivered file is not in the conversation', () => {
    const prompt = buildAttachmentNoticePrompt([notice()]);

    expect(prompt).toContain('was NOT delivered and its content is not in this conversation');
    expect(prompt).toContain('context.md');
    // Without this the model reads a list of file names and infers it holds them.
    expect(prompt).toContain('Do not answer as though these files were present or complete.');
  });

  it('distinguishes a partial delivery from a missing file', () => {
    const prompt = buildAttachmentNoticePrompt([notice({ band: 'truncated', delivered: true })]);

    expect(prompt).toContain('was delivered only in part');
    expect(prompt).not.toContain('was NOT delivered');
  });

  it('caps the list the same way the transcript does', () => {
    const many = Array.from({ length: MAX_ATTACHMENT_NOTICE_LINES + 2 }, (_, i) => notice({ message: `m${i}` }));

    const prompt = buildAttachmentNoticePrompt(many);

    expect(prompt).toContain(`m${MAX_ATTACHMENT_NOTICE_LINES - 1}`);
    expect(prompt).not.toContain(`m${MAX_ATTACHMENT_NOTICE_LINES}`);
    expect(prompt).toContain('2 more');
  });
});
