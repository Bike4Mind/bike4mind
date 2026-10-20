import { useMemo } from 'react';
import { Box, Button, Typography } from '@mui/joy';
import type { ModelInfo } from '@bike4mind/common';
import { findAffordableModelOffer } from '@client/app/utils/creditEstimate';
import { ComposerNote } from './ComposerNote';

interface AffordableModelOfferProps {
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
    () => findAffordableModelOffer(models, selectedModelId, credits, inputTokens, selectedMaxTokens, thinking),
    [models, selectedModelId, credits, inputTokens, selectedMaxTokens, thinking]
  );
  if (!offer) return null;

  return (
    <ComposerNote
      data-testid="affordable-model-offer"
      dismissTestId="affordable-model-dismiss"
      dismissLabel="Dismiss affordable model offer"
      onDismiss={onDismiss}
    >
      <Typography level="title-sm">This model needs more credits for the next answer</Typography>
      <Typography level="body-sm">
        {offer.current.modelName} needs about {offer.current.creditsPerAnswer.toLocaleString('en-US')} credits up front.{' '}
        {offer.affordable.name} needs about {offer.affordableCredits.toLocaleString('en-US')} and will become your
        active model.
      </Typography>
      <Box sx={{ mt: 1 }}>
        <Button size="sm" data-testid="affordable-model-use-btn" onClick={() => onSelect(offer.affordable)}>
          Switch to {offer.affordable.name}
        </Button>
      </Box>
    </ComposerNote>
  );
};
