import { describe, expect, it, vi } from 'vitest';
import type { IChatHistoryItemDocument } from '@bike4mind/common';
import { buildAgentRecentImagesNote, withRecentImagesNote } from './agentExecutor.recentImagesNote';

const JOB_ID = '6afafc4f4902098599bc2aff';
const FILE_ID = '6afafb1074be9f7aa4b4db76';

const quest = (fields: Partial<IChatHistoryItemDocument>) => fields as IChatHistoryItemDocument;

const setup = (overrides: Partial<Parameters<typeof buildAgentRecentImagesNote>[0]> = {}) => {
  const quests = {
    // Newest first, as the repository returns it.
    getMostRecentChatHistory: vi.fn(async () => [
      quest({ prompt: 'make a fox', generationJobs: [{ id: JOB_ID, kind: 'image' }] }),
      quest({ prompt: 'old cat', images: ['generated/cat.png'] }),
    ]),
  };
  const resolveImageJobFiles = vi.fn(async () => [{ jobId: JOB_ID, fileId: FILE_ID }]);
  const input = {
    session: { id: 's1', userId: 'u1' },
    callerId: 'u1',
    toolNames: ['image_generation', 'edit_image'],
    questCount: 20,
    questHistory: quests,
    resolveImageJobFiles,
    logger: { warn: vi.fn() },
    ...overrides,
  };
  return { input, quests, resolveImageJobFiles };
};

describe('buildAgentRecentImagesNote', () => {
  it('lists the job output by file id and the legacy key, for edit_image', async () => {
    const { input, quests, resolveImageJobFiles } = setup();

    const note = await buildAgentRecentImagesNote(input);

    expect(quests.getMostRecentChatHistory).toHaveBeenCalledWith('s1', 20);
    expect(resolveImageJobFiles).toHaveBeenCalledWith({ jobIds: [JOB_ID], userId: 'u1' });
    expect(note).toContain('# Recently generated images');
    expect(note).toContain(`- ${FILE_ID} - from: "make a fox"`);
    expect(note).toContain('- generated/cat.png - from: "old cat"');
    expect(note).toContain('call edit_image');
  });

  it('is undefined when no tool takes the ids, without reading history', async () => {
    const { input, quests } = setup({ toolNames: ['image_generation', 'web_search'] });

    expect(await buildAgentRecentImagesNote(input)).toBeUndefined();
    expect(quests.getMostRecentChatHistory).not.toHaveBeenCalled();
  });

  it('is undefined for a caller who does not own the session', async () => {
    const { input, quests } = setup({ callerId: 'u2' });

    expect(await buildAgentRecentImagesNote(input)).toBeUndefined();
    expect(quests.getMostRecentChatHistory).not.toHaveBeenCalled();
  });

  it('keeps the legacy keys when the job lookup fails', async () => {
    const { input } = setup({ resolveImageJobFiles: vi.fn(async () => Promise.reject(new Error('db down'))) });

    const note = await buildAgentRecentImagesNote(input);

    expect(note).toContain('generated/cat.png');
    expect(note).not.toContain(FILE_ID);
    expect(input.logger.warn).toHaveBeenCalled();
  });
});

describe('withRecentImagesNote', () => {
  it('appends the note after the caller context, or stands alone', () => {
    expect(withRecentImagesNote('ctx', 'note')).toBe('ctx\n\nnote');
    expect(withRecentImagesNote(undefined, 'note')).toBe('note');
    expect(withRecentImagesNote('ctx', undefined)).toBe('ctx');
    expect(withRecentImagesNote(undefined, undefined)).toBeUndefined();
  });
});
