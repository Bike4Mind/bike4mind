import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useLLM } from '@client/app/contexts/LLMContext';
import { imageTemplateSettingsSnapshot } from './settingsSnapshot';

/**
 * The active model plus the current image-settings snapshot, from LLMContext.
 * Single home for the reactive settings selection so the panel and the composer
 * indicator can't drift on which fields make up a template. (The send-time
 * recorder reads the snapshot imperatively via useLLM.getState(), so it does not
 * use this hook.)
 */
export function useImageSettingsSnapshot() {
  const [
    model,
    size,
    quality,
    style,
    seed,
    n,
    width,
    height,
    aspect_ratio,
    output_format,
    safety_tolerance,
    prompt_upsampling,
  ] = useLLM(
    useShallow(s => [
      s.model,
      s.size,
      s.quality,
      s.style,
      s.seed,
      s.n,
      s.width,
      s.height,
      s.aspect_ratio,
      s.output_format,
      s.safety_tolerance,
      s.prompt_upsampling,
    ])
  );

  const snapshot = useMemo(
    () =>
      imageTemplateSettingsSnapshot({
        size,
        quality,
        style,
        seed,
        n,
        width,
        height,
        aspect_ratio,
        output_format,
        safety_tolerance,
        prompt_upsampling,
      }),
    [size, quality, style, seed, n, width, height, aspect_ratio, output_format, safety_tolerance, prompt_upsampling]
  );

  return { model, snapshot };
}
