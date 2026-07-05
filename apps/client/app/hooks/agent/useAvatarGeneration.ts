import { useState, useCallback } from 'react';
import { generateAgentAvatar } from '@client/app/utils/agentsAPICalls';
import { toast } from 'sonner';
import { useLLM } from '@client/app/contexts/LLMContext';

interface UseAvatarGenerationProps {
  agentId?: string;
  onAvatarGenerated?: (portraitUrl: string, generationPrompt: string) => void;
}

export const useAvatarGeneration = ({ agentId, onAvatarGenerated }: UseAvatarGenerationProps) => {
  const [isGeneratingAvatar, setIsGeneratingAvatar] = useState(false);
  const imageModelFromContext = useLLM(state => state.imageModel);
  // Use imageModel only if it's a non-empty string, otherwise let backend use operations model
  const imageModel = imageModelFromContext?.trim() ? imageModelFromContext : undefined;

  const generateAvatar = useCallback(async () => {
    if (!agentId) {
      toast.error('Agent ID is required for avatar generation');
      return;
    }

    setIsGeneratingAvatar(true);
    try {
      toast.info('🎨 Generating epic avatar from personality... This may take a moment! ⏳');

      const result = await generateAgentAvatar(agentId, imageModel);

      if (onAvatarGenerated) {
        onAvatarGenerated(result.portraitUrl, result.generationPrompt);
      }

      toast.success('🔥 Epic avatar generated with PERSONALITY and AGENCY! ✨');

      return result;
    } catch (error) {
      console.error('Avatar generation failed:', error);

      // Extract error message from response if available
      let errorMessage = 'Failed to generate avatar. Please try again.';
      if (error && typeof error === 'object' && 'response' in error) {
        const response = (error as any).response;
        if (response?.data?.error) {
          errorMessage = response.data.error;
        }
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }

      toast.error(errorMessage);
      throw error;
    } finally {
      setIsGeneratingAvatar(false);
    }
  }, [agentId, imageModel, onAvatarGenerated]);

  return {
    generateAvatar,
    isGeneratingAvatar,
  };
};
