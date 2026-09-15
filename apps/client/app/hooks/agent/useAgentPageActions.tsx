import React from 'react';
import { Button, Box, Tooltip } from '@mui/joy';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import AddIcon from '@mui/icons-material/Add';
import { useAgentGeneration } from './useAgentGeneration';
import { useAgentImportExport } from './useAgentImportExport';
import { FormState } from '../../types/agentForm';
import { AGENT_FORM_ID } from '../../constants/agentForm';
import { visuallyHidden } from '../../utils/a11yStyles';

const SUBMIT_REASON_ID = 'agent-form-submit-reason';

interface UseAgentPageActionsProps {
  formState: FormState;
  isSubmitting: boolean;
  updateFormState: (updates: Partial<FormState>) => void;
  updatePersonality: (updates: Partial<FormState['personality']>) => void;
  updateCapabilities: (updates: Partial<FormState['capabilities']>) => void;
}

export const useAgentPageActions = ({
  formState,
  isSubmitting,
  updateFormState,
  updatePersonality,
  updateCapabilities,
}: UseAgentPageActionsProps) => {
  const generation = useAgentGeneration(formState, updateFormState, updatePersonality, updateCapabilities);
  const importExport = useAgentImportExport(updateFormState);

  // Required fields are also enforced in doSubmit() - gate the button here so the requirement is
  // visible up front rather than only via an error toast on click.
  const missingRequirements: string[] = [];
  if (!formState.name?.trim()) missingRequirements.push('Agent Name');
  if (!formState.triggerWords?.length) missingRequirements.push('Trigger Words');
  const isCreateDisabled = missingRequirements.length > 0;
  const disabledReason = isCreateDisabled ? `Missing required: ${missingRequirements.join(', ')}` : '';

  const submitButton = (
    <Button
      data-testid="agent-form-submit"
      type="submit"
      form={AGENT_FORM_ID}
      aria-describedby={isCreateDisabled ? SUBMIT_REASON_ID : undefined}
      color="primary"
      variant="solid"
      size="md"
      sx={{
        borderRadius: '6px',
        px: 3,
        fontWeight: 600,
        fontSize: '14px',
        letterSpacing: '0.02em',
      }}
      startDecorator={<AddIcon sx={{ fontSize: '18px' }} />}
      loading={isSubmitting}
      disabled={isCreateDisabled}
    >
      Create Agent
    </Button>
  );

  const rightActions = (
    <>
      <Tooltip title="Auto-generate personality, capabilities, and system prompt" placement="bottom">
        <Button
          variant="plain"
          color={generation.isPersonalityRandomized ? 'success' : 'neutral'}
          size="sm"
          startDecorator={
            <AutoAwesomeIcon
              sx={{
                fontSize: '16px',
                color: generation.isPersonalityRandomized ? 'success.500' : 'text.tertiary',
              }}
            />
          }
          onClick={generation.handleRandomizePersonality}
          sx={{
            fontWeight: 400,
            color: generation.isPersonalityRandomized ? 'success.500' : 'text.tertiary',
            '&:hover': { backgroundColor: 'background.level1' },
          }}
        >
          {generation.isPersonalityRandomized ? 'Filled!' : 'Auto Fill'}
        </Button>
      </Tooltip>

      {isCreateDisabled && (
        <Box id={SUBMIT_REASON_ID} sx={visuallyHidden}>
          {disabledReason}
        </Box>
      )}
      {isCreateDisabled ? (
        <Tooltip title={disabledReason} placement="bottom">
          {/* span wrapper: MUI Joy disables pointer events on disabled buttons,
              which prevents the Tooltip from triggering on hover. */}
          <span>{submitButton}</span>
        </Tooltip>
      ) : (
        submitButton
      )}
    </>
  );

  return {
    rightActions,
    generation,
    importExport,
  };
};
