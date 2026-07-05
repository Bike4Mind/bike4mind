import { useState, useCallback } from 'react';
import { FormState } from '../../types/agentForm';
import { applyImportedDataToNewAgent, validateImportedJSON } from '../../utils/agentFormUtils';
import { toast } from 'sonner';

export const useAgentImportExport = (updateFormState: (updates: Partial<FormState>) => void) => {
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importJsonText, setImportJsonText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [isProcessingImport, setIsProcessingImport] = useState(false);

  const handleImportOpen = useCallback(() => {
    setIsImportModalOpen(true);
    setImportJsonText('');
    setImportError(null);
  }, []);

  const handleImportClose = useCallback(() => {
    setIsImportModalOpen(false);
    setImportJsonText('');
    setImportError(null);
  }, []);

  const handleImportProcess = useCallback(async () => {
    if (!importJsonText.trim()) {
      setImportError('Please paste JSON data to import');
      return;
    }

    setIsProcessingImport(true);
    setImportError(null);

    try {
      const validation = validateImportedJSON(importJsonText);

      if (!validation.isValid) {
        setImportError(validation.error || 'Invalid JSON format');
        return;
      }

      updateFormState(applyImportedDataToNewAgent({} as FormState, validation.data!));

      setIsImportModalOpen(false);
      setImportJsonText('');

      toast.success('🎯 Agent template imported successfully!');
    } catch (error) {
      console.error('Import process error:', error);
      setImportError('Failed to process imported data');
    } finally {
      setIsProcessingImport(false);
    }
  }, [importJsonText, updateFormState]);

  return {
    isImportModalOpen,
    importJsonText,
    setImportJsonText,
    importError,
    setImportError,
    isProcessingImport,
    handleImportOpen,
    handleImportClose,
    handleImportProcess,
  };
};
