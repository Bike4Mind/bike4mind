import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import type { ModelInfo } from '@bike4mind/common';
import { useLLM } from '@client/app/contexts/LLMContext';
import { updateSessionToServer } from '@client/app/utils/sessionsAPICalls';

interface UseAffordableModelOfferArgs {
  enforceCredits: boolean;
  modelsLoaded: boolean;
  selectedModelId: string;
  sessionId: string | null | undefined;
}

/** Visibility, per-model dismissal and selection of the affordable-model offer above the composer. */
export function useAffordableModelOffer({
  enforceCredits,
  modelsLoaded,
  selectedModelId,
  sessionId,
}: UseAffordableModelOfferArgs) {
  const [dismissedModelId, setDismissedModelId] = useState<string | null>(null);

  const onSelect = useCallback(
    (affordableModel: ModelInfo) => {
      useLLM.getState().selectSessionModel(affordableModel.id, affordableModel);
      if (sessionId) {
        void updateSessionToServer({ id: sessionId, lastUsedModel: affordableModel.id }).catch(error => {
          console.error('Failed to persist affordable model selection:', error);
          toast.error('Could not save the model change to this chat. The active model still changed.');
        });
      }
    },
    [sessionId]
  );

  const onDismiss = useCallback(() => setDismissedModelId(selectedModelId), [selectedModelId]);

  return {
    show: enforceCredits && modelsLoaded && dismissedModelId !== selectedModelId,
    onSelect,
    onDismiss,
  };
}
