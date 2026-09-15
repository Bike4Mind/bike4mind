import { useCallback } from 'react';
import { isTagExistInRecords } from '../../utils/agentUtils';
import { toast } from 'sonner';
import { validateTriggerWord } from '@bike4mind/common';

/**
 * Tag management hook (trigger words & behaviors)
 */
export const useTagManagement = () => {
  const addTriggerWord = useCallback(
    (
      newTriggerWord: string,
      currentTriggerWords: string[],
      onUpdate: (updates: { triggerWords: string[]; newTriggerWord: string }) => void
    ) => {
      if (!newTriggerWord) return;

      const triggerWord = newTriggerWord.startsWith('@') ? newTriggerWord : `@${newTriggerWord}`;

      // Reject anything the chat-side mention parser can't read - otherwise
      // the user gets a green chip but the agent never gets invoked. Mirrors
      // the server validator at `apps/client/server/utils/agentValidation.ts`.
      const validation = validateTriggerWord(triggerWord);
      if (!validation.ok) {
        toast.error(validation.error);
        return;
      }

      if (isTagExistInRecords(currentTriggerWords, triggerWord)) {
        toast.error('This trigger word has already been added');
        onUpdate({ triggerWords: currentTriggerWords, newTriggerWord: '' });
      } else {
        onUpdate({
          triggerWords: [...currentTriggerWords, triggerWord],
          newTriggerWord: '',
        });
      }
    },
    []
  );

  const removeTriggerWord = useCallback(
    (word: string, currentTriggerWords: string[], onUpdate: (updates: { triggerWords: string[] }) => void) => {
      onUpdate({
        triggerWords: currentTriggerWords.filter(w => w !== word),
      });
    },
    []
  );

  const addBehavior = useCallback(
    (
      newBehavior: string,
      currentBehaviors: string[],
      onUpdate: (updates: { specialBehaviors: string[]; newBehavior: string }) => void
    ) => {
      if (!newBehavior) return;

      if (isTagExistInRecords(currentBehaviors, newBehavior)) {
        toast.error('This special behavior has already been added');
        onUpdate({ specialBehaviors: currentBehaviors, newBehavior: '' });
      } else {
        onUpdate({
          specialBehaviors: [...currentBehaviors, newBehavior],
          newBehavior: '',
        });
      }
    },
    []
  );

  const removeBehavior = useCallback(
    (behavior: string, currentBehaviors: string[], onUpdate: (updates: { specialBehaviors: string[] }) => void) => {
      onUpdate({
        specialBehaviors: currentBehaviors.filter(b => b !== behavior),
      });
    },
    []
  );

  return {
    addTriggerWord,
    removeTriggerWord,
    addBehavior,
    removeBehavior,
  };
};
