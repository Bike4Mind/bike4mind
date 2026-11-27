import { describe, expect, it } from 'vitest';
import { parseFfmpegMajorVersion, parseProgressLine } from './ffmpeg';

describe('parseProgressLine', () => {
  it('reads out_time_us and out_time_ms as microseconds', () => {
    expect(parseProgressLine('out_time_us=2500000')).toBe(2500);
    expect(parseProgressLine('out_time_ms=1000000')).toBe(1000);
  });

  it('ignores other keys and N/A', () => {
    expect(parseProgressLine('out_time=00:00:02.500000')).toBeNull();
    expect(parseProgressLine('out_time_us=N/A')).toBeNull();
    expect(parseProgressLine('progress=continue')).toBeNull();
  });
});

describe('parseFfmpegMajorVersion', () => {
  it.each([
    ['ffmpeg version 5.1.9-0+deb12u1 Copyright (c) 2000-2026 the FFmpeg developers', 5],
    ['ffmpeg version 7.1.1-1+b1 Copyright', 7],
    ['ffmpeg version n6.0 Copyright', 6],
  ])('%s -> %d', (line, major) => {
    expect(parseFfmpegMajorVersion(`${line}\nbuilt with gcc`)).toBe(major);
  });

  it('returns null for anything else', () => {
    expect(parseFfmpegMajorVersion('ffmpeg version N-12345-gabcdef')).toBeNull();
  });
});
