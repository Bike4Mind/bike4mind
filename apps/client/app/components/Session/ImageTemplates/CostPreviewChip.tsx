import { FC, useMemo } from 'react';
import { Chip, Tooltip } from '@mui/joy';
// Lean subpath, NOT the '@bike4mind/services' barrel: the barrel pulls server-only
// modules into the browser bundle and breaks the build.
import { estimateImageCredits } from '@bike4mind/services/imageCost';
import { isGPTImageModel } from '@bike4mind/common';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useShallow } from 'zustand/react/shallow';
import { useModelInfo } from '../../../hooks/data/useModelInfo';

/**
 * Live credit estimate for the current image-mode settings. Uses the same
 * `estimateImageCredits` helper the server charges with. The composer cannot know
 * which input images the server will select from attachments or history, so GPT
 * prices are shown as a base amount before input-image charges.
 */
export const CostPreviewChip: FC = () => {
  const [model, quality, size, n] = useLLM(useShallow(s => [s.model, s.quality, s.size, s.n]));
  const { data: modelInfoRepo } = useModelInfo();
  const modelInfo = modelInfoRepo?.find(m => m.id === model);
  const hasVariableInputCost = isGPTImageModel(model);

  // Recompute only when a cost-affecting input changes, not on every LLMContext update.
  const credits = useMemo(() => {
    if (!modelInfo) return null;
    try {
      return estimateImageCredits(modelInfo, n ?? 1, {
        model,
        quality,
        size,
      } as Parameters<typeof estimateImageCredits>[2]).requiredCredits;
    } catch {
      return null;
    }
  }, [modelInfo, model, quality, size, n]);

  if (credits === null) return null;

  return (
    <Tooltip
      title={
        hasVariableInputCost
          ? 'Base image cost. Attached or carried-forward input images add credits to the final charge.'
          : 'Estimated credit cost for the current image generation settings. Approximate for flexible sizes.'
      }
    >
      <Chip size="sm" variant="soft" color="neutral" data-testid="image-cost-preview-chip">
        {hasVariableInputCost ? 'From ' : '~ '}
        {credits.toLocaleString()} credits
      </Chip>
    </Tooltip>
  );
};
