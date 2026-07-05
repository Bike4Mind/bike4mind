import { useCallback } from 'react';
import { FormState } from '../../types/agentForm';
import { CREDIT_SOURCE } from '../../constants/agentForm';

/**
 * Form input handlers hook
 */
export const useFormHandlers = (formState: FormState, updateFormState: (updates: Partial<FormState>) => void) => {
  const handleInputChange = useCallback(
    (field: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) => {
      updateFormState({ [field]: e.target.value });
    },
    [updateFormState]
  );

  const handleNestedInputChange = useCallback(
    (section: 'personality' | 'visual' | 'capabilities', field: string) =>
      (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        updateFormState({
          [section]: {
            ...formState[section],
            [field]: e.target.value,
          },
        });
      },
    [formState, updateFormState]
  );

  const handleSquareSlideToggleChange = useCallback(
    (field: keyof FormState) => (e: { target: { checked: boolean } }) => {
      updateFormState({ [field]: e.target.checked });
    },
    [updateFormState]
  );

  const handleCreditSourceChange = useCallback(
    (value: string | null) => {
      if (value === CREDIT_SOURCE.USER || value === CREDIT_SOURCE.AGENT) {
        updateFormState({
          creditSource: value as any,
          useOwnCredits: value === CREDIT_SOURCE.AGENT,
        });
      }
    },
    [updateFormState]
  );

  const handleResponseStyleChange = useCallback(
    (value: string | null) => {
      if (value) {
        updateFormState({
          capabilities: {
            ...formState.capabilities,
            responseStyle: value as any,
          },
        });
      }
    },
    [formState.capabilities, updateFormState]
  );

  const handleProjectChange = useCallback(
    (value: string | null) => {
      if (value) {
        updateFormState({ projectId: value });
      }
    },
    [updateFormState]
  );

  const handleGenderIdentityChange = useCallback(
    (value: string) => {
      updateFormState({
        identity: {
          ...formState.identity,
          gender: value as any,
        },
      });
    },
    [formState.identity, updateFormState]
  );

  return {
    handleInputChange,
    handleNestedInputChange,
    handleSquareSlideToggleChange,
    handleCreditSourceChange,
    handleResponseStyleChange,
    handleProjectChange,
    handleGenderIdentityChange,
  };
};
