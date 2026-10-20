import { useMemo } from 'react';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { modelAnswerCost, type ModelAnswerCost } from '@client/app/utils/creditEstimate';

/** What a typical answer costs on the model the user has selected, priced from the live catalog; null until known. */
export function useSelectedModelAnswerCost(): ModelAnswerCost | null {
  const selectedModelId = useLLM(s => s.model);
  const { data: models } = useModelInfo();
  return useMemo(() => {
    const selected = models?.find(m => m.id === selectedModelId);
    return selected ? modelAnswerCost(selected) : null;
  }, [models, selectedModelId]);
}
