import { isGPTImageModel } from '@bike4mind/common';

/**
 * M3 - client-side parameter recommendations from prompt keywords. Cheap keyword
 * heuristics (no model call): if the prompt reads like a portrait / landscape /
 * square, suggest a matching orientation setting. Returns null when nothing
 * matches or the prompt is empty.
 *
 * Model-aware: GPT-Image models steer orientation through `size` (they ignore
 * `aspect_ratio` entirely - see the OpenAI branch in ImageGeneration), every
 * other image model through `aspect_ratio`. So the same detected orientation maps
 * to a different setting depending on the selected model.
 */
export interface OrientationRecommendation {
  /** Detected orientation: 'portrait' | 'landscape' | 'square'. */
  label: string;
  /** Which image setting this recommendation applies to (model-dependent). */
  settingKey: 'aspect_ratio' | 'size';
  /** Recommended value for that setting (e.g. '3:4' or '1024x1536'). */
  value: string;
}

// Each orientation carries both the aspect-ratio value (Flux/Gemini/etc.) and the
// GPT-Image size value. The three GPT sizes below are valid for both gpt-image-1
// and gpt-image-2 (they appear in IMAGE_SIZE_CONSTRAINTS for each).
const RULES: { keywords: string[]; label: string; aspectRatio: string; gptSize: string }[] = [
  {
    label: 'portrait',
    aspectRatio: '3:4',
    gptSize: '1024x1536',
    keywords: ['portrait', 'headshot', 'full-body', 'standing', 'tall', 'vertical'],
  },
  {
    label: 'landscape',
    aspectRatio: '16:9',
    gptSize: '1536x1024',
    keywords: ['landscape', 'scenery', 'panorama', 'vista', 'skyline', 'horizon', 'wide shot', 'cityscape'],
  },
  {
    label: 'square',
    aspectRatio: '1:1',
    gptSize: '1024x1024',
    keywords: ['square', 'logo', 'icon', 'avatar', 'profile picture', 'sticker', 'album cover'],
  },
];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whole-word match so a keyword doesn't fire inside another word (e.g. 'icon'
// in "iconic", 'standing' in "understanding", 'tall' in "install").
const matchesWord = (text: string, keyword: string) => new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'i').test(text);

/**
 * Recommend an orientation setting from prompt keywords for the given model.
 * Returns the setting to change (`aspect_ratio` for most models, `size` for
 * GPT-Image) and the value to use, or null when nothing matches.
 */
export function recommendOrientation(prompt: string, model: string): OrientationRecommendation | null {
  if (!prompt.trim()) return null;
  const rule = RULES.find(r => r.keywords.some(k => matchesWord(prompt, k)));
  if (!rule) return null;
  return isGPTImageModel(model)
    ? { label: rule.label, settingKey: 'size', value: rule.gptSize }
    : { label: rule.label, settingKey: 'aspect_ratio', value: rule.aspectRatio };
}
