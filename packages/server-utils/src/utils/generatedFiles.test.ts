// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSignedUrl = vi.hoisted(() => vi.fn());
vi.mock('./storage/index', () => ({ getGeneratedImageStorage: () => ({ getSignedUrl }) }));

import { toGeneratedFiles } from './generatedFiles';

beforeEach(() => {
  vi.clearAllMocks();
  getSignedUrl.mockImplementation(async (key: string) => `https://signed.example.invalid/${key}?sig=1`);
});

describe('toGeneratedFiles', () => {
  it('returns presigned URLs signed for the browser with a one-hour expiry', async () => {
    expect(await toGeneratedFiles(['a1b2c3.png'])).toEqual([
      {
        name: 'a1b2c3.png',
        url: 'https://signed.example.invalid/a1b2c3.png?sig=1',
        isImage: true,
        isAudio: false,
        isVideo: false,
      },
    ]);
    expect(getSignedUrl).toHaveBeenCalledWith('a1b2c3.png', 'get', { expiresIn: 3600, audience: 'browser' });
  });

  it('flags non-image files (e.g. .xlsx) with isImage: false', async () => {
    const [file] = await toGeneratedFiles(['report.xlsx']);
    expect(file).toMatchObject({ name: 'report.xlsx', isImage: false, isAudio: false, isVideo: false });
  });

  it('flags generated audio (music_generation .mp3) with isAudio: true, isImage: false', async () => {
    const files = await toGeneratedFiles(['track.mp3', 'clip.WAV', 'art.png', 'report.xlsx']);
    expect(files.map(f => ({ isImage: f.isImage, isAudio: f.isAudio }))).toEqual([
      { isImage: false, isAudio: true },
      { isImage: false, isAudio: true },
      { isImage: true, isAudio: false },
      { isImage: false, isAudio: false },
    ]);
  });

  it('flags a rendered video (.mp4) with isVideo: true, neither isImage nor isAudio', async () => {
    expect(await toGeneratedFiles(['clip.mp4'])).toEqual([
      {
        name: 'clip.mp4',
        url: 'https://signed.example.invalid/clip.mp4?sig=1',
        isImage: false,
        isAudio: false,
        isVideo: true,
      },
    ]);
  });

  it('flags .webm and .mov as video, case-insensitively', async () => {
    const files = await toGeneratedFiles(['a.webm', 'b.MOV', 'c.mp4.txt']);
    expect(files.map(f => f.isVideo)).toEqual([true, true, false]);
  });

  it('returns [] without touching storage for no names', async () => {
    expect(await toGeneratedFiles([])).toEqual([]);
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('signs a repeated name once but keeps one descriptor per input', async () => {
    const files = await toGeneratedFiles(['a.png', 'a.png']);
    expect(files).toHaveLength(2);
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
  });

  it('recognizes common image extensions case-insensitively', async () => {
    const files = await toGeneratedFiles(['x.PNG', 'y.jpeg', 'z.WEBP', 'a.svg', 'b.txt']);
    expect(files.map(f => f.isImage)).toEqual([true, true, true, true, false]);
  });
});
