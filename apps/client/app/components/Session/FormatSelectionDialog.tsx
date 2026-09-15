// Dialog for selecting file format when auto-converting pasted content
import React, { useState, useEffect } from 'react';
import {
  Modal,
  ModalDialog,
  ModalClose,
  Typography,
  Button,
  Stack,
  FormControl,
  FormLabel,
  Select,
  Option,
  Input,
  Box,
  Divider,
} from '@mui/joy';
import { SupportedFabFileMimeTypes } from '@bike4mind/common';
import {
  COMMON_FILE_FORMATS,
  detectFileFormatWithConfidence,
  detectTopFormats,
  updateFileNameExtension,
  type FileFormatOption,
} from '@client/app/utils/fileFormatUtils';
import CodeIcon from '@mui/icons-material/Code';
import DescriptionIcon from '@mui/icons-material/Description';

interface FormatSelectionDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (format: SupportedFabFileMimeTypes, fileName: string) => void;
  content: string;
  defaultFileName: string;
}

export const FormatSelectionDialog: React.FC<FormatSelectionDialogProps> = ({
  open,
  onClose,
  onConfirm,
  content,
  defaultFileName,
}) => {
  const detectionResult = detectFileFormatWithConfidence(content);
  const [selectedFormat, setSelectedFormat] = useState<FileFormatOption>(detectionResult.format);
  const [fileName, setFileName] = useState<string>(defaultFileName);
  const [detectionInfo, setDetectionInfo] = useState(detectionResult);
  const [topDetections, setTopDetections] = useState(() => detectTopFormats(content, 3));

  // Update filename extension when format changes
  useEffect(() => {
    if (selectedFormat) {
      setFileName(prev => updateFileNameExtension(prev, selectedFormat.mimeType));
    }
  }, [selectedFormat]);

  // Reset when dialog opens
  useEffect(() => {
    if (open) {
      const result = detectFileFormatWithConfidence(content);
      setSelectedFormat(result.format);
      setDetectionInfo(result);
      setTopDetections(detectTopFormats(content, 3));
      setFileName(updateFileNameExtension(defaultFileName, result.format.mimeType));
    }
  }, [open, content, defaultFileName]);

  const handleConfirm = () => {
    onConfirm(selectedFormat.mimeType, fileName);
    onClose();
  };

  const handleCancel = () => {
    onClose();
  };

  return (
    <Modal open={open} onClose={handleCancel}>
      <ModalDialog
        sx={{
          minWidth: { xs: '90%', sm: '500px' },
          maxWidth: '600px',
        }}
      >
        <ModalClose />
        <Typography level="h4" startDecorator={<CodeIcon />}>
          Select File Format
        </Typography>

        <Divider sx={{ my: 2 }} />

        <Typography level="body-sm" sx={{ mb: 2 }}>
          Your pasted content will be saved as a knowledge file. Choose the format for better syntax highlighting and
          processing.
        </Typography>

        {/* Detection Confidence Display */}
        <Box sx={{ mb: 3, p: 2, bgcolor: 'background.level1', borderRadius: 'sm' }}>
          <Typography level="body-sm" sx={{ mb: 1, fontWeight: 'md' }}>
            Auto-detected Format
          </Typography>
          <Typography level="body-sm" sx={{ color: 'text.secondary', mb: 1 }}>
            {detectionInfo.format.label} ({Math.round(detectionInfo.confidence * 100)}% confidence)
          </Typography>
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
            {detectionInfo.reason}
          </Typography>
          {topDetections?.length > 1 && (
            <Box sx={{ mt: 1.5 }}>
              <Typography level="body-xs" sx={{ color: 'text.secondary', mb: 0.5 }}>
                Other likely formats:
              </Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                {topDetections.slice(1).map(item => (
                  <Box
                    key={item.format.mimeType}
                    sx={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 0.75,
                      px: 0.75,
                      py: 0.25,
                      borderRadius: 'sm',
                      bgcolor: 'background.level2',
                      cursor: 'pointer',
                    }}
                    onClick={() => setSelectedFormat(item.format)}
                  >
                    <Typography level="body-xs">{item.format.label}</Typography>
                    <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                      {Math.round(item.confidence * 100)}%
                    </Typography>
                  </Box>
                ))}
              </Box>
            </Box>
          )}
        </Box>

        <Stack spacing={2}>
          {/* Format Selection */}
          <FormControl>
            <FormLabel>File Format</FormLabel>
            <Select
              value={selectedFormat.mimeType}
              onChange={(_, newValue) => {
                const format = COMMON_FILE_FORMATS.find(f => f.mimeType === newValue);
                if (format) setSelectedFormat(format);
              }}
              renderValue={option => {
                if (!option) return null;
                const format = COMMON_FILE_FORMATS.find(f => f.mimeType === option.value);
                return format?.label || option.value;
              }}
              slotProps={{
                listbox: {
                  sx: {
                    maxHeight: '300px',
                    overflow: 'auto',
                  },
                },
              }}
            >
              {COMMON_FILE_FORMATS.map(format => (
                <Option key={format.mimeType} value={format.mimeType}>
                  <Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Typography level="body-md">{format.label}</Typography>
                      {format.mimeType === detectionInfo.format.mimeType && (
                        <Typography
                          level="body-xs"
                          sx={{
                            color: 'success.500',
                            fontWeight: 'md',
                            bgcolor: 'success.50',
                            px: 1,
                            py: 0.25,
                            borderRadius: 'sm',
                          }}
                        >
                          Auto-detected ({Math.round(detectionInfo.confidence * 100)}%)
                        </Typography>
                      )}
                    </Box>
                    {format.description && (
                      <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                        {format.description}
                      </Typography>
                    )}
                  </Box>
                </Option>
              ))}
            </Select>
            {selectedFormat.mimeType !== detectionInfo.format.mimeType && (
              <Typography level="body-xs" sx={{ mt: 0.5, color: 'warning.500' }}>
                ⚠️ Different from auto-detected format ({detectionInfo.format.label})
              </Typography>
            )}
          </FormControl>

          {/* File Name */}
          <FormControl>
            <FormLabel>File Name</FormLabel>
            <Input
              value={fileName}
              onChange={e => setFileName(e.target.value)}
              placeholder="Enter filename..."
              startDecorator={<DescriptionIcon />}
            />
          </FormControl>

          {/* Preview Info */}
          <Box
            sx={{
              p: 2,
              borderRadius: 'sm',
              bgcolor: 'background.level2',
            }}
          >
            <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
              <strong>Content preview:</strong> {content.substring(0, 100)}
              {content.length > 100 && '...'}
            </Typography>
            <Typography level="body-xs" sx={{ color: 'text.secondary', mt: 0.5 }}>
              <strong>Lines:</strong> {content.split('\n').length}
            </Typography>
          </Box>
        </Stack>

        <Divider sx={{ my: 2 }} />

        {/* Action Buttons */}
        <Stack direction="row" spacing={2} justifyContent="flex-end">
          <Button variant="plain" color="neutral" onClick={handleCancel}>
            Cancel
          </Button>
          <Button variant="solid" color="primary" onClick={handleConfirm}>
            Save as {selectedFormat.label}
          </Button>
        </Stack>
      </ModalDialog>
    </Modal>
  );
};
