import type { CreationTool } from '@shared/chat';

export type SuggestionCategory = 'image' | 'video' | 'voice' | 'sound' | 'music' | 'write' | 'ask';

interface CategorySpec {
  category: SuggestionCategory;
  label: string;
  /** How the muted line under the greeting names it. Absent for the text categories. */
  noun?: string;
  /** The generation tool that has to be offered for the card to show. */
  tool?: string;
  prompts: readonly string[];
}

/** Drawn in this order. Must stay in step with the tool names in main/chat/tools/mediaTools.ts. */
const CATEGORIES: readonly CategorySpec[] = [
  {
    category: 'image',
    label: 'Images',
    noun: 'images',
    tool: 'generate_image',
    prompts: [
      'A watercolor poster of a mountain town at dusk',
      'A flat-color illustration of a fox reading under a lamp, for a book cover',
      'A product photo of a ceramic mug on a linen table in soft morning light',
    ],
  },
  {
    category: 'video',
    label: 'Video',
    noun: 'video',
    tool: 'generate_video',
    prompts: [
      'A 5-second clip of waves rolling onto a beach at sunrise',
      'A slow drone shot drifting over a pine forest in morning fog',
      'A short time-lapse of city lights coming on at dusk',
    ],
  },
  {
    category: 'voice',
    label: 'Voice & speech',
    noun: 'voice',
    tool: 'generate_speech',
    prompts: [
      'Read this aloud in a calm narrator voice: The trail climbs for two miles before the lake comes into view.',
      "Record a friendly voicemail greeting: Hi, you've reached Sam. Leave a message and I'll call you back.",
      'Narrate this slowly and warmly: Take a deep breath in, and let it go.',
    ],
  },
  {
    category: 'sound',
    label: 'Sound effects',
    noun: 'sound effects',
    tool: 'generate_sound_effect',
    prompts: [
      'A door creaking open in an old house',
      'Footsteps crunching on fresh snow, slow and steady',
      'A short, bright chime for an app notification',
    ],
  },
  {
    category: 'music',
    label: 'Music',
    noun: 'music',
    tool: 'generate_music',
    prompts: [
      'A 30-second upbeat lo-fi track for a product demo',
      'A calm solo piano piece for a meditation intro',
      'A 20-second retro synthwave loop for a game menu',
    ],
  },
  {
    category: 'write',
    label: 'Write',
    prompts: [
      "Draft a short email asking my team to move Friday's meeting to Monday",
      'Write a friendly out-of-office reply for next week',
    ],
  },
  {
    category: 'ask',
    label: 'Ask',
    prompts: [
      'Summarize the main arguments for and against a four-day work week',
      'Explain how compound interest works, with a simple example',
    ],
  },
];

export interface BlankChatSuggestion {
  category: SuggestionCategory;
  label: string;
  prompt: string;
  spendsCredits: boolean;
}

/** FNV-1a: stable across runs and renders, which Math.random and a counter are not. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

export function pickPrompt(prompts: readonly string[], sessionId: string, category: SuggestionCategory): string {
  return prompts[hash(`${sessionId}:${category}`) % prompts.length];
}

/**
 * The cards for one blank conversation: every media category whose tool is offered, then one or
 * two text cards - two when that evens out the grid, so a 2- or 3-column layout fills its rows
 * more often than not.
 */
export function blankChatSuggestions(tools: readonly CreationTool[], sessionId: string): BlankChatSuggestion[] {
  const offered = new Map(tools.map(tool => [tool.name, tool]));
  const media = CATEGORIES.filter(spec => spec.tool && offered.has(spec.tool));
  const text = CATEGORIES.filter(spec => !spec.tool).slice(0, media.length % 2 === 1 ? 1 : 2);
  return [...media, ...text].map(spec => ({
    category: spec.category,
    label: spec.label,
    prompt: pickPrompt(spec.prompts, sessionId, spec.category),
    spendsCredits: !!spec.tool && !!offered.get(spec.tool)?.spendsCredits,
  }));
}

/** The muted line under the greeting, naming only what this conversation can make. */
export function blankChatSubline(tools: readonly CreationTool[]): string {
  const offered = new Set(tools.map(tool => tool.name));
  const nouns = CATEGORIES.filter(spec => spec.tool && offered.has(spec.tool)).map(spec => spec.noun as string);
  if (nouns.length === 0) return 'Ask a question, think something through, or draft anything you need to write.';
  const list = nouns.length === 1 ? nouns[0] : `${nouns.slice(0, -1).join(', ')} and ${nouns[nouns.length - 1]}`;
  return `Chat, write, or create ${list}.`;
}
