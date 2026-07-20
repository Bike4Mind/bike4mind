/**
 * Educational tooltip copy for the image-mode settings. Written for first-timers:
 * what the knob does, the tradeoff, and any model caveat. Safety tolerance and
 * prompt enhancement are Flux-only (their controls are already model-gated).
 */
export const IMAGE_SETTING_TOOLTIPS = {
  size: 'Output resolution. Larger sizes capture more detail but cost more credits and take longer. Available sizes depend on the model.',
  quality:
    'How much rendering effort to spend. Higher quality means more detail and higher cost. The tiers depend on the model (e.g. low / medium / high, or standard / hd).',
  aspectRatio:
    'The width-to-height shape of the image: 16:9 is wide/landscape, 3:4 is tall/portrait, 1:1 is square. Supported on some models only.',
  seed: 'A number that makes a result reproducible: the same seed with the same prompt and settings regenerates the same image. Leave empty for a fresh random result each time.',
  safetyTolerance:
    'How permissive content moderation is (Flux only). Lower is stricter, higher is more permissive - hard-capped for safety.',
  promptEnhancement:
    'Prompt enhancement (Flux only). When on, the model rewrites and expands your prompt before generating, often adding detail. Turn it off to use your prompt exactly as written.',
} as const;
