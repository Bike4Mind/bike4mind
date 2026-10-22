import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { GenerateImageToolCall } from '@bike4mind/common';
// Lean subpath, NOT the '@bike4mind/services' barrel: the barrel pulls server-only
// modules into the browser bundle and breaks the build.
import { estimateImageToolCredits } from '@bike4mind/services/imageCost';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { formatAnswerCost } from '@client/app/utils/formatCredits';

export interface ImageToolPrice {
  modelId: string;
  modelName: string;
  credits: number;
  label: string;
}

export const IMAGE_TOOL_PRICE_TOOLTIP =
  'Estimated credits per image at your saved settings. The assistant can change the size, quality or number of images, which changes the final charge.';

export const formatImageToolPrice = (credits: number): string =>
  credits === 0 ? 'Free' : `~${formatAnswerCost(credits)}/image`;

/**
 * Pre-send price of one image_generation tool image for `model` at the saved quality/size.
 * Mirrors the `imageConfig` useSendMessage sends, minus the agent `preferredImageModel`
 * override, which only applies to that agent's turns. Null until model info loads or when the
 * model has no price.
 */
export function useImageToolPrice(model: string | undefined): ImageToolPrice | null {
  const { quality, size } = useLLM(useShallow(s => ({ quality: s.quality, size: s.size })));
  const { data: modelInfoRepo } = useModelInfo();

  return useMemo(() => {
    if (!modelInfoRepo) return null;
    // The store holds a plain string; the schema narrows `model` to the static enum, which
    // runtime ids such as `local-image/<checkpoint>` fall outside of.
    const estimate = estimateImageToolCredits(modelInfoRepo, { model, quality, size } as GenerateImageToolCall);
    if (!estimate) return null;
    const modelName = modelInfoRepo.find(m => m.id === estimate.model)?.name ?? estimate.model;
    return {
      modelId: estimate.model,
      modelName,
      credits: estimate.credits,
      label: formatImageToolPrice(estimate.credits),
    };
  }, [modelInfoRepo, model, quality, size]);
}
