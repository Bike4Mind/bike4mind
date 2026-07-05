import { useState, useCallback } from 'react';
import { FormState } from '../../types/agentForm';
import { DEFAULT_FORM_STATE } from '../../constants/agentForm';

/**
 * Core form state management hook
 */
export const useFormState = (initialState?: Partial<FormState>) => {
  const [formState, setFormState] = useState<FormState>({
    ...DEFAULT_FORM_STATE,
    ...initialState,
  });

  const updateFormState = useCallback((updates: Partial<FormState>) => {
    setFormState(prev => ({ ...prev, ...updates }));
  }, []);

  const resetFormState = useCallback(() => {
    setFormState(DEFAULT_FORM_STATE);
  }, []);

  return {
    formState,
    setFormState,
    updateFormState,
    resetFormState,
  };
};
