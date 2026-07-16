import { FC, useMemo } from 'react';
import { Chip, Tooltip } from '@mui/joy';
// Lean subpath, NOT the '@bike4mind/services' barrel: the barrel pulls server-only
// modules into the browser bundle and breaks the build.
import { estimateImageCredits } from '@bike4mind/services/imageCost';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useShallow } from 'zustand/react/shallow';
import { useModelInfo } from '../../../hooks/data/useModelInfo';

/**
 * Live "~ N credits" estimate for the current image-mode settings. Uses the same
 * `estimateImageCredits` helper the server charges with, so the preview matches
 * the bill. Approximate for flexible/arbitrary sizes; renders nothing if the cost
 * can't be computed (unsupported model, missing model info).
 */
export const CostPreviewChip: FC = () => {
  const [model, quality, size, n] = useLLM(useShallow(s => [s.model, s.quality, s.size, s.n]));
  const { data: modelInfoRepo } = useModelInfo();
  const modelInfo = modelInfoRepo?.find(m => m.id === model);

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
    <Tooltip title="Estimated credit cost for the current image generation settings. Approximate for flexible sizes.">
      <Chip size="sm" variant="soft" color="neutral" data-testid="image-cost-preview-chip">
        ~ {credits.toLocaleString()} credits
      </Chip>
    </Tooltip>
  );
};
