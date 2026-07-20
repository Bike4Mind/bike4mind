/**
 * M3 - client-side parameter recommendations from prompt keywords. Cheap keyword
 * heuristics (no model call): if the prompt reads like a portrait / landscape /
 * square, suggest a matching aspect ratio. Returns null when nothing matches or
 * the prompt is empty.
 */
export interface AspectRatioRecommendation {
  /** Aspect-ratio value matching the ImageSettings options (e.g. '3:4'). */
  aspectRatio: string;
  /** Human label for the detected orientation. */
  label: string;
}

const RULES: { keywords: string[]; aspectRatio: string; label: string }[] = [
  {
    label: 'portrait',
    aspectRatio: '3:4',
    keywords: ['portrait', 'headshot', 'full-body', 'standing', 'tall ', 'vertical'],
  },
  {
    label: 'landscape',
    aspectRatio: '16:9',
    keywords: ['landscape', 'scenery', 'panorama', 'vista', 'skyline', 'horizon', 'wide shot', 'cityscape'],
  },
  {
    label: 'square',
    aspectRatio: '1:1',
    keywords: ['square', 'logo', 'icon', 'avatar', 'profile picture', 'sticker', 'album cover'],
  },
];

export function recommendAspectRatio(prompt: string): AspectRatioRecommendation | null {
  const p = prompt.toLowerCase();
  if (!p.trim()) return null;
  for (const rule of RULES) {
    if (rule.keywords.some(k => p.includes(k))) {
      return { aspectRatio: rule.aspectRatio, label: rule.label };
    }
  }
  return null;
}
