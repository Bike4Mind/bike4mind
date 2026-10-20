import { useMemo } from 'react';
import { Box, Button, Typography } from '@mui/joy';
import type { ModelInfo } from '@bike4mind/common';
import { findAffordableModelOffer } from '@client/app/utils/creditEstimate';
import { ComposerNote } from './ComposerNote';

interface AffordableModelOfferProps {
  enabled: boolean;
  models: readonly ModelInfo[];
  selectedModelId: string;
  credits: number;
  inputTokens: number;
  selectedMaxTokens: number;
  thinking?: { enabled?: boolean; budget_tokens?: number };
  onSelect: (model: ModelInfo) => void;
  onDismiss?: () => void;
}

export const AffordableModelOffer = ({
  enabled,
  models,
  selectedModelId,
  credits,
  inputTokens,
  selectedMaxTokens,
  thinking,
  onSelect,
  onDismiss = () => {},
}: AffordableModelOfferProps) => {
  const offer = useMemo(
    () =>
      enabled
        ? findAffordableModelOffer(models, selectedModelId, credits, inputTokens, selectedMaxTokens, thinking)
        : null,
    [enabled, models, selectedModelId, credits, inputTokens, selectedMaxTokens, thinking]
  );
  if (!offer) return null;

  return (
    <ComposerNote
      data-testid="affordable-model-offer"
      dismissTestId="affordable-model-dismiss"
      dismissLabel="Dismiss affordable model offer"
      onDismiss={onDismiss}
    >
      <Typography level="title-sm">Try a lower-cost model</Typography>
      <Typography level="body-sm">
        Based on recent context and your draft, {offer.current.modelName} may need about{' '}
        {offer.current.creditsPerAnswer.toLocaleString('en-US')} credits up front. {offer.affordable.name} is estimated
        at {offer.affordableCredits.toLocaleString('en-US')} and will become your active model. Actual credits depend on
        your next message, attachments and tools.
      </Typography>
      <Box sx={{ mt: 1 }}>
        <Button size="sm" data-testid="affordable-model-use-btn" onClick={() => onSelect(offer.affordable)}>
          Switch to {offer.affordable.name}
        </Button>
      </Box>
    </ComposerNote>
  );
};
