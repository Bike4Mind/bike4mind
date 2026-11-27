import { z } from 'zod';

/*
 * The mod manifest every tier shares (docs/mods-security-design.md section 7) and the Tier 1 skin
 * data a skin may carry. Main validates a skin folder against these (main/mods/skinFolder.ts);
 * the renderer only ever receives the result, as a SkinSummary.
 */

/** Also the folder name under userData/mods and the asset URL host, so lowercase only. */
// A letter is required and a 0x prefix refused: Chromium canonicalises numeric and hex hosts to IPv4.
export const MOD_ID_PATTERN = /^(?=[a-z0-9-]*[a-z])(?!0x)[a-z0-9][a-z0-9-]{1,62}$/;

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const manifestBase = {
  manifest: z.literal(1),
  id: z
    .string()
    .regex(MOD_ID_PATTERN, 'must be 2-63 lowercase letters, digits or dashes, contain a letter and not start with 0x'),
  name: z.string().min(1).max(60),
  version: z.string().regex(SEMVER, 'must be a semantic version like 1.0.0'),
  contract: z.number().int().positive(),
  author: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
};

// One file directly inside sounds/: no subfolders, no dot segments, no absolute paths.
const soundPath = z
  .string()
  .max(120)
  .regex(/^sounds\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.(mp3|ogg)$/, 'must be sounds/<name>.mp3 or .ogg');

/** The moments a sound pack may voice. `needs-you` is deliberately not one: that sound is never replaceable. */
export const SOUND_PACK_EVENTS = ['agent-done', 'agent-error', 'approval-requested', 'finale'] as const;
export type SoundPackEvent = (typeof SOUND_PACK_EVENTS)[number];

/** Strict, so a pack that sets `needs-you` (or any other key) is rejected rather than loaded with it ignored. */
export const soundPackSoundsSchema = z
  .strictObject({
    'agent-done': soundPath,
    'agent-error': soundPath,
    'approval-requested': soundPath,
    finale: soundPath,
  })
  .partial();

export type SoundPackSounds = z.infer<typeof soundPackSoundsSchema>;

const dataManifestSchema = z.strictObject({
  ...manifestBase,
  kind: z.enum(['skin', 'layout', 'view']),
  entry: z.string().min(1).max(200).optional(),
  permissions: z.array(z.string().min(1).max(40)).max(20).optional(),
});

const soundPackManifestSchema = z.strictObject({
  ...manifestBase,
  kind: z.literal('sounds'),
  sounds: soundPackSoundsSchema,
});

/** A mod's mod.json: the discriminated union on `kind`; a sound pack carries its sounds map right here. */
export const modManifestSchema = z
  .discriminatedUnion('kind', [dataManifestSchema, soundPackManifestSchema])
  .superRefine((manifest, context) => {
    // Only a view carries code; a data mod naming an entry document or asking for permissions is malformed.
    if (manifest.kind === 'view' || manifest.kind === 'sounds') return;
    if (manifest.entry !== undefined) {
      context.addIssue({ code: 'custom', path: ['entry'], message: `a ${manifest.kind} has no entry document` });
    }
    if (manifest.permissions && manifest.permissions.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['permissions'],
        message: `a ${manifest.kind} cannot ask for permissions`,
      });
    }
  });

export type ModManifest = z.infer<typeof modManifestSchema>;
export type SoundPackManifest = Extract<ModManifest, { kind: 'sounds' }>;

/** The sound pack data format this app reads. */
export const SOUND_PACK_CONTRACT = 1;

/**
 * The skin data format this app writes. Contract 1 skins still load: their backdrops are moved into the
 * per-scene block (upgradeSkinTokens). A skin written for any other contract is listed as broken.
 */
export const SKIN_CONTRACT = 2;
export const SKIN_CONTRACTS_READ: readonly number[] = [1, SKIN_CONTRACT];

/** Asset URLs for a validated skin: b4m-skin://<id>/<path>, served by main/mods/skinProtocol.ts only. */
export const SKIN_SCHEME = 'b4m-skin';

export const skinAssetUrl = (id: string, relativePath: string): string => `${SKIN_SCHEME}://${id}/${relativePath}`;

/**
 * Every file type a skin folder may contain, with its per-file size cap (bytes). Anything else in the
 * folder, HTML, CSS, JS and SVG included, rejects the whole skin: nothing in a skin is ever a document.
 */
export const SKIN_FILE_TYPES = {
  json: { mimeType: 'application/json', maxBytes: 64 * 1024 },
  png: { mimeType: 'image/png', maxBytes: 2 * 1024 * 1024 },
  webp: { mimeType: 'image/webp', maxBytes: 2 * 1024 * 1024 },
  jpg: { mimeType: 'image/jpeg', maxBytes: 2 * 1024 * 1024 },
  jpeg: { mimeType: 'image/jpeg', maxBytes: 2 * 1024 * 1024 },
  mp3: { mimeType: 'audio/mpeg', maxBytes: 1024 * 1024 },
  ogg: { mimeType: 'audio/ogg', maxBytes: 1024 * 1024 },
} as const;

export type SkinFileType = keyof typeof SKIN_FILE_TYPES;

/** Whole-folder limits, the same as an installed mod's (design doc section 8.2). */
export const SKIN_MAX_FILES = 200;
export const SKIN_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb colour');

// One file directly inside sprites/: no subfolders, no dot segments, no absolute paths.
const imagePath = z
  .string()
  .max(120)
  .regex(/^sprites\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.(png|webp|jpg|jpeg)$/, 'must be sprites/<name>.png, .webp or .jpg');

const percent = z.number().min(0).max(100);
const point = z.strictObject({ x: percent, y: percent });
const sceneName = z
  .string()
  .max(40)
  .regex(/^[a-z][a-z0-9-]*$/, 'must be a lower-case kebab name');
const copyText = z.string().min(1).max(120);

/**
 * What a skin may change in one scene, merged over that scene's definition by the renderer
 * (scene/sceneSkin.ts), which validates the result against the scene's own schema. This schema only
 * bounds the shape and the asset paths; whether a zone or pose exists is the scene's to judge. Arrays
 * (slots, sheets, lights) replace the definition's; objects merge key by key.
 */
export const sceneSkinSchema = z
  .strictObject({
    backdrop: imagePath,
    cast: z
      .strictObject({
        // Bounded so a skin cannot shrink agents, needs-you ones included, to nothing.
        spriteHeight: z.number().min(4).max(40),
        faceY: percent,
        sheets: z
          .array(
            z.strictObject({
              look: z.string().min(1).max(40),
              hue: z.number().min(0).max(360).optional(),
              sprites: z.record(sceneName, imagePath),
            })
          )
          .min(1)
          .max(16),
        host: z.strictObject({
          sprites: z
            .strictObject({
              idle: imagePath,
              writing: imagePath,
              reading: imagePath,
              walking: imagePath,
              cheering: imagePath,
            })
            .partial(),
        }),
      })
      .partial(),
    map: z
      .strictObject({
        zones: z.record(
          sceneName,
          z.strictObject({ slots: z.array(point).min(1).max(64), overflow: point, place: copyText }).partial()
        ),
        door: point,
        host: point,
        board: z
          .strictObject({
            left: percent,
            top: percent,
            width: percent,
            height: percent,
            notes: z.number().int().min(2).max(12),
          })
          .partial(),
        reply: z.union([
          z.strictObject({ top: percent, right: percent }),
          z.strictObject({ top: percent, left: percent }),
        ]),
        lights: z
          .array(
            z.strictObject({
              x: percent,
              y: percent,
              size: z.number().positive().max(100),
              kind: sceneName,
              tone: sceneName.optional(),
            })
          )
          .max(24),
        moon: point,
        embers: point,
      })
      .partial(),
    copy: z
      .strictObject({
        name: copyText,
        hostName: copyText,
        hostTitle: copyText,
        hostGreeting: copyText,
        hostPoses: z
          .strictObject({ idle: copyText, writing: copyText, reading: copyText, walking: copyText, cheering: copyText })
          .partial(),
        board: z
          .strictObject({ title: copyText, name: copyText, item: copyText, items: copyText, empty: copyText })
          .partial(),
        stage: z
          .strictObject({
            host: copyText,
            quiet: copyText,
            talk: copyText,
            empty: copyText,
            emptyArchived: copyText,
            finale: z.strictObject({ complete: copyText, ended: copyText }).partial(),
          })
          .partial(),
      })
      .partial(),
  })
  .partial();

export type SceneSkin = z.infer<typeof sceneSkinSchema>;

const skinTokensBase = {
  states: z
    .strictObject({
      'needs-you': hexColor,
      working: hexColor,
      done: hexColor,
      failed: hexColor,
      stopped: hexColor,
      idle: hexColor,
    })
    .partial()
    .optional(),
  surfaces: z.strictObject({ stage: hexColor, card: hexColor }).partial().optional(),
  type: z
    .strictObject({ family: z.enum(['system', 'serif', 'mono', 'rounded']) })
    .partial()
    .optional(),
  sounds: z.strictObject({ 'needs-you': soundPath, finale: soundPath }).partial().optional(),
};

/**
 * tokens.json. Every key is optional and unknown keys reject the skin. `needs-you` is accepted under
 * states and sounds so a skin that sets it still loads, but the palette merge (statePalette.ts) drops
 * it: the "needs you" colour, its pulse and its sound are never skinnable. `scenes` is keyed by scene
 * id, so a new scene needs no change here; a block for a scene this app does not have is ignored.
 */
export const skinTokensSchema = z.strictObject({
  ...skinTokensBase,
  scenes: z
    .record(sceneName, sceneSkinSchema)
    .refine(scenes => Object.keys(scenes).length <= 16, 'at most 16 scenes')
    .optional(),
});

/** Contract 1's tokens.json: one backdrop image per scene, and no other scene data. */
export const skinTokensV1Schema = z.strictObject({
  ...skinTokensBase,
  sprites: z.strictObject({ tavernBackdrop: imagePath, aquariumBackdrop: imagePath }).partial().optional(),
});

export type SkinTokensV1 = z.infer<typeof skinTokensV1Schema>;

const V1_BACKDROP_SCENES = { tavernBackdrop: 'tavern', aquariumBackdrop: 'aquarium' } as const;

/** A contract 1 skin in the current shape: each backdrop becomes its scene's `backdrop`. */
export function upgradeSkinTokens(tokens: SkinTokensV1): SkinTokens {
  const { sprites, ...rest } = tokens;
  const scenes: Record<string, SceneSkin> = {};
  for (const [key, scene] of Object.entries(V1_BACKDROP_SCENES) as [keyof typeof V1_BACKDROP_SCENES, string][]) {
    const backdrop = sprites?.[key];
    if (backdrop !== undefined) scenes[scene] = { backdrop };
  }
  return Object.keys(scenes).length > 0 ? { ...rest, scenes } : rest;
}

/** Parses tokens.json for the contract its manifest names; the result is always the current shape. */
export function skinTokensSchemaFor(contract: number): z.ZodType<SkinTokens> {
  return contract === 1 ? skinTokensV1Schema.transform(upgradeSkinTokens) : skinTokensSchema;
}

/** Every image path in a scene block, in a stable order, so main can check and serve exactly these. */
export function sceneSkinAssetPaths(scene: SceneSkin): string[] {
  const paths: (string | undefined)[] = [scene.backdrop];
  for (const sheet of scene.cast?.sheets ?? []) paths.push(...Object.values(sheet.sprites));
  paths.push(...Object.values(scene.cast?.host?.sprites ?? {}));
  return paths.filter((path): path is string => path !== undefined);
}

/** The same block with every image path passed through `toUrl` (main turns them into b4m-skin:// URLs). */
export function mapSceneSkinAssets(scene: SceneSkin, toUrl: (path: string) => string): SceneSkin {
  const { backdrop, cast } = scene;
  const mapValues = <T extends Record<string, string | undefined>>(record: T): T =>
    Object.fromEntries(
      Object.entries(record).map(([key, path]) => [key, path === undefined ? undefined : toUrl(path)])
    ) as T;
  return {
    ...scene,
    ...(backdrop !== undefined ? { backdrop: toUrl(backdrop) } : {}),
    ...(cast
      ? {
          cast: {
            ...cast,
            ...(cast.sheets
              ? { sheets: cast.sheets.map(sheet => ({ ...sheet, sprites: mapValues(sheet.sprites) })) }
              : {}),
            ...(cast.host ? { host: { sprites: mapValues(cast.host.sprites) } } : {}),
          },
        }
      : {}),
  };
}

export type SkinTokens = z.infer<typeof skinTokensSchema>;

/** A skin as the renderer sees it: tokens with every sprite and sound path already turned into an asset URL. */
export type SkinSummary =
  | {
      status: 'ok';
      id: string;
      name: string;
      version: string;
      author?: string;
      description?: string;
      tokens: SkinTokens;
      /** Loaded, but parts of it are ignored (needsYouColor.ts); the picker shows these. */
      warnings?: string[];
    }
  | { status: 'broken'; id: string; name?: string; error: string };

/** A sound pack as the renderer sees it: every sound path already turned into an asset URL. */
export type SoundPackSummary =
  | {
      status: 'ok';
      id: string;
      name: string;
      version: string;
      author?: string;
      description?: string;
      sounds: Partial<Record<SoundPackEvent, string>>;
    }
  | { status: 'broken'; id: string; name?: string; error: string };
