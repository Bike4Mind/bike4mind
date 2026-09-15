import React, { useState, useRef } from 'react';
import {
  Modal,
  ModalDialog,
  ModalClose,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Textarea,
  Typography,
  Box,
  Chip,
  Divider,
  FormControl,
  FormLabel,
  Checkbox,
  CircularProgress,
  Alert,
} from '@mui/joy';
import { Edit3, AlertCircle } from 'lucide-react';
import { IFabFileDocument } from '@bike4mind/common';

interface EditFileDialogProps {
  open: boolean;
  onClose: () => void;
  file: IFabFileDocument | null;
  onSubmit: (instruction: string, options: EditOptions) => Promise<void>;
}

export interface EditOptions {
  preserveFormatting: boolean;
  returnDiff: boolean;
  applyImmediately: boolean;
}

const EditFileDialog: React.FC<EditFileDialogProps> = ({ open, onClose, file, onSubmit }) => {
  const [instruction, setInstruction] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<EditOptions>({
    preserveFormatting: true,
    returnDiff: true,
    applyImmediately: false,
  });
  // setIsSubmitting alone can't stop a second click fired before React commits the
  // re-render - this ref is checked synchronously so a rapid double-click can't
  // slip both calls past the disabled button state.
  const submittingRef = useRef(false);

  const suggestions = [
    'Fix grammar and spelling',
    'Make the tone more professional',
    'Add code comments',
    'Improve error handling',
    'Add type annotations',
    'Format with Prettier',
    'Convert to TypeScript',
    'Add JSDoc comments',
  ];

  const handleSubmit = async () => {
    if (submittingRef.current) return;
    if (!instruction.trim()) {
      setError('Please provide an instruction for the edit');
      return;
    }

    submittingRef.current = true;
    setIsSubmitting(true);
    setError(null);

    try {
      await onSubmit(instruction, options);
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate edit');
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setInstruction('');
    setError(null);
    setOptions({
      preserveFormatting: true,
      returnDiff: true,
      applyImmediately: false,
    });
    onClose();
  };

  const handleSuggestionClick = (suggestion: string) => {
    setInstruction(suggestion);
  };

  if (!file) return null;

  return (
    <Modal open={open} onClose={handleClose}>
      <ModalDialog size="lg" sx={{ width: '90%', maxWidth: 600 }}>
        <ModalClose />
        <DialogTitle>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Edit3 size={20} />
            Edit with AI - {file.fileName}
          </Box>
        </DialogTitle>

        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Alert color="warning" startDecorator={<AlertCircle size={16} />}>
              <Typography level="body-sm">
                Some browser extensions may interfere with AI file editing. If you experience issues, try disabling
                extensions or use an incognito window.
              </Typography>
            </Alert>

            <FormControl>
              <FormLabel>Describe the changes you want:</FormLabel>
              <Textarea
                placeholder="e.g., Make the tone more professional and add a section about contributing"
                value={instruction}
                onChange={e => setInstruction(e.target.value)}
                minRows={4}
                maxRows={8}
                sx={{ fontFamily: 'inherit' }}
                autoFocus
                data-testid="edit-file-dialog-instruction-input"
              />
            </FormControl>

            <Box>
              <Typography level="body-sm" sx={{ mb: 1 }}>
                Suggestions:
              </Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                {suggestions.map(suggestion => (
                  <Chip
                    key={suggestion}
                    size="sm"
                    variant="outlined"
                    onClick={() => handleSuggestionClick(suggestion)}
                    sx={{ cursor: 'pointer' }}
                  >
                    {suggestion}
                  </Chip>
                ))}
              </Box>
            </Box>

            <Divider />

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Typography level="body-sm">Options:</Typography>
              <Checkbox
                label="Preserve formatting style"
                checked={options.preserveFormatting}
                onChange={e => setOptions({ ...options, preserveFormatting: e.target.checked })}
              />
              <Checkbox
                label="Show diff preview"
                checked={options.returnDiff}
                onChange={e => setOptions({ ...options, returnDiff: e.target.checked })}
              />
              <Checkbox
                label="Apply immediately (skip preview)"
                checked={options.applyImmediately}
                onChange={e => setOptions({ ...options, applyImmediately: e.target.checked })}
                data-testid="edit-file-dialog-apply-immediately-checkbox"
              />
            </Box>

            {error && (
              <Alert color="danger" startDecorator={<AlertCircle size={16} />} sx={{ mt: 1 }}>
                {error}
              </Alert>
            )}
          </Box>
        </DialogContent>

        <DialogActions>
          <Button variant="plain" color="neutral" onClick={handleClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            variant="solid"
            color="primary"
            onClick={handleSubmit}
            disabled={isSubmitting || !instruction.trim()}
            startDecorator={isSubmitting ? <CircularProgress size="sm" /> : <Edit3 size={16} />}
            data-testid="edit-file-dialog-submit-btn"
          >
            {isSubmitting ? 'Generating...' : options.applyImmediately ? 'Apply Edit' : 'Preview Changes'}
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
};

export default EditFileDialog;
