import { useState } from 'react';
import { Alert, Button, Typography } from '@mui/joy';
import { useShallow } from 'zustand/react/shallow';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { computeDefaultMaxTokens } from '@client/app/utils/aiSettingsUtils';

export interface LowOutputBudget {
  /** The max_tokens the turn was sent with. */
  requested: number;
  /** The default for the model that ran it (computeDefaultMaxTokens). */
  modelDefault: number;
}

/**
 * The low-budget explanation for a reply that hit the output limit before producing any text,
 * or null when the request's budget was not below the model's default. Below it, the likely
 * cause is the user's saved "Max output tokens" setting rather than the request, and "ask for
 * less" (the generic advice) cannot fix that.
 */
export function getLowOutputBudget(
  requested: number | undefined,
  modelDefault: number | undefined
): LowOutputBudget | null {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) return null;
  if (typeof modelDefault !== 'number' || !Number.isFinite(modelDefault) || requested >= modelDefault) return null;
  return { requested, modelDefault };
}

/** getLowOutputBudget for a stored turn, reading the model's default from the live catalog. */
export function useLowOutputBudget(modelId: string | undefined, requested: number | undefined): LowOutputBudget | null {
  const { data: models } = useModelInfo();
  const info = modelId ? models?.find(m => m.id === modelId) : undefined;
  return getLowOutputBudget(requested, info ? computeDefaultMaxTokens(info) : undefined);
}

const fmt = (n: number) => n.toLocaleString('en-US');

/**
 * Replaces the generic empty-reply notice when the turn's budget was below the model's default,
 * with a one-click raise of the saved setting. Raised to the default of the model now selected,
 * not the one that ran the turn, since that is what the next send uses.
 */
export function LowOutputBudgetBanner({ requested, modelDefault }: LowOutputBudget) {
  const [model, maxTokens, setLLM] = useLLM(useShallow(s => [s.model, s.max_tokens, s.setLLM]));
  const { data: models } = useModelInfo();
  const activeInfo = models?.find(m => m.id === model);
  const target = activeInfo ? computeDefaultMaxTokens(activeInfo) : modelDefault;
  const [raised, setRaised] = useState(false);

  return (
    <Alert
      data-testid="reply-low-output-budget-warning"
      color="warning"
      variant="soft"
      sx={{ my: 1, flexDirection: 'column', alignItems: 'flex-start', gap: 0.5 }}
    >
      <Typography level="title-sm">⚠️ Response was cut off</Typography>
      <Typography level="body-sm">
        Your Max output tokens setting ({fmt(requested)}) is too low for this model&apos;s reasoning, which can use the
        whole budget before any reply is written. This model&apos;s default is {fmt(modelDefault)}.
      </Typography>
      {raised ? (
        <Typography level="body-sm" data-testid="reply-low-output-budget-raised">
          Max output tokens is now {fmt(target)}. Send the request again.
        </Typography>
      ) : (
        maxTokens < target && (
          <Button
            data-testid="reply-low-output-budget-raise-button"
            size="sm"
            variant="solid"
            color="warning"
            onClick={() => {
              setLLM({ max_tokens: target });
              setRaised(true);
            }}
          >
            Raise to default
          </Button>
        )
      )}
    </Alert>
  );
}
