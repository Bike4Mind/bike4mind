import { describe, expect, it } from 'vitest';
import { buildRecentGeneratedImagesNote, type RecentGeneratedImagesNoteInput } from './recentGeneratedImagesNote';

const images = [{ key: '86cdc650-43d2-416e-aca6-23ff4fe23081.png', prompt: 'a red bicycle' }];

const ownerInput = (overrides: Partial<RecentGeneratedImagesNoteInput> = {}): RecentGeneratedImagesNoteInput => ({
  images,
  editImageAvailable: true,
  videoGenerationAvailable: true,
  sessionOwnerId: 'owner',
  callerId: 'owner',
  ...overrides,
});

const noteText = (editImageAvailable: boolean, videoGenerationAvailable: boolean): string => {
  const [note] = buildRecentGeneratedImagesNote(ownerInput({ editImageAvailable, videoGenerationAvailable }));
  return note?.content ?? '';
};

describe('buildRecentGeneratedImagesNote', () => {
  it('is empty when neither edit_image nor video_generation is offered', () => {
    expect(
      buildRecentGeneratedImagesNote(ownerInput({ editImageAvailable: false, videoGenerationAvailable: false }))
    ).toEqual([]);
  });

  it('is empty when there are no recent images', () => {
    expect(buildRecentGeneratedImagesNote(ownerInput({ images: [] }))).toEqual([]);
    expect(buildRecentGeneratedImagesNote(ownerInput({ images: undefined }))).toEqual([]);
  });

  it('is empty for a share recipient, whose edit_image and video_generation would refuse these keys', () => {
    expect(buildRecentGeneratedImagesNote(ownerInput({ callerId: 'sharee' }))).toEqual([]);
  });

  it('lists the keys with their prompts when only edit_image is offered', () => {
    const text = noteText(true, false);
    expect(text).toContain('# Recently generated images');
    expect(text).toContain(`- ${images[0].key} - from: "a red bicycle"`);
    expect(text).toContain('edit_image');
    expect(text).not.toContain('video_generation');
  });

  it('omits the prompt suffix when the image has no prompt', () => {
    const [note] = buildRecentGeneratedImagesNote(ownerInput({ images: [{ key: images[0].key, prompt: '' }] }));
    expect(note.content).toContain(`- ${images[0].key}\n`);
    expect(note.content).not.toContain('from:');
  });

  it('is added when only video_generation is offered, and names its field without implying edit_image only', () => {
    const text = noteText(false, true);
    expect(text).toContain(images[0].key);
    expect(text).toContain('video_generation with `inputGeneratedImageKey`');
    expect(text).not.toContain('call edit_image');
  });

  it('names both tools when both are offered', () => {
    const text = noteText(true, true);
    expect(text).toContain('call edit_image');
    expect(text).toContain('call video_generation');
  });
});
