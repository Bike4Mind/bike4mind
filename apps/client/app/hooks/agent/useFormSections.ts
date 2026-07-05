import { useCallback } from 'react';
import { AgentPersonality, AgentVisual, AgentCapabilities } from '../../types/agentForm';

/**
 * Form section update handlers hook
 */
export const useFormSections = (formState: any, updateFormState: (updates: any) => void) => {
  const updatePersonality = useCallback(
    (updates: Partial<AgentPersonality>) => {
      updateFormState({
        personality: { ...formState.personality, ...updates },
      });
    },
    [formState.personality, updateFormState]
  );

  const updateVisual = useCallback(
    (updates: Partial<AgentVisual>) => {
      updateFormState({
        visual: { ...formState.visual, ...updates },
      });
    },
    [formState.visual, updateFormState]
  );

  const updateCapabilities = useCallback(
    (updates: Partial<AgentCapabilities>) => {
      updateFormState({
        capabilities: { ...formState.capabilities, ...updates },
      });
    },
    [formState.capabilities, updateFormState]
  );

  return {
    updatePersonality,
    updateVisual,
    updateCapabilities,
  };
};
