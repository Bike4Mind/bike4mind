import { useState, useRef } from 'react';
import { Tooltip, IconButton, CircularProgress } from '@mui/joy';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import { useTranslation } from 'react-i18next';
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';

interface RephraseButtonProps {
  currentText: string;
  onRephrase: (rephrasedText: string) => void;
  disabled?: boolean;
  onSuccess?: () => void;
}

export const RephraseButton: React.FC<RephraseButtonProps> = ({
  currentText,
  onRephrase,
  disabled = false,
  onSuccess,
}) => {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const toastIdsRef = useRef<{ success?: string | number; error?: string | number }>({});

  const handleRephrase = async () => {
    if (!currentText.trim() || isLoading) return;

    // Hide tooltip during operation and dismiss any open toasts
    setTooltipOpen(false);

    // Dismiss specific toasts if they exist
    if (toastIdsRef.current.success) {
      toast.dismiss(toastIdsRef.current.success);
    }
    if (toastIdsRef.current.error) {
      toast.dismiss(toastIdsRef.current.error);
    }

    setIsLoading(true);

    try {
      const response = await api.post('/api/ai/optimize-input', {
        text: currentText,
        style: 'optimized', // Can be configurable later
        maxLength: Math.min(currentText.length * 2, 1000), // Prevent excessive length
      });

      if (response.data?.optimizedText) {
        onRephrase(response.data.optimizedText);
        const successId = toast.success(t('session.inputOptimized', 'Input optimized'), {
          id: 'rephrase-success',
          closeButton: true,
          duration: 2500,
        });
        toastIdsRef.current.success = successId;
        if (onSuccess) onSuccess();
      }
    } catch (error) {
      console.error('Failed to optimize input:', error);
      const errorId = toast.error(t('session.optimizeFailed', 'Failed to optimize input'), {
        id: 'rephrase-error',
        closeButton: true,
        duration: 3000,
      });
      toastIdsRef.current.error = errorId;
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Tooltip
      title={t('session.optimizeInput', 'Optimize prompt')}
      placement="top"
      open={tooltipOpen}
      onOpen={() => setTooltipOpen(true)}
      onClose={() => setTooltipOpen(false)}
    >
      <IconButton
        size="sm"
        variant="outlined"
        onClick={handleRephrase}
        disabled={disabled || !currentText.trim() || isLoading}
        sx={{
          width: '32px',
          height: '32px',
          borderRadius: '6px',
        }}
      >
        {isLoading ? <CircularProgress size="sm" /> : <AutoAwesomeOutlinedIcon sx={{ fontSize: 16 }} />}
      </IconButton>
    </Tooltip>
  );
};

export default RephraseButton;
