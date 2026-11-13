import { describe, expect, it } from 'vitest';
import { isFabFileViewableSettled } from './fabFileQueries';

describe('isFabFileViewableSettled', () => {
  it('keeps polling a file still awaiting moderation', () => {
    expect(isFabFileViewableSettled({ moderationStatus: 'pending' }, 1)).toBe(false);
    expect(isFabFileViewableSettled({ moderationStatus: 'scanning' }, 5)).toBe(false);
  });

  it('stops once the file has a signed URL', () => {
    expect(isFabFileViewableSettled({ fileUrl: 'https://files.example/a.png', moderationStatus: 'clean' }, 2)).toBe(
      true
    );
  });

  it('stops when moderation blocked the file, since no URL will come', () => {
    expect(isFabFileViewableSettled({ moderationStatus: 'blocked' }, 1)).toBe(true);
  });

  it('stops after a bounded number of fetches', () => {
    expect(isFabFileViewableSettled({ moderationStatus: 'pending' }, 29)).toBe(false);
    expect(isFabFileViewableSettled({ moderationStatus: 'pending' }, 30)).toBe(true);
  });
});
