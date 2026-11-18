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

export const modManifestSchema = z
  .strictObject({
    manifest: z.literal(1),
    id: z.string().regex(MOD_ID_PATTERN, 'must be 2-63 lowercase letters, digits or dashes, contain a letter and not start with 0x'),
    name: z.string().min(1).max(60),
    version: z.string().regex(SEMVER, 'must be a semantic version like 1.0.0'),
    kind: z.enum(['skin', 'layout', 'view']),
    contract: z.number().int().positive(),
    entry: z.string().min(1).max(200).optional(),
    author: z.string().max(100).optional(),
    description: z.string().max(500).optional(),
    permissions: z.array(z.string().min(1).max(40)).max(20).optional(),
  })
  .superRefine((manifest, context) => {
    // Only a view carries code; a data mod naming an entry document or asking for permissions is malformed.
    if (manifest.kind === 'view') return;
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

/** The skin data format this app reads. A skin written for another one is listed as broken. */
export const SKIN_CONTRACT = 1;

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

// One file directly inside sprites/ or sounds/: no subfolders, no dot segments, no absolute paths.
const imagePath = z
  .string()
  .max(120)
  .regex(/^sprites\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.(png|webp|jpg|jpeg)$/, 'must be sprites/<name>.png, .webp or .jpg');
const soundPath = z
  .string()
  .max(120)
  .regex(/^sounds\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.(mp3|ogg)$/, 'must be sounds/<name>.mp3 or .ogg');

/**
 * tokens.json. Every key is optional and unknown keys reject the skin. `needs-you` is accepted under
 * states and sounds so a skin that sets it still loads, but the palette merge (statePalette.ts) drops
 * it: the "needs you" colour, its pulse and its sound are never skinnable.
 */
export const skinTokensSchema = z.strictObject({
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
  sprites: z.strictObject({ tavernBackdrop: imagePath, aquariumBackdrop: imagePath }).partial().optional(),
  sounds: z.strictObject({ 'needs-you': soundPath, finale: soundPath }).partial().optional(),
});

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
