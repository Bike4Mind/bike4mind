import { describe, it, expect } from 'vitest';
import { buildRecentGeneratedImagesNote, type RecentGeneratedImagesNoteInput } from './recentGeneratedImagesNote';

const KEY = '86cdc650-0000-4000-8000-000000000000.png';

const ownerInput = (overrides: Partial<RecentGeneratedImagesNoteInput> = {}): RecentGeneratedImagesNoteInput => ({
  editImageAvailable: true,
  sessionOwnerId: 'owner',
  callerId: 'owner',
  recentImages: [{ key: KEY, prompt: 'a red bike' }],
  ...overrides,
});

describe('buildRecentGeneratedImagesNote', () => {
  it('advertises the generated keys to the session owner', () => {
    const note = buildRecentGeneratedImagesNote(ownerInput());

    expect(note).toHaveLength(1);
    expect(note[0].role).toBe('system');
    expect(note[0].content).toContain('# Recently generated images');
    expect(note[0].content).toContain(`- ${KEY} - from: "a red bike"`);
  });

  it('omits the prompt suffix when the image has no prompt', () => {
    const [note] = buildRecentGeneratedImagesNote(ownerInput({ recentImages: [{ key: KEY, prompt: '' }] }));

    expect(note.content).toContain(`- ${KEY}\n`);
    expect(note.content).not.toContain('from:');
  });

  it('hides the note from a share recipient, whose edit_image would refuse these keys', () => {
    expect(buildRecentGeneratedImagesNote(ownerInput({ callerId: 'sharee' }))).toEqual([]);
  });

  it('hides the note when edit_image is not in the built tool list', () => {
    expect(buildRecentGeneratedImagesNote(ownerInput({ editImageAvailable: false }))).toEqual([]);
  });

  it('hides the note when there are no recent images', () => {
    expect(buildRecentGeneratedImagesNote(ownerInput({ recentImages: [] }))).toEqual([]);
    expect(buildRecentGeneratedImagesNote(ownerInput({ recentImages: undefined }))).toEqual([]);
  });
});
