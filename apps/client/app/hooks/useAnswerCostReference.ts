import { useMemo } from 'react';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { pickAnswerCostReference, type AnswerCostReference } from '@client/app/utils/creditEstimate';

/** The mid-tier model credit estimates are quoted on, priced from the live catalog; null until known. */
export function useAnswerCostReference(): AnswerCostReference | null {
  const { data: models } = useModelInfo();
  return useMemo(() => (models ? pickAnswerCostReference(models) : null), [models]);
}
