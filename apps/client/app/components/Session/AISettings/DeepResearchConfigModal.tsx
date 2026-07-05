import React, { useState, useEffect } from 'react';
import { Modal, ModalDialog, Typography, Box, Input, Button, Slider, FormControl, FormLabel } from '@mui/joy';
import { Settings as SettingsIcon } from '@mui/icons-material';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useShallow } from 'zustand/react/shallow';

interface DeepResearchConfigModalProps {
  open: boolean;
  onClose: () => void;
}

const DeepResearchConfigModal: React.FC<DeepResearchConfigModalProps> = ({ open, onClose }) => {
  const { deepResearchConfig, setLLM } = useLLM(
    useShallow(s => ({ deepResearchConfig: s.deepResearchConfig, setLLM: s.setLLM }))
  );

  // Local state for form values
  const [duration, setDuration] = useState(deepResearchConfig?.duration ?? 4.5);
  const [maxDepth, setMaxDepth] = useState(deepResearchConfig?.maxDepth ?? 7);

  // Sync with context when modal opens
  useEffect(() => {
    if (open) {
      setDuration(deepResearchConfig?.duration ?? 4.5);
      setMaxDepth(deepResearchConfig?.maxDepth ?? 7);
    }
  }, [open, deepResearchConfig]);

  const handleSave = () => {
    setLLM({
      deepResearchConfig: {
        duration,
        maxDepth,
      },
    });
    onClose();
  };

  const handleReset = () => {
    setDuration(4.5);
    setMaxDepth(7);
    setLLM({
      deepResearchConfig: {
        duration: 4.5,
        maxDepth: 7,
      },
    });
  };

  return (
    <Modal
      open={open}
      onClose={(event, reason) => {
        // Prevent closing on backdrop click during initial render
        if (reason === 'backdropClick') {
          return;
        }
        onClose();
      }}
      sx={{
        zIndex: 1500, // Higher than the dropdown (dropdown z-index is typically 1300)
      }}
    >
      <ModalDialog
        sx={{
          maxWidth: 500,
          borderRadius: 'md',
          p: 3,
          boxShadow: 'lg',
        }}
        onClick={e => e.stopPropagation()}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
          <SettingsIcon sx={{ fontSize: '1.5rem', color: 'primary.500' }} />
          <Typography level="h4">Deep Research Configuration</Typography>
        </Box>

        <Typography level="body-sm" sx={{ mb: 3, color: 'text.secondary' }}>
          Configure the behavior of the deep research tool. These settings control how thorough and time-intensive the
          research process will be.
        </Typography>

        {/* Duration Configuration */}
        <FormControl sx={{ mb: 3 }}>
          <FormLabel>
            <Typography level="body-sm" fontWeight="600">
              Research Duration (minutes)
            </Typography>
          </FormLabel>
          <Typography level="body-xs" sx={{ mb: 1, color: 'text.secondary' }}>
            Maximum time allowed for the research process
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Slider
              value={duration}
              onChange={(_, value) => setDuration(value as number)}
              min={1}
              max={10}
              step={0.5}
              marks={[
                { value: 1, label: '1' },
                { value: 5, label: '5' },
                { value: 10, label: '10' },
              ]}
              valueLabelDisplay="auto"
              sx={{ flex: 1 }}
            />
            <Input
              type="number"
              value={duration}
              onChange={e => {
                const val = parseFloat(e.target.value);
                if (val >= 1 && val <= 10) {
                  setDuration(val);
                }
              }}
              slotProps={{
                input: {
                  min: 1,
                  max: 10,
                  step: 0.5,
                },
              }}
              sx={{ width: 100 }}
              endDecorator={<Typography level="body-sm">min</Typography>}
            />
          </Box>
        </FormControl>

        {/* Max Depth Configuration */}
        <FormControl sx={{ mb: 3 }}>
          <FormLabel>
            <Typography level="body-sm" fontWeight="600">
              Maximum Search Depth
            </Typography>
          </FormLabel>
          <Typography level="body-xs" sx={{ mb: 1, color: 'text.secondary' }}>
            Number of iterative research cycles to perform
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Slider
              value={maxDepth}
              onChange={(_, value) => setMaxDepth(value as number)}
              min={1}
              max={10}
              step={1}
              marks={[
                { value: 1, label: '1' },
                { value: 5, label: '5' },
                { value: 10, label: '10' },
              ]}
              valueLabelDisplay="auto"
              sx={{ flex: 1 }}
            />
            <Input
              type="number"
              value={maxDepth}
              onChange={e => {
                const val = parseInt(e.target.value);
                if (val >= 1 && val <= 10) {
                  setMaxDepth(val);
                }
              }}
              slotProps={{
                input: {
                  min: 1,
                  max: 10,
                  step: 1,
                },
              }}
              sx={{ width: 100 }}
              endDecorator={<Typography level="body-sm">cycles</Typography>}
            />
          </Box>
        </FormControl>

        {/* Info Box */}
        <Box
          sx={{
            p: 2,
            mb: 3,
            borderRadius: 'sm',
            backgroundColor: 'background.level2',
            border: '1px solid',
            borderColor: 'divider',
          }}
        >
          <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
            <strong>Note:</strong> Higher values will result in more comprehensive research but may take longer and
            consume more credits. The research will automatically stop when sufficient information is gathered or time
            limit is reached.
          </Typography>
        </Box>

        {/* Action Buttons */}
        <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
          <Button variant="plain" color="neutral" onClick={handleReset}>
            Reset to Defaults
          </Button>
          <Button variant="outlined" color="neutral" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" color="primary" onClick={handleSave}>
            Save Configuration
          </Button>
        </Box>
      </ModalDialog>
    </Modal>
  );
};

export default DeepResearchConfigModal;
