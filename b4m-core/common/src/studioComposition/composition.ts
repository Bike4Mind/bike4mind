import { z } from 'zod';
import {
  STUDIO_OUTPUT_ASPECT_RATIOS,
  STUDIO_OUTPUT_DEFAULT_SIZES,
  STUDIO_TIMELINE_VERSION,
  StudioFileIdSchema,
  StudioTimelineSchema,
  studioTimelineFileIds,
  type StudioOutputAspectRatio,
  type StudioTimeline,
  type StudioTimelineTrack,
  type StudioTimelineTrackKind,
} from './timeline';

/**
 * A Studio Production: a brief, a small brand kit, a shot list and a timeline that arrange many generated assets
 * into one output. The UI calls it a Production; code always says StudioComposition / compositionId so it never
 * reads as the prod environment. Assets are referenced by FabFile id only, never copied.
 *
 * The Mongoose model (packages/database models/content/StudioCompositionModel.ts) must declare exactly the
 * fields of StudioCompositionSchema; its parity test fails when they drift.
 */

export const STUDIO_COMPOSITION_TEMPLATES = [
  'ad_campaign',
  'social_pack',
  'product_video',
  'explainer',
  'short_film',
  'blank',
] as const;
export type StudioCompositionTemplate = (typeof STUDIO_COMPOSITION_TEMPLATES)[number];

export const STUDIO_COMPOSITION_LIMITS = {
  titleMaxLength: 200,
  briefSummaryMaxLength: 4000,
  briefFieldMaxLength: 500,
  brandColorsMax: 8,
  brandProductFilesMax: 20,
  brandCharactersMax: 8,
  characterNameMaxLength: 100,
  shotsMax: 100,
  shotTitleMaxLength: 200,
  shotDescriptionMaxLength: 4000,
  shotFilesMax: 20,
  shotPromptMaxLength: 4000,
  shotIntentMaxLength: 500,
  shotVoiceLineMaxLength: 500,
  listLimitMax: 100,
} as const;

export const StudioCompositionIdSchema = z.string().regex(/^[a-f0-9]{24}$/, 'Not a valid composition id');

const limits = STUDIO_COMPOSITION_LIMITS;

export const StudioCompositionBriefSchema = z.object({
  summary: z.string().trim().max(limits.briefSummaryMaxLength).optional(),
  audience: z.string().trim().max(limits.briefFieldMaxLength).optional(),
  callToAction: z.string().trim().max(limits.briefFieldMaxLength).optional(),
  // A short film's mood, e.g. "wistful" or "tense"; the director matches the music and narration to it.
  tone: z.string().trim().max(limits.briefFieldMaxLength).optional(),
  // The product photo the ad is built around; an image.
  productFileId: StudioFileIdSchema.optional(),
});
export type StudioCompositionBrief = z.infer<typeof StudioCompositionBriefSchema>;

const StudioItemIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'Ids may contain only letters, digits, "_" and "-"');

/** A recurring person or mascot: a Library image passed as a reference on the shots that feature it. */
export const StudioCharacterSchema = z.object({
  id: StudioItemIdSchema,
  name: z.string().trim().min(1).max(limits.characterNameMaxLength),
  fileId: StudioFileIdSchema,
});
export type StudioCharacter = z.infer<typeof StudioCharacterSchema>;

/** A deliberately small first cut of a brand kit; it grows as templates need more. */
export const StudioBrandKitSchema = z.object({
  logoFileId: StudioFileIdSchema.optional(),
  colors: z
    .array(z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colors are #RRGGBB'))
    .max(limits.brandColorsMax)
    .default([]),
  fontFamily: z.string().trim().min(1).max(100).optional(),
  productFileIds: z.array(StudioFileIdSchema).max(limits.brandProductFilesMax).default([]),
  characters: z.array(StudioCharacterSchema).max(limits.brandCharactersMax).default([]),
});
export type StudioBrandKit = z.infer<typeof StudioBrandKitSchema>;

/**
 * One planned shot: what it should show and the takes generated for it. `fileIds` lists every take, the chosen one
 * included, so the alternatives are `fileIds` without `chosenFileId`. Shots are stored as Mixed, so new optional
 * fields need no Mongoose change.
 */
export const StudioShotSchema = z.object({
  id: StudioItemIdSchema,
  title: z.string().trim().min(1).max(limits.shotTitleMaxLength),
  description: z.string().trim().max(limits.shotDescriptionMaxLength).optional(),
  durationMs: z.number().int().positive().optional(),
  fileIds: z.array(StudioFileIdSchema).max(limits.shotFilesMax).default([]),
  // The generation prompt for the shot's takes.
  prompt: z.string().trim().max(limits.shotPromptMaxLength).optional(),
  // The shot's job in the cut, e.g. "hook", "product reveal" or "call to action".
  intent: z.string().trim().max(limits.shotIntentMaxLength).optional(),
  // Must be one of `fileIds` (validateStudioComposition).
  chosenFileId: StudioFileIdSchema.optional(),
  // A video animated from the chosen take; sent to the timeline in its place when present.
  clipFileId: StudioFileIdSchema.optional(),
  // The voiceover or caption line spoken over this shot.
  voiceLine: z.string().trim().max(limits.shotVoiceLineMaxLength).optional(),
  // Brand kit character ids, in the order their references are passed; an id no longer in the kit is ignored.
  characterIds: z.array(StudioItemIdSchema).max(limits.brandCharactersMax).optional(),
});
export type StudioShot = z.infer<typeof StudioShotSchema>;

const StudioShotListSchema = z.array(StudioShotSchema).max(limits.shotsMax);

/** The client-writable content of a composition. Ownership fields are server-set and live on the entity below. */
export const StudioCompositionContentSchema = z.object({
  title: z.string().trim().min(1).max(limits.titleMaxLength),
  template: z.enum(STUDIO_COMPOSITION_TEMPLATES).default('ad_campaign'),
  brief: StudioCompositionBriefSchema.prefault({}),
  brandKit: StudioBrandKitSchema.prefault({}),
  shots: StudioShotListSchema.default([]),
  timeline: StudioTimelineSchema,
  projectId: z
    .string()
    .regex(/^[a-f0-9]{24}$/, 'Not a valid project id')
    .optional(),
});
export type StudioCompositionContent = z.infer<typeof StudioCompositionContentSchema>;

/**
 * The stored entity. Owner-only for now: `userId` is the only access key. `organizationId` is reserved for
 * organization ownership, which waits on a separate decision; nothing writes or reads access through it yet.
 */
export const StudioCompositionSchema = StudioCompositionContentSchema.extend({
  userId: z.string().min(1),
  organizationId: z.string().optional(),
});
export type IStudioComposition = z.infer<typeof StudioCompositionSchema>;

/**
 * What the Studio routes send: the content plus identity and timestamps, never the ownership fields. Dates are
 * coerced so the client can parse the JSON (ISO strings) with the same schema the server responds through.
 */
export const StudioCompositionResponseSchema = StudioCompositionContentSchema.extend({
  id: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type StudioCompositionResponse = z.infer<typeof StudioCompositionResponseSchema>;

/** A list row: the response without the shot list and timeline. */
export const StudioCompositionSummaryResponseSchema = StudioCompositionResponseSchema.omit({
  shots: true,
  timeline: true,
});
export type StudioCompositionSummaryResponse = z.infer<typeof StudioCompositionSummaryResponseSchema>;

/** POST body. Shots or a timeline left out start from the template's defaults. */
export const StudioCompositionCreateInputSchema = z.strictObject({
  ...StudioCompositionContentSchema.shape,
  shots: StudioShotListSchema.optional(),
  timeline: StudioTimelineSchema.optional(),
});
export type StudioCompositionCreateBody = z.input<typeof StudioCompositionCreateInputSchema>;
export type StudioCompositionCreateInput = z.output<typeof StudioCompositionCreateInputSchema>;

/** PATCH body: any content field replaces the stored one whole; `projectId: null` unlinks the project. */
export const StudioCompositionUpdateInputSchema = z
  .strictObject({
    title: StudioCompositionContentSchema.shape.title.optional(),
    template: z.enum(STUDIO_COMPOSITION_TEMPLATES).optional(),
    brief: StudioCompositionBriefSchema.optional(),
    brandKit: StudioBrandKitSchema.optional(),
    shots: StudioShotListSchema.optional(),
    timeline: StudioTimelineSchema.optional(),
    projectId: StudioCompositionContentSchema.shape.projectId.unwrap().nullable().optional(),
  })
  .refine(update => Object.values(update).some(value => value !== undefined), 'Nothing to update');
export type StudioCompositionUpdateBody = z.input<typeof StudioCompositionUpdateInputSchema>;
export type StudioCompositionUpdateInput = z.output<typeof StudioCompositionUpdateInputSchema>;

const DEFAULT_TIMELINE_FPS = 30;

/**
 * What a template starts a production with. Templates are data: the Productions home lists these, and creating a
 * production reads its default timeline (length, output shapes, empty lanes) and starter shots from here.
 */
export type StudioCompositionTemplateDefinition = {
  label: string;
  description: string;
  durationMs: number;
  aspects: StudioOutputAspectRatio[];
  /** Empty lanes the timeline starts with, bottom to top. */
  trackKinds: StudioTimelineTrackKind[];
  /** The shot list's opening outline; each starter becomes a shot with no takes yet. */
  starterShots: { title: string; intent: string }[];
};

const AD_SHOTS = [
  { title: 'Hook', intent: 'hook' },
  { title: 'Product', intent: 'product reveal' },
  { title: 'Benefit', intent: 'benefit' },
  { title: 'Call to action', intent: 'call to action' },
];

// Ads ship in every placement shape at once; the other templates start landscape and add sizes as needed.
export const STUDIO_COMPOSITION_TEMPLATE_DEFINITIONS: Record<
  StudioCompositionTemplate,
  StudioCompositionTemplateDefinition
> = {
  ad_campaign: {
    label: 'Ad campaign',
    description: 'A 15s ad in four shots, cut for 16:9, 9:16 and 1:1.',
    durationMs: 15_000,
    aspects: ['16:9', '9:16', '1:1'],
    trackKinds: ['video', 'voice', 'music', 'captions'],
    starterShots: AD_SHOTS,
  },
  social_pack: {
    label: 'Social pack',
    description: 'Short vertical and square cuts for social feeds.',
    durationMs: 15_000,
    aspects: ['9:16', '1:1', '4:5'],
    trackKinds: ['video', 'music', 'captions'],
    starterShots: [
      { title: 'Hook', intent: 'hook' },
      { title: 'Payoff', intent: 'payoff' },
    ],
  },
  product_video: {
    label: 'Product video',
    description: 'A 30s product walkthrough in 16:9.',
    durationMs: 30_000,
    aspects: ['16:9'],
    trackKinds: ['video', 'voice', 'music', 'captions'],
    starterShots: [
      { title: 'Intro', intent: 'hook' },
      { title: 'Features', intent: 'features' },
      { title: 'In use', intent: 'demonstration' },
      { title: 'Call to action', intent: 'call to action' },
    ],
  },
  explainer: {
    label: 'Explainer',
    description: 'A 60s narrated explainer in 16:9.',
    durationMs: 60_000,
    aspects: ['16:9'],
    trackKinds: ['video', 'voice', 'music', 'captions'],
    starterShots: [
      { title: 'Problem', intent: 'problem' },
      { title: 'Solution', intent: 'solution' },
      { title: 'How it works', intent: 'explanation' },
      { title: 'Wrap-up', intent: 'call to action' },
    ],
  },
  short_film: {
    label: 'Short film',
    description: 'A 60s narrated story with a beginning, middle and end.',
    durationMs: 60_000,
    aspects: ['16:9'],
    trackKinds: ['video', 'voice', 'sfx', 'music', 'captions'],
    starterShots: [
      { title: 'Opening', intent: 'opening' },
      { title: 'Inciting moment', intent: 'inciting incident' },
      { title: 'Climax', intent: 'climax' },
      { title: 'Resolution', intent: 'resolution' },
    ],
  },
  blank: {
    label: 'Blank',
    description: 'An empty 15s timeline in 16:9.',
    durationMs: 15_000,
    aspects: ['16:9'],
    trackKinds: ['video'],
    starterShots: [],
  },
};

/** The lengths and output shapes the Short film brief offers; the chosen ones size its starting timeline. */
export const STUDIO_SHORT_FILM_LENGTHS_MS = [30_000, 60_000, 90_000, 120_000] as const;
export const STUDIO_SHORT_FILM_ASPECTS: readonly StudioOutputAspectRatio[] = STUDIO_OUTPUT_ASPECT_RATIOS;

export type StudioTimelineSizing = { durationMs?: number; aspects?: readonly StudioOutputAspectRatio[] };

/**
 * An empty timeline sized for the template: its default length, output shapes and empty lanes, or the given
 * length and shapes instead.
 */
export const defaultStudioTimeline = (
  template: StudioCompositionTemplate,
  sizing: StudioTimelineSizing = {}
): StudioTimeline => {
  const definition = STUDIO_COMPOSITION_TEMPLATE_DEFINITIONS[template];
  const { trackKinds } = definition;
  const durationMs = sizing.durationMs ?? definition.durationMs;
  const aspects = sizing.aspects ?? definition.aspects;
  return {
    version: STUDIO_TIMELINE_VERSION,
    durationMs,
    fps: DEFAULT_TIMELINE_FPS,
    backgroundColor: '#000000',
    outputs: aspects.map(aspectRatio => ({
      id: `out-${aspectRatio.replace(':', 'x')}`,
      aspectRatio,
      ...STUDIO_OUTPUT_DEFAULT_SIZES[aspectRatio],
    })),
    tracks: trackKinds.map((kind, index) => ({
      id: `track-${kind}-${index + 1}`,
      kind,
      enabled: true,
      clips: [],
    })) as StudioTimelineTrack[],
  };
};

/** The template's starter shots, with no takes yet. */
export const defaultStudioShots = (template: StudioCompositionTemplate): StudioShot[] =>
  STUDIO_COMPOSITION_TEMPLATE_DEFINITIONS[template].starterShots.map(({ title, intent }, index) => ({
    id: `shot-${index + 1}`,
    title,
    intent,
    fileIds: [],
  }));

/** The content fields that reference Library files. */
export type StudioCompositionReferences = Pick<StudioCompositionContent, 'brief' | 'brandKit' | 'shots' | 'timeline'>;

/** Every FabFile id the composition references (brief, brand kit, shots, timeline), deduplicated. */
export const studioCompositionFileIds = (content: StudioCompositionReferences): string[] => {
  const ids = [
    ...(content.brief.productFileId ? [content.brief.productFileId] : []),
    ...(content.brandKit.logoFileId ? [content.brandKit.logoFileId] : []),
    ...content.brandKit.productFileIds,
    ...content.brandKit.characters.map(character => character.fileId),
    ...content.shots.flatMap(shot => [
      ...shot.fileIds,
      ...(shot.chosenFileId ? [shot.chosenFileId] : []),
      ...(shot.clipFileId ? [shot.clipFileId] : []),
    ]),
    ...studioTimelineFileIds(content.timeline),
  ];
  return [...new Set(ids)];
};
