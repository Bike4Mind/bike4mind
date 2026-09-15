import { useState, useCallback, useRef, useEffect } from 'react';
import { generateEnhancedPersonality } from '../../utils/agentPersonalityGenerator';
import {
  generateDescriptionFromFormData,
  generateSystemPromptFromFormData,
  generateAgentName,
  deriveTriggerWords,
} from '../../utils/agentFormUtils';
import { FormState } from '../../types/agentForm';
import { toast } from 'sonner';
import { generateSystemPrompt, enhanceAgentField } from '../../utils/agentsAPICalls';

/**
 * Convert camelCase to human-readable format
 * e.g., "systemPrompt" -> "System Prompt"
 */
const camelCaseToHumanReadable = (str: string): string => {
  return str
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, match => match.toUpperCase())
    .trim();
};

export const useAgentGeneration = (
  formState: FormState,
  updateFormState: (updates: Partial<FormState>) => void,
  updatePersonality: (updates: any) => void,
  updateCapabilities: (updates: any) => void,
  agentId?: string
) => {
  const [shimmeringField, setShimmeringField] = useState<string | null>(null);
  const [isPersonalityRandomized, setIsPersonalityRandomized] = useState(false);
  const [isGeneratingDescription, setIsGeneratingDescription] = useState(false);
  const [isGeneratingSystemPrompt, setIsGeneratingSystemPrompt] = useState(false);

  // Mirror formState in a ref so the randomize/generate callbacks can read the latest values
  // without listing `formState` in their dependency arrays - otherwise the callbacks are
  // recreated on every keystroke, defeating memoization in the children they're passed to.
  const formStateRef = useRef(formState);
  useEffect(() => {
    formStateRef.current = formState;
  }, [formState]);

  const handleGenerateDescription = useCallback(async () => {
    setIsGeneratingDescription(true);
    setShimmeringField('description');

    try {
      const tempAgent = {
        name: formState.name || '',
        description: formState.description,
        triggerWords: formState.triggerWords,
        personality: formState.personality,
        capabilities: [
          {
            responseStyle: formState.capabilities.responseStyle,
            specialBehaviors: formState.capabilities.specialBehaviors,
          },
        ],
        visual: formState.visual,
        identity: {
          gender: 'prefer-not-to-say' as const,
          pronouns: {
            subject: '',
            object: '',
            possessive: '',
            possessiveAdjective: '',
            reflexive: '',
          },
          customPronouns: '',
        },
      };

      const generatedDescription = generateDescriptionFromFormData(tempAgent);

      updateFormState({
        description: generatedDescription,
      });
      toast.success('Description generated successfully!');

      // Clear the shimmer effect after animation completes
      setTimeout(() => {
        setShimmeringField(null);
      }, 800);
    } catch (error) {
      console.error('Error generating description:', error);
      toast.error('Failed to generate description. Please try again.');
      setShimmeringField(null);
    } finally {
      setIsGeneratingDescription(false);
    }
  }, [formState, updateFormState]);

  const handleRandomizePersonality = useCallback(() => {
    // Start shimmer effect for all personality fields
    setShimmeringField('all');

    // Generate new content after a brief delay to sync with animation
    setTimeout(() => {
      const randomPersonality = generateEnhancedPersonality('maximum');

      updatePersonality({
        majorMotivation: randomPersonality.majorMotivation,
        minorMotivation: randomPersonality.minorMotivation,
        flaw: randomPersonality.flaw,
        quirk: randomPersonality.quirk,
        description: randomPersonality.description,
        emotionalIntelligence: randomPersonality.emotionalIntelligence,
        communicationPattern: randomPersonality.communicationPattern,
        memoryStyle: randomPersonality.memoryStyle,
        culturalFlavor: randomPersonality.culturalFlavor,
        energyLevel: randomPersonality.energyLevel,
        humorStyle: randomPersonality.humorStyle,
        backstoryElement: randomPersonality.backstoryElement,
        problemSolvingApproach: randomPersonality.problemSolvingApproach,
        personalMission: randomPersonality.personalMission,
        activeProject: randomPersonality.activeProject,
        secretAmbition: randomPersonality.secretAmbition,
        coreValues: randomPersonality.coreValues,
        legacyAspiration: randomPersonality.legacyAspiration,
        growthChallenge: randomPersonality.growthChallenge,
        personalityComplexity: randomPersonality.personalityComplexity,
        generationTimestamp: randomPersonality.generationTimestamp,
        uniqueId: randomPersonality.uniqueId,
      });

      updateCapabilities({
        responseStyle: randomPersonality.responseStyle,
        specialBehaviors: randomPersonality.specialBehaviors,
      });

      // "Auto Fill" is the showcased "generate a complete agent" CTA, but it previously
      // only filled the (often-collapsed) personality fields - leaving name/description/trigger
      // words/system prompt empty and the Create button disabled, so it looked like nothing
      // happened. Also populate the visible top-level fields so the form is actually submittable.
      // Existing user-entered values are preserved.
      const current = formStateRef.current;
      const name = current.name?.trim() || generateAgentName();
      const tempAgent = {
        name,
        personality: randomPersonality,
        capabilities: {
          responseStyle: randomPersonality.responseStyle,
          specialBehaviors: randomPersonality.specialBehaviors,
        },
      };
      updateFormState({
        name,
        description: current.description?.trim() || generateDescriptionFromFormData(tempAgent),
        systemPrompt: current.systemPrompt?.trim() || generateSystemPromptFromFormData(tempAgent),
        triggerWords: current.triggerWords?.length ? current.triggerWords : deriveTriggerWords(name),
      });
    }, 150); // Delay content change to sync with shimmer peak

    setIsPersonalityRandomized(true);
    toast.success('🎲 New being with AGENCY generated! This agent now has missions and purpose! 🔥');

    // Clear the shimmer effect and indicator after animation completes
    setTimeout(() => {
      setShimmeringField(null);
      setIsPersonalityRandomized(false);
    }, 3000);
    // formState read via formStateRef so this callback stays referentially stable across keystrokes.
  }, [updatePersonality, updateCapabilities, updateFormState]);

  const handleRandomizeCapabilities = useCallback(() => {
    // Start shimmer effect for capabilities fields
    setShimmeringField('all');

    // Generate new content after a brief delay to sync with animation
    setTimeout(() => {
      const randomPersonality = generateEnhancedPersonality('maximum');

      updateCapabilities({
        responseStyle: randomPersonality.responseStyle,
        specialBehaviors: randomPersonality.specialBehaviors,
      });
    }, 150);

    toast.success('🎲 New capabilities generated!');

    // Clear the shimmer effect after animation completes
    setTimeout(() => {
      setShimmeringField(null);
    }, 1000);
  }, [updateCapabilities]);

  const handleGenerateSystemPrompt = useCallback(async () => {
    setIsGeneratingSystemPrompt(true);

    try {
      // Start shimmer effect for system prompt field
      setShimmeringField('systemPrompt');

      toast.info('🧠 Generating comprehensive system prompt from personality... This may take a moment! ⏳');

      let generatedPrompt = '';

      if (agentId) {
        const result = await generateSystemPrompt(agentId);

        if (result.success) {
          generatedPrompt = result.systemPrompt;
          updateFormState({ systemPrompt: generatedPrompt });
          toast.success('🔥 Epic system prompt generated with AGENCY and PURPOSE! ✨');
        } else {
          // Check for specific error about missing Agent Ops configuration
          if (result.message?.includes('No active meta-prompt') || result.message?.includes('administrator')) {
            toast.error(
              '⚙️ Agent Ops not configured! An admin needs to set up the meta-prompt in Admin > Agent Ops first.',
              { duration: 6000 }
            );
          } else {
            toast.error(result.message || 'Failed to generate system prompt');
          }
        }
      } else {
        // Client-side generation for create mode
        const tempAgent = {
          name: formState.name || '',
          description: formState.description,
          triggerWords: formState.triggerWords,
          personality: formState.personality,
          capabilities: [
            {
              responseStyle: formState.capabilities.responseStyle,
              specialBehaviors: formState.capabilities.specialBehaviors,
            },
          ],
          visual: formState.visual,
          identity: formState.identity,
        };

        generatedPrompt = generateSystemPromptFromFormData(tempAgent);
        updateFormState({ systemPrompt: generatedPrompt });
        toast.success('🎲 System prompt generated!');
      }

      // Clear the shimmer effect after animation completes
      setTimeout(() => {
        setShimmeringField(null);
      }, 800);
    } catch (error: any) {
      console.error('Error generating system prompt:', error);

      // Check if it's a 400 error with Agent Ops configuration issue
      if (error?.response?.status === 400 && error?.response?.data?.message) {
        const errorMessage = error.response.data.message;
        if (errorMessage.includes('No active meta-prompt') || errorMessage.includes('administrator')) {
          toast.error(
            '⚙️ Agent Ops not configured! An admin needs to set up the meta-prompt in Admin > Agent Ops first.',
            { duration: 6000 }
          );
        } else {
          toast.error(errorMessage);
        }
      } else {
        toast.error('Failed to generate system prompt. Please try again.');
      }

      setShimmeringField(null);
    } finally {
      setIsGeneratingSystemPrompt(false);
    }
  }, [formState, agentId, updateFormState]);

  const handleRandomizeField = useCallback(
    async (fieldName: string, currentValue?: string) => {
      // Start shimmer effect for specific field
      setShimmeringField(fieldName);

      // Check if there's existing content that should be used as context
      const hasExistingContent = currentValue && currentValue.trim().length > 0;

      if (hasExistingContent && agentId) {
        // Use AI enhancement with user's content as context
        try {
          toast.info(`✨ Enhancing ${camelCaseToHumanReadable(fieldName)} with your ideas...`);

          const result = await enhanceAgentField(agentId, fieldName, currentValue, formState.name);

          if (result.success) {
            updatePersonality({
              [fieldName]: result.enhancedValue,
            });
            toast.success(`✨ ${camelCaseToHumanReadable(fieldName)} enhanced!`);
          } else {
            // Clear shimmer immediately on failure
            setShimmeringField(null);
            toast.error(result.message || 'Failed to enhance field');
            // Fall back to random generation
            const randomPersonality = generateEnhancedPersonality('maximum');
            updatePersonality({
              [fieldName]: randomPersonality[fieldName as keyof typeof randomPersonality] || '',
            });
            return; // Exit early since we already cleared shimmer
          }
        } catch (error) {
          console.error('Error enhancing field:', error);
          // Clear shimmer immediately on error
          setShimmeringField(null);
          toast.error('Failed to enhance field. Generating random content instead.');
          // Fall back to random generation
          const randomPersonality = generateEnhancedPersonality('maximum');
          updatePersonality({
            [fieldName]: randomPersonality[fieldName as keyof typeof randomPersonality] || '',
          });
          return; // Exit early since we already cleared shimmer
        }
      } else {
        // No existing content - use random generation
        setTimeout(() => {
          const randomPersonality = generateEnhancedPersonality('maximum');

          updatePersonality({
            [fieldName]: randomPersonality[fieldName as keyof typeof randomPersonality] || '',
          });
        }, 150);

        toast.success(`🎲 ${camelCaseToHumanReadable(fieldName)} generated!`);
      }

      // Clear the shimmer effect after animation completes
      setTimeout(() => {
        setShimmeringField(null);
      }, 1000);
    },
    [updatePersonality, agentId, formState.name]
  );

  return {
    shimmeringField,
    setShimmeringField,
    isPersonalityRandomized,
    setIsPersonalityRandomized,
    isGeneratingDescription,
    isGeneratingSystemPrompt,
    handleGenerateDescription,
    handleRandomizePersonality,
    handleRandomizeCapabilities,
    handleGenerateSystemPrompt,
    handleRandomizeField,
  };
};
