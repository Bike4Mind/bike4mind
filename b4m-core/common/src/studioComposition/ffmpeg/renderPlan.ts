import { studioClipCropFor, studioCropFfmpegFilter } from '../crop';
import type {
  StudioAudioClip,
  StudioCaptionClip,
  StudioTimeline,
  StudioTimelineOutput,
  StudioVideoClip,
} from '../timeline';
import { estimateCaptionMaxLineChars, wrapStudioCaption } from './wrapCaption';

/**
 * Turns one timeline output into an ffmpeg invocation. Pure and I/O-free (no Node APIs), so the render worker and a
 * desktop client can share it: the caller supplies local paths, writes `files`, then spawns `ffmpeg` with `args` (an
 * argv, never a shell string). Implements the rendering rules documented on
 * StudioTimelineSchema (b4m-core/common/src/studioComposition/timeline.ts); caption layout mirrors the browser
 * preview's Caption (apps/client/app/components/Studio/productions/TimelinePreview.tsx), so keep the two in sync.
 */

export type StudioRenderSourceKind = 'video' | 'image' | 'audio';

export type StudioRenderSource = { localPath: string; kind: StudioRenderSourceKind; hasAudio: boolean };

export type StudioCaptionFontKind = 'sans' | 'serif' | 'mono';

const DEJAVU_DIR = '/usr/share/fonts/truetype/dejavu';

/**
 * The default font files: fonts-dejavu-core's paths on Debian, as installed in the render image
 * (apps/workers/Dockerfile.renderworker). Bold, as the preview draws. Another host passes its own via `fonts`.
 */
export const STUDIO_CAPTION_FONTS: Record<StudioCaptionFontKind, string> = {
  sans: `${DEJAVU_DIR}/DejaVuSans-Bold.ttf`,
  serif: `${DEJAVU_DIR}/DejaVuSerif-Bold.ttf`,
  mono: `${DEJAVU_DIR}/DejaVuSansMono-Bold.ttf`,
};

const MONO_FAMILY = /mono|courier|consolas|menlo|monaco|code/;
const SERIF_FAMILY = /georgia|times|garamond|palatino|cambria|baskerville|didot/;

/** Maps a free-text CSS font family onto the image's fonts; anything unrecognised is the default sans-serif. */
export const studioCaptionFontKind = (fontFamily: string | undefined): StudioCaptionFontKind => {
  const family = (fontFamily ?? '').toLowerCase();
  if (MONO_FAMILY.test(family)) return 'mono';
  if (SERIF_FAMILY.test(family) || (/serif/.test(family) && !/sans/.test(family))) return 'serif';
  return 'sans';
};

export class StudioRenderPlanError extends Error {
  override name = 'StudioRenderPlanError';
}

export type StudioRenderPlanInput = {
  timeline: StudioTimeline;
  output: StudioTimelineOutput;
  /** Keyed by FabFile id; every media clip on an enabled track must have an entry. */
  sources: ReadonlyMap<string, StudioRenderSource>;
  outputPath: string;
  /** Where the caller will write the filter graph script (returned in `files`). */
  filterScriptPath: string;
  /** Where the caller will write the text of caption line `index` (returned in `files`). */
  captionTextPath: (index: number) => string;
  fonts?: Record<StudioCaptionFontKind, string>;
  /** The installed ffmpeg's major version; picks how the filter script is passed. Defaults to 7. */
  ffmpegMajorVersion?: number;
};

export type StudioRenderPlanFile = { path: string; content: string };

export type StudioRenderPlan = {
  args: string[];
  /** Must exist before ffmpeg starts: the filter graph script and one text file per caption line. */
  files: StudioRenderPlanFile[];
  /** Encoded size; an odd output edge is rounded down to even, which H.264 4:2:0 requires. */
  width: number;
  height: number;
  durationSeconds: number;
};

const AUDIO_SAMPLE_RATE = 48_000;

// Matches the preview: a 6% vertical inset, line-height 1.25, and box padding of 0.15em x 0.4em when a caption has
// a background. drawtext boxes each line, so the vertical padding is sized to close the gap between line boxes.
const CAPTION_INSET_FRACTION = 0.06;
const CAPTION_LINE_HEIGHT = 1.25;
const CAPTION_BOX_PAD_X_EM = 0.4;
const CAPTION_BOX_PAD_Y_EM = 0.125;

const FILTER_ARG_SPECIALS = /[\\':]/g;
const FILTER_GRAPH_SPECIALS = /[\\'[\],;]/g;

/** Escapes a value for a filter option inside a filter graph: once for the option parser, once for the graph. */
export const escapeFfmpegFilterValue = (value: string): string =>
  value.replace(FILTER_ARG_SPECIALS, match => `\\${match}`).replace(FILTER_GRAPH_SPECIALS, match => `\\${match}`);

/** #RRGGBB to ffmpeg's 0xRRGGBB. The schema guarantees the shape; anything else is a bug upstream. */
export const toFfmpegColor = (hex: string): string => {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new StudioRenderPlanError(`Unsupported color ${hex}`);
  return `0x${hex.slice(1).toUpperCase()}`;
};

/** Seconds as a short decimal string; ffmpeg takes these for -ss/-t and filter times. */
const seconds = (value: number): string => String(Number(value.toFixed(6)));

const evenFloor = (value: number): number => value - (value % 2);

type ClipWindow = { startFrame: number; endFrame: number; startSec: number; durationSec: number };

type MediaClip = StudioVideoClip | StudioAudioClip;

type GraphBuilder = {
  inputs: string[];
  inputCount: number;
  videoChains: string[];
  audioLabels: string[];
  audioChains: string[];
};

const audioFades = (clip: MediaClip, durationSec: number): string[] => {
  const fadeIn = Math.min(clip.fadeInMs / 1000, durationSec);
  const fadeOut = Math.min(clip.fadeOutMs / 1000, durationSec);
  return [
    ...(fadeIn > 0 ? [`afade=t=in:st=0:d=${seconds(fadeIn)}`] : []),
    ...(fadeOut > 0 ? [`afade=t=out:st=${seconds(durationSec - fadeOut)}:d=${seconds(fadeOut)}`] : []),
  ];
};

const addAudioChain = (graph: GraphBuilder, inputIndex: number, clip: MediaClip, window: ClipWindow): void => {
  const label = `a${graph.audioLabels.length}`;
  const delaySamples = Math.round(window.startSec * AUDIO_SAMPLE_RATE);
  const filters = [
    `atrim=duration=${seconds(window.durationSec)}`,
    'asetpts=PTS-STARTPTS',
    `aformat=sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo`,
    `volume=${clip.volume}`,
    ...audioFades(clip, window.durationSec),
    `adelay=delays=${delaySamples}S:all=1`,
  ];
  graph.audioChains.push(`[${inputIndex}:a]${filters.join(',')}[${label}]`);
  graph.audioLabels.push(`[${label}]`);
};

const fitFilters = (clip: StudioVideoClip, output: StudioTimelineOutput, width: number, height: number): string[] => {
  const crop = studioClipCropFor(clip, output.aspectRatio);
  // The crop already has the output's shape, so a plain scale fills the frame exactly.
  if (crop) return [studioCropFfmpegFilter(crop, { width, height }), `scale=${width}:${height}`, 'format=yuva420p'];
  return clip.fit === 'cover'
    ? [
        `scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2`,
        `crop=${width}:${height}`,
        'format=yuva420p',
      ]
    : [
        `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
        'format=yuva420p',
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
      ];
};

const videoFades = (clip: StudioVideoClip, durationSec: number): string[] => {
  const fadeIn = Math.min(clip.fadeInMs / 1000, durationSec);
  const fadeOut = Math.min(clip.fadeOutMs / 1000, durationSec);
  return [
    ...(fadeIn > 0 ? [`fade=t=in:st=0:d=${seconds(fadeIn)}:alpha=1`] : []),
    ...(fadeOut > 0 ? [`fade=t=out:st=${seconds(durationSec - fadeOut)}:d=${seconds(fadeOut)}:alpha=1`] : []),
  ];
};

// Half-open over the clip's frames [startFrame, endFrame), so back-to-back clips never share a frame. Comparing
// against half-frame marks keeps a frame time that rounds a hair either side of its edge on the right side.
const enableDuring = (window: ClipWindow, fps: number): string =>
  `enable='gte(t,${seconds((window.startFrame - 0.5) / fps)})*lt(t,${seconds((window.endFrame - 0.5) / fps)})'`;

const sourceFor = (sources: StudioRenderPlanInput['sources'], fileId: string): StudioRenderSource => {
  const source = sources.get(fileId);
  if (!source)
    throw new StudioRenderPlanError(`A timeline clip references a file that could not be loaded (${fileId})`);
  return source;
};

const isGif = (source: StudioRenderSource): boolean => source.localPath.toLowerCase().endsWith('.gif');

// Inputs are always local files the caller downloaded, so no other protocol (http, concat, ...) may be opened.
const LOCAL_INPUT = ['-protocol_whitelist', 'file'];

/**
 * An image is decoded once and held by the tpad in imageHoldFilters, not looped with `-loop`: that is an image2
 * option, and ffmpeg picks the gif and animated WebP demuxers by content, which reject it. A GIF loops by its own
 * loop count, as a browser plays it.
 */
const mediaInputArgs = (source: StudioRenderSource, clip: MediaClip, window: ClipWindow): string[] => {
  const duration = ['-t', seconds(window.durationSec)];
  if (source.kind !== 'image') {
    return ['-ss', seconds(clip.trimStartMs / 1000), ...duration, ...LOCAL_INPUT, '-i', source.localPath];
  }
  return [...(isGif(source) ? ['-ignore_loop', '0'] : []), ...duration, ...LOCAL_INPUT, '-i', source.localPath];
};

/** Holds an image's last frame for the clip, so a still or a GIF that stops looping stays on screen. */
const imageHoldFilters = (source: StudioRenderSource, window: ClipWindow): string[] =>
  source.kind === 'image' ? [`tpad=stop_mode=clone:stop_duration=${seconds(window.durationSec)}`] : [];

type CaptionContext = {
  width: number;
  height: number;
  fps: number;
  captionTextPath: StudioRenderPlanInput['captionTextPath'];
  fonts: StudioRenderPlanInput['fonts'];
};

const captionDrawtexts = (
  clip: StudioCaptionClip,
  window: ClipWindow,
  context: CaptionContext,
  files: StudioRenderPlanFile[]
): string[] => {
  const { style } = clip;
  const fontSize = Math.max(1, Math.round((style.fontSizePct / 100) * context.height));
  const padX = style.backgroundColor ? Math.round(fontSize * CAPTION_BOX_PAD_X_EM) : 0;
  const availableWidth = (style.maxWidthPct / 100) * context.width - 2 * padX;
  const lines = wrapStudioCaption(clip.text, estimateCaptionMaxLineChars(availableWidth, fontSize));

  const lineHeight = fontSize * CAPTION_LINE_HEIGHT;
  const blockHeight = lines.length * lineHeight;
  const inset = CAPTION_INSET_FRACTION * context.height;
  const blockTop =
    style.position === 'top'
      ? inset
      : style.position === 'center'
        ? (context.height - blockHeight) / 2
        : context.height - inset - blockHeight;
  const x = style.align === 'left' ? `${padX}` : style.align === 'right' ? `w-text_w-${padX}` : '(w-text_w)/2';
  const fontFile = (context.fonts ?? STUDIO_CAPTION_FONTS)[studioCaptionFontKind(style.fontFamily)];
  const decoration = style.backgroundColor
    ? [
        'box=1',
        `boxcolor=${toFfmpegColor(style.backgroundColor)}`,
        `boxborderw=${Math.round(fontSize * CAPTION_BOX_PAD_Y_EM)}`,
      ]
    : ['shadowcolor=black@0.6', 'shadowx=0', `shadowy=${Math.max(1, Math.round(fontSize * 0.05))}`];

  return lines.flatMap((line, lineIndex) => {
    if (line.length === 0) return [];
    const textFile = context.captionTextPath(files.length);
    files.push({ path: textFile, content: line });
    const y = Math.round(blockTop + lineIndex * lineHeight + (lineHeight - fontSize) / 2);
    return [
      [
        `drawtext=fontfile=${escapeFfmpegFilterValue(fontFile)}`,
        `textfile=${escapeFfmpegFilterValue(textFile)}`,
        'expansion=none',
        `fontsize=${fontSize}`,
        `fontcolor=${toFfmpegColor(style.color)}`,
        `x=${x}`,
        `y=${y}`,
        ...decoration,
        enableDuring(window, context.fps),
      ].join(':'),
    ];
  });
};

const filterScriptArgs = (ffmpegMajorVersion: number, scriptPath: string): string[] =>
  ffmpegMajorVersion >= 7 ? ['-/filter_complex', scriptPath] : ['-filter_complex_script', scriptPath];

export const buildStudioRenderPlan = (input: StudioRenderPlanInput): StudioRenderPlan => {
  const { timeline, sources, outputPath, filterScriptPath } = input;
  const { fps } = timeline;
  const width = evenFloor(input.output.width);
  const height = evenFloor(input.output.height);
  const frameOf = (ms: number) => Math.round((ms * fps) / 1000);
  const totalFrames = Math.max(1, frameOf(timeline.durationMs));
  const totalSec = totalFrames / fps;

  const windowOf = (clip: { startMs: number; durationMs: number }): ClipWindow | null => {
    const startFrame = frameOf(clip.startMs);
    const endFrame = Math.min(frameOf(clip.startMs + clip.durationMs), totalFrames);
    if (endFrame <= startFrame) return null;
    return { startFrame, endFrame, startSec: startFrame / fps, durationSec: (endFrame - startFrame) / fps };
  };

  const graph: GraphBuilder = { inputs: [], inputCount: 0, videoChains: [], audioLabels: [], audioChains: [] };
  const files: StudioRenderPlanFile[] = [];
  const addInput = (args: string[]): number => {
    graph.inputs.push(...args);
    return graph.inputCount++;
  };

  graph.videoChains.push(
    `color=c=${toFfmpegColor(timeline.backgroundColor)}:s=${width}x${height}:r=${fps}:d=${seconds(totalSec)},format=yuv420p[base]`
  );
  let videoLabel = 'base';
  const captionFilters: string[] = [];
  const captionContext: CaptionContext = {
    width,
    height,
    fps,
    captionTextPath: input.captionTextPath,
    fonts: input.fonts,
  };

  for (const track of timeline.tracks) {
    if (!track.enabled) continue;
    if (track.kind === 'captions') {
      for (const clip of track.clips) {
        const window = windowOf(clip);
        if (window) captionFilters.push(...captionDrawtexts(clip, window, captionContext, files));
      }
      continue;
    }
    if (track.kind === 'video') {
      for (const clip of track.clips) {
        const window = windowOf(clip);
        if (!window) continue;
        const source = sourceFor(sources, clip.fileId);
        if (source.kind === 'audio') throw new StudioRenderPlanError('A video track holds an audio file');
        const inputIndex = addInput(mediaInputArgs(source, clip, window));
        const clipLabel = `v${inputIndex}`;
        const filters = [
          ...imageHoldFilters(source, window),
          ...fitFilters(clip, input.output, width, height),
          'setsar=1',
          `fps=${fps}`,
          `trim=duration=${seconds(window.durationSec)}`,
          ...videoFades(clip, window.durationSec),
          `setpts=PTS-STARTPTS+${seconds(window.startSec)}/TB`,
        ];
        graph.videoChains.push(`[${inputIndex}:v]${filters.join(',')}[${clipLabel}]`);
        const overlaid = `o${inputIndex}`;
        graph.videoChains.push(
          `[${videoLabel}][${clipLabel}]overlay=x=0:y=0:eof_action=pass:${enableDuring(window, fps)}[${overlaid}]`
        );
        videoLabel = overlaid;
        if (source.kind === 'video' && source.hasAudio) addAudioChain(graph, inputIndex, clip, window);
      }
      continue;
    }
    for (const clip of track.clips) {
      const window = windowOf(clip);
      if (!window) continue;
      const source = sourceFor(sources, clip.fileId);
      if (source.kind === 'image') throw new StudioRenderPlanError(`A ${track.kind} track holds an image file`);
      if (!source.hasAudio) continue;
      addAudioChain(graph, addInput(mediaInputArgs(source, clip, window)), clip, window);
    }
  }

  graph.videoChains.push(`[${videoLabel}]${[...captionFilters, 'format=yuv420p'].join(',')}[vout]`);
  // A silent bed of exactly the timeline's length leads the mix (duration=first), so the audio always spans the
  // whole output. Padding the mix with apad instead ended the audio early on some runs.
  const silentBed = `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo,atrim=duration=${seconds(totalSec)}`;
  const audioMix =
    graph.audioLabels.length === 0
      ? `${silentBed}[aout]`
      : `${silentBed}[abed];\n[abed]${graph.audioLabels.join('')}amix=inputs=${graph.audioLabels.length + 1}:duration=first:normalize=0:dropout_transition=0[aout]`;

  files.push({ path: filterScriptPath, content: [...graph.videoChains, ...graph.audioChains, audioMix].join(';\n') });

  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    ...graph.inputs,
    // A script file, not an argv: a long timeline's graph overruns Linux's 128 KiB per-argument limit. ffmpeg 7
    // replaced -filter_complex_script with the `-/option file` form, and later releases drop the old flag.
    ...filterScriptArgs(input.ffmpegMajorVersion ?? 7, filterScriptPath),
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    String(AUDIO_SAMPLE_RATE),
    '-ac',
    '2',
    '-t',
    seconds(totalSec),
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    outputPath,
  ];

  return { args, files, width, height, durationSeconds: totalSec };
};
