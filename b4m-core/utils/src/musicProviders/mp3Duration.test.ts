import { describe, expect, it } from 'vitest';
import { syntheticMp3, syntheticMp3Seconds, xingSeconds } from './__fixtures__/syntheticMp3';
import { mp3DurationSeconds } from './mp3Duration';

describe('mp3DurationSeconds', () => {
  it('estimates a constant-bitrate stream from the first frame', () => {
    expect(mp3DurationSeconds(syntheticMp3({ frames: 200, bitrateKbps: 192 }))).toBeCloseTo(
      syntheticMp3Seconds(200, 192),
      6
    );
  });

  it('skips an ID3v2 tag before the first frame', () => {
    const tagged = syntheticMp3({ frames: 100, id3Bytes: 4096 });
    expect(mp3DurationSeconds(tagged)).toBeCloseTo(syntheticMp3Seconds(100), 6);
  });

  it('uses the Xing frame count when present instead of the byte length', () => {
    const mp3 = syntheticMp3({ frames: 10, xingFrames: 5000 });
    expect(mp3DurationSeconds(mp3)).toBeCloseTo(xingSeconds(5000), 6);
  });

  it('finds the Xing tag after mono MPEG-1 side information', () => {
    const mp3 = syntheticMp3({ frames: 10, mono: true, xingFrames: 4000 });
    expect(mp3DurationSeconds(mp3)).toBeCloseTo(xingSeconds(4000), 6);
  });

  it.each([false, true])('reads MPEG-2 frames (576 samples, half rate), mono=%s', mono => {
    const mp3 = syntheticMp3({ frames: 10, version: 'mpeg2', bitrateKbps: 64, mono, xingFrames: 3000 });
    expect(mp3DurationSeconds(mp3)).toBeCloseTo(xingSeconds(3000, 'mpeg2'), 6);
  });

  it('estimates an MPEG-2 constant-bitrate stream from its own bitrate table', () => {
    const mp3 = syntheticMp3({ frames: 80, version: 'mpeg2', bitrateKbps: 64 });
    expect(mp3DurationSeconds(mp3)).toBeCloseTo(syntheticMp3Seconds(80, 64, 'mpeg2'), 6);
  });

  it('ignores a stray sync word that is not followed by another frame', () => {
    const stray = Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]);
    const mp3 = Buffer.concat([stray, syntheticMp3({ frames: 50 })]);
    expect(mp3DurationSeconds(mp3)).toBeCloseTo(syntheticMp3Seconds(50), 6);
  });

  it('returns undefined when there is no MPEG audio frame', () => {
    expect(mp3DurationSeconds(Buffer.from('RIFF....WAVEfmt '))).toBeUndefined();
    expect(mp3DurationSeconds(Buffer.alloc(0))).toBeUndefined();
  });
});
