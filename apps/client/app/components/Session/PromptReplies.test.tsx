import { describe, it, expect } from 'vitest';
import { classifyGeneratedFiles } from './PromptReplies';

describe('classifyGeneratedFiles', () => {
  it('routes each generated file to exactly one bucket (image grid / audio player / download chip)', () => {
    const { images, audio, others } = classifyGeneratedFiles(['a.png', 'b.mp3', 'c.xlsx']);
    expect(images).toEqual(['a.png']);
    expect(audio).toEqual(['b.mp3']);
    expect(others).toEqual(['c.xlsx']);
  });

  it('partitions with no loss and no double-counting across a mixed batch', () => {
    const files = ['x.jpeg', 'y.wav', 'z.pdf', 'w.svg', 'v.flac'];
    const { images, audio, others } = classifyGeneratedFiles(files);
    // Every input lands in exactly one bucket - the three buckets reconstruct the input set.
    expect([...images, ...audio, ...others].sort()).toEqual([...files].sort());
    expect(images).toEqual(['x.jpeg', 'w.svg']);
    expect(audio).toEqual(['y.wav', 'v.flac']);
    expect(others).toEqual(['z.pdf']);
  });

  it('treats .webm/.ogg as download chips, not audio (predominantly video containers)', () => {
    const { audio, others } = classifyGeneratedFiles(['clip.webm', 'track.ogg']);
    expect(audio).toEqual([]);
    expect(others).toEqual(['clip.webm', 'track.ogg']);
  });

  it('matches extensions case-insensitively', () => {
    const { images, audio } = classifyGeneratedFiles(['A.PNG', 'B.MP3']);
    expect(images).toEqual(['A.PNG']);
    expect(audio).toEqual(['B.MP3']);
  });

  it('returns empty buckets for an empty input', () => {
    expect(classifyGeneratedFiles([])).toEqual({ images: [], audio: [], others: [] });
  });
});
