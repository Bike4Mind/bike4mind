import { z } from 'zod';

/**
 * Studio's curated scene presets ("Looks"): a named setting whose prompt fragment is added to the user's own prompt.
 * Defined once here so the web Create form and the mobile app show the same list; each client draws a preset's
 * swatch from SCENE_SWATCHES by its token.
 */

export const SCENE_SWATCH_TOKENS = ['slate', 'butcher-block', 'paper-white', 'gingham'] as const;
export const SceneSwatchTokenSchema = z.enum(SCENE_SWATCH_TOKENS);
export type SceneSwatchToken = z.infer<typeof SceneSwatchTokenSchema>;

const HEX_COLOR = /^#[0-9a-f]{6}$/;

export const SceneSwatchSchema = z.object({
  from: z.string().regex(HEX_COLOR),
  to: z.string().regex(HEX_COLOR),
});
export type SceneSwatch = z.infer<typeof SceneSwatchSchema>;

/** The two gradient stops a client paints a preset's swatch with. */
export const SCENE_SWATCHES: Record<SceneSwatchToken, SceneSwatch> = {
  slate: { from: '#2f3b45', to: '#5b6b78' },
  'butcher-block': { from: '#a8743f', to: '#d9b07a' },
  'paper-white': { from: '#f4f4f2', to: '#d9dadc' },
  gingham: { from: '#d64545', to: '#f6e1e1' },
};

// Leaves room for the user's own words inside IMAGE_JOB_PROMPT_MAX_CHARS.
export const SCENE_PROMPT_FRAGMENT_MAX_CHARS = 200;

export const ScenePresetSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  name: z.string().min(1).max(40),
  swatch: SceneSwatchTokenSchema,
  promptFragment: z
    .string()
    .min(1)
    .max(SCENE_PROMPT_FRAGMENT_MAX_CHARS)
    .refine(fragment => fragment === fragment.trim(), { message: 'A prompt fragment must be trimmed' }),
});
export type ScenePreset = z.infer<typeof ScenePresetSchema>;

export const ScenePresetListSchema = z
  .array(ScenePresetSchema)
  .min(1)
  .refine(presets => new Set(presets.map(preset => preset.id)).size === presets.length, {
    message: 'Scene preset ids must be unique',
  });

export const SCENE_PRESETS: readonly ScenePreset[] = ScenePresetListSchema.parse([
  {
    id: 'wet-slate',
    name: 'Wet slate',
    swatch: 'slate',
    promptFragment: 'on a wet dark slate surface with moody side light and glistening water droplets',
  },
  {
    id: 'kitchen-counter',
    name: 'Kitchen counter',
    swatch: 'butcher-block',
    promptFragment: 'on a warm wooden kitchen counter in soft morning window light',
  },
  {
    id: 'studio-white',
    name: 'Studio white',
    swatch: 'paper-white',
    promptFragment: 'on a seamless white studio backdrop with soft even lighting and a gentle shadow',
  },
  {
    id: 'picnic',
    name: 'Picnic',
    swatch: 'gingham',
    promptFragment: 'on a red gingham picnic blanket outdoors in dappled afternoon sunlight',
  },
]);

const FRAGMENT_SEPARATOR = ', ';

/** The preset whose fragment the prompt currently carries, if any. */
export function appliedScenePreset(
  prompt: string,
  presets: readonly ScenePreset[] = SCENE_PRESETS
): ScenePreset | undefined {
  return presets.find(preset => prompt.includes(preset.promptFragment));
}

const isPadding = (char: string): boolean => char === ',' || char.trim() === '';

// Trims whitespace and stray commas from both ends, so the separator never doubles up. A linear scan rather than an
// end-anchored regex, which backtracks quadratically on a long run of padding.
const tidy = (prompt: string): string => {
  let start = 0;
  let end = prompt.length;
  while (start < end && isPadding(prompt[start])) start += 1;
  while (end > start && isPadding(prompt[end - 1])) end -= 1;
  return prompt.slice(start, end);
};

const withoutFragment = (prompt: string, fragment: string): string =>
  prompt.replace(`${FRAGMENT_SEPARATOR}${fragment}`, '').replace(fragment, '');

/**
 * The prompt with `next` as its scene: any other preset's fragment is swapped out and `next`'s is appended after the
 * user's own words (or becomes the prompt when it is empty). `next` undefined removes the current scene.
 */
export function applyScenePreset(
  prompt: string,
  next: ScenePreset | undefined,
  presets: readonly ScenePreset[] = SCENE_PRESETS
): string {
  const current = appliedScenePreset(prompt, presets);
  const base = tidy(current ? withoutFragment(prompt, current.promptFragment) : prompt);
  if (!next) return base;
  return base.length === 0 ? next.promptFragment : `${base}${FRAGMENT_SEPARATOR}${next.promptFragment}`;
}
