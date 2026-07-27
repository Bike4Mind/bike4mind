import { FC, useMemo, useState } from 'react';

import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import Snackbar from '@mui/joy/Snackbar';
import Typography from '@mui/joy/Typography';
import { Close } from '@mui/icons-material';

import type { ModelName } from '@bike4mind/common';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useModelInfo, useSupersededModels } from '@client/app/hooks/data/useModelInfo';
import { computeDefaultMaxTokens } from '@client/app/utils/aiSettingsUtils';
import { FIXED_TEMPERATURE_MODELS } from '@bike4mind/common';
import { updateSessionToServer } from '@client/app/utils/sessionsAPICalls';
import { dismissStaleModelPrompt, isStaleModelPromptDismissed } from '@client/app/utils/staleModelPrompt';

interface StaleModelPromptProps {
  sessionId: string | null | undefined;
  /** The session's pinned model, i.e. `session.lastUsedModel`. */
  pinnedModel: string | null | undefined;
}

/**
 * A notebook keeps whatever model was current when it was last touched, so reopening an
 * old one silently resumes on a stale pin (#951). The pin is never rewritten on the
 * user's behalf - holding an old model can be deliberate - but it is not silently
 * honored either: this offers the replacement in one click and remembers a decline.
 */
const StaleModelPrompt: FC<StaleModelPromptProps> = ({ sessionId, pinnedModel }) => {
  const { data: supersededModels } = useSupersededModels();
  const { data: modelInfoRepo } = useModelInfo();
  const { setState: setLLM } = useLLM;
  // Keyed rather than boolean so answering the prompt in one notebook doesn't suppress
  // it in the next one opened without a remount.
  const [handledKey, setHandledKey] = useState<string | null>(null);

  const superseded = useMemo(() => {
    if (!sessionId || !pinnedModel) return undefined;
    if (isStaleModelPromptDismissed(sessionId, pinnedModel)) return undefined;
    return supersededModels?.find(m => m.id === pinnedModel);
  }, [supersededModels, sessionId, pinnedModel]);

  if (!superseded || !sessionId) return null;

  const promptKey = `${sessionId}::${superseded.id}`;
  if (handledKey === promptKey) return null;

  const handleDismiss = () => {
    dismissStaleModelPrompt(sessionId, superseded.id);
    setHandledKey(promptKey);
  };

  const handleSwitch = () => {
    const replacement = modelInfoRepo?.find(m => m.id === superseded.replacementId);
    if (!replacement) return;
    const newModel = replacement.id as ModelName;
    setLLM({
      model: newModel,
      max_tokens: computeDefaultMaxTokens(replacement),
      ...(FIXED_TEMPERATURE_MODELS.has(newModel) && { temperature: 1.0 }),
    });
    void updateSessionToServer({ id: sessionId, lastUsedModel: newModel }).catch(err =>
      console.error('Failed to persist model upgrade:', err)
    );
    setHandledKey(promptKey);
  };

  return (
    <Snackbar
      open
      // No autoHideDuration: this asks a question, and a prompt that vanishes mid-read
      // reproduces the silence it exists to fix.
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      variant="soft"
      color="warning"
      data-testid="stale-model-prompt"
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <Typography level="body-sm">
          This notebook is set to <strong>{superseded.name}</strong>. Switch to {superseded.replacementName}?
        </Typography>
        <Button size="sm" variant="solid" color="warning" onClick={handleSwitch} data-testid="stale-model-switch-btn">
          Switch
        </Button>
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          onClick={handleDismiss}
          aria-label="Keep this model"
          data-testid="stale-model-dismiss-btn"
        >
          <Close fontSize="small" />
        </IconButton>
      </Box>
    </Snackbar>
  );
};

export default StaleModelPrompt;
