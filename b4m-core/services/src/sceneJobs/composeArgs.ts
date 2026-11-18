import type { SceneAudioOptions } from '@bike4mind/common';

/** What `ffmpeg -i <file>` reports about one input; see parseFfmpegProbe. */
export type MediaProbe = {
  /** Null when the container does not report one (a still image, a raw stream). */
  durationSeconds: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
};

const DURATION_RE = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;
// "Stream #0:0[0x1](und): Video: h264 ..."; an embedded cover is a video stream flagged "(attached pic)".
const VIDEO_STREAM_RE = /^\s*Stream #\d+:\d+.*?: Video: (.*)$/gm;
const AUDIO_STREAM_RE = /^\s*Stream #\d+:\d+.*?: Audio: /m;

/**
 * Reads the input summary ffmpeg prints to stderr for `ffmpeg -hide_banner -i <file>` (it exits non-zero for lack of
 * an output, but the summary is complete). Parsing ffmpeg's own report spares shipping ffprobe as a second binary.
 */
export function parseFfmpegProbe(stderr: string): MediaProbe {
  const duration = DURATION_RE.exec(stderr);
  const durationSeconds = duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null;
  const videoStreams = [...stderr.matchAll(VIDEO_STREAM_RE)].map(match => match[1]);
  return {
    durationSeconds: durationSeconds !== null && durationSeconds > 0 ? durationSeconds : null,
    hasVideo: videoStreams.some(details => !details.includes('(attached pic)')),
    hasAudio: AUDIO_STREAM_RE.test(stderr),
  };
}

// User uploads keep their declared mime type, so ffmpeg must not pick a playlist demuxer or open other protocols.
export const SCENE_INPUT_FORMAT_WHITELIST = [
  'mov,mp4,m4a,3gp,3g2,mj2',
  'matroska,webm',
  'mp3',
  'aac',
  'wav',
  'ogg',
  'flac',
  'image2',
  'png_pipe',
  'jpeg_pipe',
  'webp_pipe',
].join(',');

const inputArgs = (path: string): string[] => [
  '-protocol_whitelist',
  'file',
  '-format_whitelist',
  SCENE_INPUT_FORMAT_WHITELIST,
  '-i',
  path,
];

export const probeArgs = (inputPath: string): string[] => ['-hide_banner', '-nostdin', ...inputArgs(inputPath)];

export type SceneComposeArgsInput = {
  videoPath: string;
  audioPath: string;
  coverPath?: string;
  outputPath: string;
  /** The Scene's length: the video's, measured by probe. */
  videoSeconds: number;
  /** The soundtrack's own length, so a trimmed track that ends early still fades where it ends. */
  audioSeconds: number;
  audio: SceneAudioOptions;
  title?: string;
};

const AUDIO_BITRATE = '192k';
// The loop resamples to a fixed rate so its buffer can be sized in samples without knowing the input's rate.
const LOOP_SAMPLE_RATE = 48_000;

// ffmpeg reads seconds with up to microsecond precision; fixed decimals keep the args stable for tests and logs.
const seconds = (value: number): string => value.toFixed(3);

/**
 * The fades as applied: the audible length is the video's (loop) or the shorter of the two (trim), and the fades are
 * clamped to fit inside it, fade-out first, so a short track still ends silent rather than cut.
 */
export function resolveSceneFades(input: Pick<SceneComposeArgsInput, 'videoSeconds' | 'audioSeconds' | 'audio'>) {
  const audibleSeconds =
    input.audio.fit === 'loop' ? input.videoSeconds : Math.min(input.videoSeconds, input.audioSeconds);
  const fadeOutSeconds = Math.min(input.audio.fadeOutSeconds, audibleSeconds);
  const fadeInSeconds = Math.min(input.audio.fadeInSeconds, audibleSeconds - fadeOutSeconds);
  return { audibleSeconds, fadeInSeconds, fadeOutSeconds };
}

/**
 * The ffmpeg argument vector that renders a Scene: the video stream copied as-is, the soundtrack re-encoded to AAC
 * with its fades (and looped when asked), the cover embedded as the MP4's attached picture (the thumbnail players
 * and file browsers show), all cut to the video's length. An argument array, never a shell string: paths and the
 * title reach ffmpeg verbatim.
 */
export function buildSceneComposeArgs(input: SceneComposeArgsInput): string[] {
  const { audibleSeconds, fadeInSeconds, fadeOutSeconds } = resolveSceneFades(input);
  const fades = [
    ...(fadeInSeconds > 0 ? [`afade=t=in:st=0:d=${seconds(fadeInSeconds)}`] : []),
    ...(fadeOutSeconds > 0
      ? [`afade=t=out:st=${seconds(audibleSeconds - fadeOutSeconds)}:d=${seconds(fadeOutSeconds)}`]
      : []),
  ];
  // Looped in the filter graph, not with -stream_loop: the pinned ffmpeg (6.0) never exits when a -stream_loop input
  // outlives a stream-copied output. aloop buffers the whole track, which is shorter than the (capped) video here;
  // a buffer longer than the track loops what it holds at end of input, so one second of slack is safe.
  const loops = input.audio.fit === 'loop' && input.audioSeconds < input.videoSeconds;
  const loopSamples = Math.ceil((input.audioSeconds + 1) * LOOP_SAMPLE_RATE);
  const filters = [
    ...(loops ? [`aresample=${LOOP_SAMPLE_RATE}`, `aloop=loop=-1:size=${loopSamples}`] : []),
    // atrim bounds the looped (endless) stream; anull keeps the graph valid when no fade applies.
    `atrim=end=${seconds(audibleSeconds)}`,
    ...(fades.length > 0 ? fades : ['anull']),
  ];
  const audioFilter = `[1:a:0]${filters.join(',')}[scene_audio]`;

  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    ...inputArgs(input.videoPath),
    ...inputArgs(input.audioPath),
    ...(input.coverPath ? inputArgs(input.coverPath) : []),
    '-filter_complex',
    audioFilter,
    '-map',
    '0:v:0',
    '-map',
    '[scene_audio]',
    ...(input.coverPath ? ['-map', '2:v:0'] : []),
    '-c:v:0',
    'copy',
    ...(input.coverPath ? ['-c:v:1', 'mjpeg', '-disposition:v:1', 'attached_pic'] : []),
    '-c:a',
    'aac',
    '-b:a',
    AUDIO_BITRATE,
    ...(input.title ? ['-metadata', `title=${input.title}`] : []),
    '-t',
    seconds(input.videoSeconds),
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    input.outputPath,
  ];
}
