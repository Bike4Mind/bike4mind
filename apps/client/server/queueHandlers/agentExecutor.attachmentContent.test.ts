import { describe, it, expect, vi } from 'vitest';
import type { IFabFileDocument, MessageContentObject } from '@bike4mind/common';
import type { FabFileNotice } from '@bike4mind/utils';
import {
  materializeAttachmentContent,
  composeFirstIterationMessage,
  attachmentNoticeBlock,
  MAX_INLINED_IMAGE_BYTES,
} from './agentExecutor.attachmentContent';

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const file = (id: string, fileName = `${id}.md`): IFabFileDocument =>
  ({ id, fileName, mimeType: 'text/markdown' }) as unknown as IFabFileDocument;

const imageBlock = (bytes: number): MessageContentObject =>
  ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x'.repeat(bytes) } }) as MessageContentObject;

/** Default extractor result; override per test. */
const extractorResult = (over: Partial<Awaited<ReturnType<Parameters<typeof materializeAttachmentContent>[2]>>> = {}) => ({
  userMessages: [],
  fileNotices: [],
  deliveredFileIds: [],
  fullyDeliveredFileIds: [],
  ...over,
});

describe('materializeAttachmentContent', () => {
  it('returns the extracted text so it can ride the first-iteration query', async () => {
    const logger = makeLogger();
    const extract = vi.fn().mockResolvedValue(
      extractorResult({
        userMessages: [{ role: 'user', content: 'Here is the content from the attached file "a.md": BODY' }],
        deliveredFileIds: ['a'],
        fullyDeliveredFileIds: ['a'],
      })
    );

    const result = await materializeAttachmentContent([file('a')], [], extract, logger);

    expect(result.text).toContain('BODY');
    expect(result.inlinedFileIds).toEqual(['a']);
    expect(result.imageBlocks).toEqual([]);
    expect(result.notices).toEqual([]);
  });

  it('separates image blocks from text so the message can go multimodal', async () => {
    const logger = makeLogger();
    const extract = vi.fn().mockResolvedValue(
      extractorResult({
        userMessages: [
          { role: 'user', content: 'text body' },
          { role: 'user', content: [imageBlock(10), { type: 'text', text: 'File: "shot.png"' }] },
        ],
        deliveredFileIds: ['a', 'img'],
      })
    );

    const result = await materializeAttachmentContent([file('a'), file('img', 'shot.png')], [], extract, logger);

    expect(result.text).toBe('text body');
    expect(result.imageBlocks).toHaveLength(2);
    expect(result.imageBlocks[0].type).toBe('image');
    // The naming text block rides along so the model can still refer to the file correctly.
    expect(result.imageBlocks[1]).toMatchObject({ type: 'text' });
  });

  it('turns ids that could not be resolved into notices', async () => {
    const logger = makeLogger();
    const extract = vi.fn().mockResolvedValue(extractorResult());

    const result = await materializeAttachmentContent([], ['ghost'], extract, logger);

    expect(result.notices).toEqual([
      expect.objectContaining({ fabFileId: 'ghost', band: 'unresolved', delivered: false }),
    ]);
    // Nothing to extract, so the extractor is never called.
    expect(extract).not.toHaveBeenCalled();
  });

  it('passes the extractor notices through untouched', async () => {
    const logger = makeLogger();
    const notice: FabFileNotice = {
      fabFileId: 'a',
      fileName: 'a.md',
      band: 'truncated',
      message: '"a.md" was too large to send whole.',
      delivered: true,
    };
    const extract = vi.fn().mockResolvedValue(
      extractorResult({ userMessages: [{ role: 'user', content: 'partial' }], deliveredFileIds: ['a'], fileNotices: [notice] })
    );

    const result = await materializeAttachmentContent([file('a')], [], extract, logger);

    expect(result.notices).toEqual([notice]);
  });

  it('drops images past the per-run ceiling and says so, keeping the ones that fit', async () => {
    // The agent checkpoints its messages to Mongo after every iteration, so inlined image bytes are
    // paid repeatedly and count against the BSON document limit for the life of the run.
    const logger = makeLogger();
    const under = imageBlock(MAX_INLINED_IMAGE_BYTES - 10);
    const over = imageBlock(1000);
    const extract = vi.fn().mockResolvedValue(
      extractorResult({ userMessages: [{ role: 'user', content: [under, over] }], deliveredFileIds: ['i1', 'i2'] })
    );

    const result = await materializeAttachmentContent([file('i1'), file('i2')], [], extract, logger);

    expect(result.imageBlocks).toEqual([under]);
    expect(result.notices).toEqual([
      expect.objectContaining({ band: 'image_too_large', delivered: false }),
    ]);
    expect(result.notices[0].message).toContain('1 attached image(s) were not sent');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('per-run inline ceiling'),
      expect.objectContaining({ droppedImages: 1 })
    );
  });

  it('reports only wholly-present files as fully inlined', async () => {
    // #1163: only this set may back a "you already have everything" claim. A truncated file is
    // delivered but incomplete, so it must not appear here.
    const logger = makeLogger();
    const extract = vi.fn().mockResolvedValue(
      extractorResult({
        userMessages: [{ role: 'user', content: 'whole + partial' }],
        deliveredFileIds: ['whole', 'partial'],
        fullyDeliveredFileIds: ['whole'],
      })
    );

    const result = await materializeAttachmentContent([file('whole'), file('partial')], [], extract, logger);

    expect(result.inlinedFileIds.sort()).toEqual(['partial', 'whole']);
    expect(result.fullyInlinedFileIds).toEqual(['whole']);
  });

  it('does not call an image cut at the ceiling fully inlined', async () => {
    const logger = makeLogger();
    const extract = vi.fn().mockResolvedValue(
      extractorResult({
        userMessages: [{ role: 'user', content: [imageBlock(MAX_INLINED_IMAGE_BYTES + 1)] }],
        deliveredFileIds: ['img'],
        fullyDeliveredFileIds: ['img'],
      })
    );

    const result = await materializeAttachmentContent([file('img')], [], extract, logger);

    expect(result.imageBlocks).toEqual([]);
    // The notice is what tells the model. Locking the known limitation too: the id stays in the
    // inlined set because a cut block cannot be attributed back to its file (see the module).
    expect(result.notices.some(n => n.band === 'image_too_large')).toBe(true);
    expect(result.inlinedFileIds).toEqual(['img']);
  });

  it('falls back to nothing rather than failing the run when extraction throws', async () => {
    const logger = makeLogger();
    const extract = vi.fn().mockRejectedValue(new Error('storage down'));

    const result = await materializeAttachmentContent([file('a')], [], extract, logger);

    expect(result).toMatchObject({ text: '', imageBlocks: [], inlinedFileIds: [] });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Extraction failed'),
      expect.objectContaining({ fileCount: 1 })
    );
  });

  it('still reports unresolved ids when extraction of the rest throws', async () => {
    const logger = makeLogger();
    const extract = vi.fn().mockRejectedValue(new Error('storage down'));

    const result = await materializeAttachmentContent([file('a')], ['ghost'], extract, logger);

    expect(result.notices).toEqual([expect.objectContaining({ fabFileId: 'ghost', band: 'unresolved' })]);
  });
});

describe('composeFirstIterationMessage', () => {
  it('stays a plain string when no image was inlined', () => {
    const out = composeFirstIterationMessage('the question', { text: 'FILE BODY', imageBlocks: [] });

    expect(typeof out).toBe('string');
    expect(out).toBe('the question\n\nFILE BODY');
  });

  it('returns the query untouched when nothing was extracted', () => {
    expect(composeFirstIterationMessage('the question', { text: '', imageBlocks: [] })).toBe('the question');
  });

  it('promotes to a content array only when an image is present, text block first', () => {
    const img = imageBlock(4);
    const out = composeFirstIterationMessage('the question', { text: 'FILE BODY', imageBlocks: [img] });

    expect(Array.isArray(out)).toBe(true);
    const blocks = out as MessageContentObject[];
    expect(blocks[0]).toMatchObject({ type: 'text', text: 'the question\n\nFILE BODY' });
    expect(blocks[1]).toBe(img);
  });
});

describe('attachmentNoticeBlock', () => {
  it('is empty when nothing went wrong', () => {
    expect(attachmentNoticeBlock([])).toBe('');
  });

  it('distinguishes an undelivered file from a partial one and forbids answering as though present', () => {
    const out = attachmentNoticeBlock([
      { fabFileId: 'a', fileName: 'a.md', band: 'read_failed', message: '"a.md" could not be read.', delivered: false },
      { fabFileId: 'b', fileName: 'b.csv', band: 'truncated', message: '"b.csv" was cut.', delivered: true },
    ]);

    expect(out).toContain('was NOT delivered');
    expect(out).toContain('delivered only in part');
    expect(out).toContain('Do not answer as though these files were present or complete');
  });
});
