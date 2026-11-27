import { describe, expect, it } from 'vitest';
import { fileUrlSigningDate, FILE_URL_WINDOW_SECONDS } from './signedUrlWindow';

describe('fileUrlSigningDate', () => {
  it('returns the same instant for every time inside one window', () => {
    const start = Date.UTC(2026, 0, 1, 10, 30, 0);
    const a = fileUrlSigningDate(new Date(start + 1000));
    const b = fileUrlSigningDate(new Date(start + FILE_URL_WINDOW_SECONDS * 1000 - 1));
    expect(a.getTime()).toBe(start);
    expect(b.getTime()).toBe(start);
  });

  it('moves to the next window at the boundary', () => {
    const start = Date.UTC(2026, 0, 1, 10, 30, 0);
    expect(fileUrlSigningDate(new Date(start + FILE_URL_WINDOW_SECONDS * 1000)).getTime()).toBe(
      start + FILE_URL_WINDOW_SECONDS * 1000
    );
  });
});
