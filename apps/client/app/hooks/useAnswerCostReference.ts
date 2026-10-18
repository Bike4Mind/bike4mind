import { useMemo } from 'react';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { pickAnswerCostReference, type AnswerCostReference } from '@client/app/utils/creditEstimate';

/** The premium and budget models credit estimates are quoted between, priced from the live catalog; null until known. */
export function useAnswerCostReference(): AnswerCostReference | null {
  const { data: models } = useModelInfo();
  return useMemo(() => (models ? pickAnswerCostReference(models) : null), [models]);
}
