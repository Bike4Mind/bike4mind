/**
 * Prompt-builder taxonomy + assembly.
 *
 * The image models this app targets (Flux, GPT-Image, Gemini) all prefer natural
 * language and explicitly reject Stable-Diffusion "tag soup" and weight syntax.
 * So the chips are prose-friendly fragments and `assemblePrompt` stitches them
 * into a sentence rather than a comma-joined keyword list. Subject-first, which
 * matches Flux's front-loading and GPT-Image's recommended ordering.
 *
 * "quality" is intentionally NOT a category: terms like "8k, masterpiece, highly
 * detailed" are SD-era boosters these models treat as noise.
 *
 * The vocabulary here is a deliberately small v1 starter set - expand freely; it
 * is a hardcoded client-side set (no server/admin surface).
 */

export type PromptCategoryKey = 'subject' | 'scene' | 'style' | 'mood' | 'lighting';

export interface PromptCategory {
  key: PromptCategoryKey;
  /** Display label for the chip group. */
  label: string;
  /** Short hint shown under the label. */
  hint: string;
  /** Prose-friendly chip values. Multi-select. */
  chips: string[];
}

/** Selected chip values per category (multi-select). */
export type PromptSelections = Record<PromptCategoryKey, string[]>;

export const EMPTY_SELECTIONS: PromptSelections = {
  subject: [],
  scene: [],
  style: [],
  mood: [],
  lighting: [],
};

/**
 * Category order is also the assembly order (subject first). Chip phrasing is
 * chosen to read naturally in the scaffold: subjects carry their own article,
 * scenes are prepositional phrases, styles are adjectives, moods are adjective
 * phrases, lighting are noun phrases.
 */
export const PROMPT_BUILDER_CATEGORIES: PromptCategory[] = [
  {
    key: 'subject',
    label: 'Subject',
    hint: 'What the image is of',
    chips: [
      'a lone figure',
      'a portrait of a person',
      'a mountain landscape',
      'a city skyline',
      'a cozy interior',
      'a still life arrangement',
      'a small animal',
      'a product on a pedestal',
      'an abstract composition',
    ],
  },
  {
    key: 'scene',
    label: 'Scene',
    hint: 'Where it takes place',
    chips: [
      'in a dense forest',
      'on a windswept beach',
      'on a rain-slicked city street',
      'in a sunlit meadow',
      'against a plain studio backdrop',
      'in a bustling market',
      'under a starry night sky',
      'in a minimalist room',
    ],
  },
  {
    key: 'style',
    label: 'Style',
    hint: 'The visual medium / look',
    chips: [
      'photorealistic',
      'cinematic',
      'oil-painting',
      'watercolor',
      'anime',
      '3D-rendered',
      'pencil-sketch',
      'vintage film',
      'flat-illustration',
    ],
  },
  {
    key: 'mood',
    label: 'Mood',
    hint: 'The feeling / atmosphere',
    chips: [
      'serene',
      'dramatic and moody',
      'warm and inviting',
      'dark and mysterious',
      'bright and playful',
      'melancholic',
      'epic and grand',
      'dreamlike',
    ],
  },
  {
    key: 'lighting',
    label: 'Lighting',
    hint: 'How it is lit',
    chips: [
      'golden-hour light',
      'soft studio lighting',
      'dramatic rim lighting',
      'moody low-key lighting',
      'bright natural daylight',
      'a neon glow',
      'backlighting',
      'overcast, diffused light',
    ],
  },
];

/**
 * Flat suggestion set for the free-text input's autocomplete - the chip values
 * plus a few common extras. Static and client-side.
 */
export const PROMPT_SUGGESTIONS: string[] = Array.from(
  new Set([
    ...PROMPT_BUILDER_CATEGORIES.flatMap(c => c.chips),
    'shallow depth of field',
    'wide-angle shot',
    'close-up',
    'symmetrical composition',
    'muted color palette',
    'vibrant colors',
    'high contrast',
    'shot on 35mm film',
  ])
);

const capitalize = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * Stitch the selections + free text into a natural-language prompt.
 *
 * Shape: "A {styles} image of {subjects} {scenes}, {moods}, with {lighting}. {freeText}"
 * Every clause is optional; empty categories are skipped. Multi-selects within a
 * category are joined ("and" for subjects/scenes, "," for styles/moods/lighting).
 * Returns '' when nothing is selected and there is no free text.
 */
export function assemblePrompt(selections: PromptSelections, freeText = ''): string {
  const subjects = selections.subject.join(' and ');
  const scenes = selections.scene.join(' and ');
  const styles = selections.style.join(', ');
  const moods = selections.mood.join(', ');
  const lighting = selections.lighting.join(', ');
  const extra = freeText.trim();

  const clauses: string[] = [];

  // Head: style + subject.
  if (styles && subjects) clauses.push(`A ${styles} image of ${subjects}`);
  else if (styles) clauses.push(`A ${styles} image`);
  else if (subjects) clauses.push(capitalize(subjects));

  if (scenes) clauses.push(scenes);
  if (moods) clauses.push(moods);
  if (lighting) clauses.push(`with ${lighting}`);

  let prompt = clauses.join(', ');

  if (extra) prompt = prompt ? `${prompt}. ${extra}` : extra;
  if (prompt && !/[.!?]$/.test(prompt)) prompt += '.';

  return prompt;
}
