import { z } from 'zod';

/**
 * The Studio Productions timeline: one typed JSON spec that the browser preview plays live and the server-side
 * render job feeds to ffmpeg on export. Both consumers read it unchanged, so it only carries what both need:
 * absolute times in integer ms, source in-points (trims) rather than out-points, pixel output sizes, and styling
 * expressed relative to the output frame so one spec renders every output size.
 *
 * Rendering rules both consumers implement identically (the schema cannot express them):
 * - Frames: a clip edge in ms lands on frame Math.round(ms * fps / 1000), at the start and at the end.
 * - Compositing: video tracks draw bottom to top over `backgroundColor`. Anything a clip leaves uncovered
 *   (letterbox bars from `fit: 'contain'`, a fade, a gap between clips) is transparent, so what is below shows.
 * - Framing: a `cover` clip shows the largest region of the output's shape that fits inside its `crop` rect for
 *   that output's aspect ratio, centred in the rect; with no rect the rect is the whole source, a centre crop.
 *   `contain` ignores `crop`. One helper computes this for both consumers: ./crop.
 * - Media: a video track takes video or image files (an image ignores `trimStartMs` and has no audio); the
 *   voice, sfx and music tracks take audio or video files (a video contributes only its audio).
 * - Captions wrap at word boundaries to `maxWidthPct` of the output width and honor explicit line breaks.
 *   A `fontFamily` neither consumer can load falls back to the default sans-serif in both.
 *
 * Bump STUDIO_TIMELINE_VERSION (and add the new shape to the union) for any change an older consumer would
 * misread; additive optional fields with defaults do not need a bump. Within a version, limits and field rules
 * may be loosened but never tightened: stored documents are re-parsed on every read.
 */
export const STUDIO_TIMELINE_VERSION = 1;

/** Upper bounds keep one export render bounded in cost and the stored document small. */
export const STUDIO_TIMELINE_LIMITS = {
  maxDurationMs: 30 * 60 * 1000,
  maxTracks: 32,
  maxClipsPerTrack: 500,
  maxOutputs: 8,
  maxCaptionLength: 500,
  minOutputEdgePx: 128,
  maxOutputEdgePx: 4096,
} as const;

export const STUDIO_TIMELINE_FPS = [24, 25, 30, 50, 60] as const;

export const STUDIO_OUTPUT_ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:5'] as const;
export type StudioOutputAspectRatio = (typeof STUDIO_OUTPUT_ASPECT_RATIOS)[number];

/** The default pixel size for each aspect ratio (1080p class, even edges as H.264 requires). */
export const STUDIO_OUTPUT_DEFAULT_SIZES: Record<StudioOutputAspectRatio, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
};

export const STUDIO_TIMELINE_TRACK_KINDS = ['video', 'voice', 'sfx', 'music', 'captions'] as const;
export type StudioTimelineTrackKind = (typeof STUDIO_TIMELINE_TRACK_KINDS)[number];

// Lowercase only: an uppercase hex id slips past string-equality ownership checks downstream.
export const StudioFileIdSchema = z.string().regex(/^[a-f0-9]{24}$/, 'Not a valid file id');

// Ids are minted by the client so the preview can key clips before a save round-trip.
const TimelineIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'Ids may contain only letters, digits, "_" and "-"');

const MsSchema = z.number().int().nonnegative();
const PositiveMsSchema = z.number().int().positive();
const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colors are #RRGGBB');

export const StudioTimelineOutputSchema = z.object({
  id: TimelineIdSchema,
  aspectRatio: z.enum(STUDIO_OUTPUT_ASPECT_RATIOS),
  width: z.number().int().min(STUDIO_TIMELINE_LIMITS.minOutputEdgePx).max(STUDIO_TIMELINE_LIMITS.maxOutputEdgePx),
  height: z.number().int().min(STUDIO_TIMELINE_LIMITS.minOutputEdgePx).max(STUDIO_TIMELINE_LIMITS.maxOutputEdgePx),
});
export type StudioTimelineOutput = z.infer<typeof StudioTimelineOutputSchema>;

/** Placement on the timeline: the clip plays over [startMs, startMs + durationMs). */
const ClipTimingShape = {
  id: TimelineIdSchema,
  startMs: MsSchema,
  durationMs: PositiveMsSchema,
};

/**
 * Source media: the clip plays the source from `trimStartMs` for `durationMs`, so the out-point is implied. That
 * maps straight onto ffmpeg's `-ss trimStartMs -t durationMs` and the preview's `currentTime = trimStartMs + offset`.
 */
const MediaClipShape = {
  ...ClipTimingShape,
  fileId: StudioFileIdSchema,
  trimStartMs: MsSchema.default(0),
};

/** Linear gain, 1 = unity. Above 1 boosts, which ffmpeg's `volume` filter and a Web Audio GainNode both accept. */
const VolumeSchema = z.number().min(0).max(2);

/** On an audio clip a fade ramps the gain from and to silence. */
const AudioShape = {
  volume: VolumeSchema.default(1),
  fadeInMs: MsSchema.default(0),
  fadeOutMs: MsSchema.default(0),
};

/** How a source whose shape differs from an output's fills that frame: crop to fill, or letterbox to fit. */
export const STUDIO_VIDEO_FIT_MODES = ['cover', 'contain'] as const;

/** Rects narrower than this would upscale a 1080p source past usefulness. */
export const STUDIO_CROP_MIN_EDGE = 0.05;
// Rects are stored as floats, so an edge flush with the frame may sum a hair past 1.
const CROP_EDGE_TOLERANCE = 1e-6;

/** A region of the source frame, normalized 0..1 from its top-left; see the framing rule above. */
export const StudioCropRectSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(STUDIO_CROP_MIN_EDGE).max(1),
    height: z.number().min(STUDIO_CROP_MIN_EDGE).max(1),
  })
  .refine(rect => rect.x + rect.width <= 1 + CROP_EDGE_TOLERANCE && rect.y + rect.height <= 1 + CROP_EDGE_TOLERANCE, {
    message: 'A crop rect must lie inside the source frame',
  });
export type StudioCropRect = z.infer<typeof StudioCropRectSchema>;

/**
 * On a video clip a fade ramps opacity from and to transparent (revealing what is below) and the clip's audio
 * gain with it, so a cross-fade is two overlapping clips on two video tracks.
 */
export const StudioVideoClipSchema = z.object({
  ...MediaClipShape,
  ...AudioShape,
  fit: z.enum(STUDIO_VIDEO_FIT_MODES).default('cover'),
  // Keyed by aspect ratio rather than output id, so a framing survives an output being toggled off and on.
  crop: z.partialRecord(z.enum(STUDIO_OUTPUT_ASPECT_RATIOS), StudioCropRectSchema).optional(),
});
export type StudioVideoClip = z.infer<typeof StudioVideoClipSchema>;

export const StudioAudioClipSchema = z.object({ ...MediaClipShape, ...AudioShape });
export type StudioAudioClip = z.infer<typeof StudioAudioClipSchema>;

export const STUDIO_CAPTION_POSITIONS = ['top', 'center', 'bottom'] as const;
export const STUDIO_CAPTION_ALIGNMENTS = ['left', 'center', 'right'] as const;

/** Sizes are a percentage of the output height so one caption reads the same at every output size. */
export const StudioCaptionStyleSchema = z.object({
  position: z.enum(STUDIO_CAPTION_POSITIONS).default('bottom'),
  align: z.enum(STUDIO_CAPTION_ALIGNMENTS).default('center'),
  fontFamily: z.string().trim().min(1).max(100).optional(),
  fontSizePct: z.number().min(1).max(20).default(5),
  // Percentage of the output width the text block may span before it wraps.
  maxWidthPct: z.number().min(10).max(100).default(90),
  color: HexColorSchema.default('#FFFFFF'),
  backgroundColor: HexColorSchema.optional(),
});
export type StudioCaptionStyle = z.infer<typeof StudioCaptionStyleSchema>;

export const StudioCaptionClipSchema = z.object({
  ...ClipTimingShape,
  text: z.string().trim().min(1).max(STUDIO_TIMELINE_LIMITS.maxCaptionLength),
  style: StudioCaptionStyleSchema.prefault({}),
  /**
   * The voice clip this caption was timed from. While set, the editor moves the caption with that clip's audio
   * (see shiftSyncedCaptions); the renderer ignores it. It must name a clip on a voice track (validateStudioTimeline:
   * unknown_sync_clip); the editor drops the link when that clip is removed.
   */
  syncedVoiceClipId: TimelineIdSchema.optional(),
});
export type StudioCaptionClip = z.infer<typeof StudioCaptionClipSchema>;

const trackShape = <Kind extends StudioTimelineTrackKind, Clip extends z.ZodType>(kind: Kind, clip: Clip) =>
  z.object({
    id: TimelineIdSchema,
    kind: z.literal(kind),
    // A disabled track neither plays nor draws; it stays in the spec so the editor can toggle it back.
    enabled: z.boolean().default(true),
    clips: z.array(clip).max(STUDIO_TIMELINE_LIMITS.maxClipsPerTrack),
  });

/**
 * A track is one lane: its clips never overlap. Layering (two SFX at once, music under voice) is more tracks of the
 * same or another kind. Tracks are listed bottom to top, so a later video track draws over an earlier one.
 */
export const StudioTimelineTrackSchema = z.discriminatedUnion('kind', [
  trackShape('video', StudioVideoClipSchema),
  trackShape('voice', StudioAudioClipSchema),
  trackShape('sfx', StudioAudioClipSchema),
  trackShape('music', StudioAudioClipSchema),
  trackShape('captions', StudioCaptionClipSchema),
]);
export type StudioTimelineTrack = z.infer<typeof StudioTimelineTrackSchema>;
export type StudioTimelineClip = StudioTimelineTrack['clips'][number];

export const StudioTimelineSchema = z.object({
  version: z.literal(STUDIO_TIMELINE_VERSION),
  durationMs: PositiveMsSchema.max(STUDIO_TIMELINE_LIMITS.maxDurationMs),
  fps: z.literal(STUDIO_TIMELINE_FPS),
  backgroundColor: HexColorSchema.default('#000000'),
  outputs: z.array(StudioTimelineOutputSchema).min(1).max(STUDIO_TIMELINE_LIMITS.maxOutputs),
  tracks: z.array(StudioTimelineTrackSchema).max(STUDIO_TIMELINE_LIMITS.maxTracks),
});
export type StudioTimeline = z.infer<typeof StudioTimelineSchema>;
/** The shape a client may send: every defaulted field is optional. */
export type StudioTimelineInput = z.input<typeof StudioTimelineSchema>;

/** Every FabFile id the timeline references, deduplicated, in first-seen order. */
export const studioTimelineFileIds = (timeline: StudioTimeline): string[] => {
  const ids = timeline.tracks.flatMap(track =>
    track.kind === 'captions' ? [] : track.clips.map((clip: StudioVideoClip | StudioAudioClip) => clip.fileId)
  );
  return [...new Set(ids)];
};
