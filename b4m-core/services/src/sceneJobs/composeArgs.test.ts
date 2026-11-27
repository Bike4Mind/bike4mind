import { describe, expect, it } from 'vitest';
import {
  buildSceneComposeArgs,
  parseFfmpegProbe,
  probeArgs,
  resolveSceneFades,
  SCENE_INPUT_FORMAT_WHITELIST,
  type SceneComposeArgsInput,
} from './composeArgs';

const VIDEO_PROBE = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/tmp/x/video':
  Duration: 00:01:05.50, start: 0.000000, bitrate: 163 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 160x120, 10 fps (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp (default)
At least one output file must be specified`;

const MP3_WITH_ART_PROBE = `Input #0, mp3, from '/tmp/x/audio':
  Duration: 00:00:42.12, start: 0.025057, bitrate: 128 kb/s
  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, stereo, fltp, 128 kb/s
  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc), 500x500, 90k tbr, 90k tbn (attached pic)
At least one output file must be specified`;

const IMAGE_PROBE = `Input #0, png_pipe, from '/tmp/x/cover':
  Duration: N/A, bitrate: N/A
  Stream #0:0: Video: png, rgb24(pc), 64x64, 25 fps, 25 tbr, 25 tbn
At least one output file must be specified`;

describe('parseFfmpegProbe', () => {
  it('reads the duration and stream kinds of a video', () => {
    expect(parseFfmpegProbe(VIDEO_PROBE)).toEqual({ durationSeconds: 65.5, hasVideo: true, hasAudio: true });
  });

  it('does not count embedded album art as a video stream', () => {
    expect(parseFfmpegProbe(MP3_WITH_ART_PROBE)).toEqual({ durationSeconds: 42.12, hasVideo: false, hasAudio: true });
  });

  it('reports no duration for a still image', () => {
    expect(parseFfmpegProbe(IMAGE_PROBE)).toEqual({ durationSeconds: null, hasVideo: true, hasAudio: false });
  });

  it('reports nothing for an unreadable file', () => {
    expect(parseFfmpegProbe('/tmp/x/video: Invalid data found when processing input')).toEqual({
      durationSeconds: null,
      hasVideo: false,
      hasAudio: false,
    });
  });
});

const base: SceneComposeArgsInput = {
  videoPath: '/w/video',
  audioPath: '/w/audio',
  outputPath: '/w/scene.mp4',
  videoSeconds: 10,
  audioSeconds: 30,
  audio: { fit: 'trim', fadeInSeconds: 0, fadeOutSeconds: 1.5 },
};

const valueAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

const whitelistedInput = (path: string) => [
  '-protocol_whitelist',
  'file',
  '-format_whitelist',
  SCENE_INPUT_FORMAT_WHITELIST,
  '-i',
  path,
];

const expectEveryInputWhitelisted = (args: string[]) => {
  const inputs = args.flatMap((arg, index) => (arg === '-i' ? [index] : []));
  expect(inputs.length).toBeGreaterThan(0);
  for (const index of inputs) {
    expect(args.slice(index - 4, index)).toEqual([
      '-protocol_whitelist',
      'file',
      '-format_whitelist',
      SCENE_INPUT_FORMAT_WHITELIST,
    ]);
  }
};

describe('probeArgs', () => {
  it('restricts the protocol and demuxer before the input', () => {
    const args = probeArgs('/w/video');
    expectEveryInputWhitelisted(args);
    expect(args.slice(-2)).toEqual(['-i', '/w/video']);
  });
});

describe('input whitelist in buildSceneComposeArgs', () => {
  it.each([
    ['without a cover', undefined],
    ['with a cover', '/w/cover'],
  ])('precedes every -i %s', (_label, coverPath) => {
    const args = buildSceneComposeArgs({ ...base, ...(coverPath && { coverPath }) });
    expectEveryInputWhitelisted(args);
    expect(args.filter(arg => arg === '-i')).toHaveLength(coverPath ? 3 : 2);
  });
});

describe('buildSceneComposeArgs', () => {
  it('copies the video, re-encodes the trimmed audio to AAC and cuts to the video length', () => {
    expect(buildSceneComposeArgs(base)).toEqual([
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-y',
      ...whitelistedInput('/w/video'),
      ...whitelistedInput('/w/audio'),
      '-filter_complex',
      '[1:a:0]atrim=end=10.000,afade=t=out:st=8.500:d=1.500[scene_audio]',
      '-map',
      '0:v:0',
      '-map',
      '[scene_audio]',
      '-c:v:0',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-t',
      '10.000',
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      '/w/scene.mp4',
    ]);
  });

  it('loops a track shorter than the video in the filter graph and fades across the whole video', () => {
    const args = buildSceneComposeArgs({
      ...base,
      audioSeconds: 3,
      audio: { fit: 'loop', fadeInSeconds: 2, fadeOutSeconds: 1 },
    });
    expect(args).not.toContain('-stream_loop');
    expect(valueAfter(args, '-filter_complex')).toBe(
      '[1:a:0]aresample=48000,aloop=loop=-1:size=192000,atrim=end=10.000,afade=t=in:st=0:d=2.000,afade=t=out:st=9.000:d=1.000[scene_audio]'
    );
  });

  it('does not loop a track that already covers the video', () => {
    const args = buildSceneComposeArgs({ ...base, audio: { ...base.audio, fit: 'loop' } });
    expect(valueAfter(args, '-filter_complex')).toBe(
      '[1:a:0]atrim=end=10.000,afade=t=out:st=8.500:d=1.500[scene_audio]'
    );
  });

  it('fades a trimmed track that is shorter than the video where the track ends', () => {
    const args = buildSceneComposeArgs({ ...base, audioSeconds: 4, audio: { ...base.audio, fadeOutSeconds: 2 } });
    expect(args).not.toContain('-stream_loop');
    expect(valueAfter(args, '-filter_complex')).toBe(
      '[1:a:0]atrim=end=4.000,afade=t=out:st=2.000:d=2.000[scene_audio]'
    );
    // The Scene still runs as long as its video.
    expect(valueAfter(args, '-t')).toBe('10.000');
  });

  it('keeps a valid filter graph when no fade applies', () => {
    const args = buildSceneComposeArgs({ ...base, audio: { fit: 'trim', fadeInSeconds: 0, fadeOutSeconds: 0 } });
    expect(valueAfter(args, '-filter_complex')).toBe('[1:a:0]atrim=end=10.000,anull[scene_audio]');
  });

  it('embeds the cover as the attached picture and passes the title as one argument', () => {
    const title = 'Sunrise; rm -rf / && echo "x"';
    const args = buildSceneComposeArgs({ ...base, coverPath: '/w/cover', title });
    expect(args.slice(args.indexOf('/w/cover') - 5, args.indexOf('/w/cover') + 1)).toEqual(
      whitelistedInput('/w/cover')
    );
    expect(args).toEqual(
      expect.arrayContaining(['-map', '2:v:0', '-c:v:1', 'mjpeg', '-disposition:v:1', 'attached_pic'])
    );
    expect(valueAfter(args, '-metadata')).toBe(`title=${title}`);
  });
});

describe('resolveSceneFades', () => {
  it('clamps fades that do not fit the audible length, fade-out first', () => {
    expect(
      resolveSceneFades({
        videoSeconds: 3,
        audioSeconds: 3,
        audio: { fit: 'trim', fadeInSeconds: 10, fadeOutSeconds: 2 },
      })
    ).toEqual({ audibleSeconds: 3, fadeInSeconds: 1, fadeOutSeconds: 2 });
    expect(
      resolveSceneFades({
        videoSeconds: 1,
        audioSeconds: 9,
        audio: { fit: 'trim', fadeInSeconds: 1, fadeOutSeconds: 5 },
      })
    ).toEqual({ audibleSeconds: 1, fadeInSeconds: 0, fadeOutSeconds: 1 });
  });
});
