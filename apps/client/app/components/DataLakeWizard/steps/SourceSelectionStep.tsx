import { Box, Button, CircularProgress, Stack, Tooltip, Typography } from '@mui/joy';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import CloudIcon from '@mui/icons-material/Cloud';
import { useTheme } from '@mui/joy/styles';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { readDroppedItems } from '@client/app/utils/dropReader';

const supportsWebkitDirectory =
  typeof HTMLInputElement !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype;

export default function SourceSelectionStep() {
  const theme = useTheme();
  const setFiles = useDataLakeWizardStore(s => s.setFiles);
  const setStep = useDataLakeWizardStore(s => s.setStep);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const dragCounter = useRef(0);

  // Set webkitdirectory attribute imperatively (non-standard, no JSX type)
  useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute('webkitdirectory', '');
      folderInputRef.current.setAttribute('directory', '');
    }
  }, []);

  const handleFilesSelected = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      setFiles(files);
      setStep('preview');
    },
    [setFiles, setStep]
  );

  const handleFileInputChange = useCallback(
    (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      handleFilesSelected(Array.from(fileList));
    },
    [handleFilesSelected]
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current = 0;
      setIsDragging(false);

      // Use webkitGetAsEntry to traverse directories
      if (e.dataTransfer.items?.length) {
        setIsScanning(true);
        try {
          const files = await readDroppedItems(e.dataTransfer.items);
          handleFilesSelected(files);
        } finally {
          setIsScanning(false);
        }
      } else {
        // Fallback for browsers without items API
        handleFilesSelected(Array.from(e.dataTransfer.files));
      }
    },
    [handleFilesSelected]
  );

  return (
    <Box data-testid="wizard-source-step" sx={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3, p: 3 }}>
      {/* Drag-drop zone */}
      <Box
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        sx={{
          flex: 1,
          minHeight: 280,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
          border: '2px dashed',
          borderColor: isDragging ? 'primary.500' : 'divider',
          borderRadius: 'lg',
          bgcolor: isDragging ? (theme.palette.mode === 'dark' ? 'primary.900' : 'primary.50') : 'transparent',
          transition: 'all 0.2s',
          cursor: 'pointer',
        }}
        onClick={() => !isScanning && folderInputRef.current?.click()}
      >
        {isScanning ? (
          <>
            <CircularProgress size="lg" />
            <Typography level="title-lg" textAlign="center">
              Scanning folder contents&hellip;
            </Typography>
            <Typography level="body-sm" color="neutral" textAlign="center">
              Reading all files in the dropped folder
            </Typography>
          </>
        ) : (
          <>
            <CloudUploadIcon sx={{ fontSize: 56, color: isDragging ? 'primary.500' : 'neutral.400' }} />
            <Typography level="title-lg" textAlign="center">
              Drop a folder here
            </Typography>
            <Typography level="body-sm" color="neutral" textAlign="center">
              Or use the buttons below to select files
            </Typography>
          </>
        )}
      </Box>

      {/* Action buttons */}
      <Stack direction="row" gap={2} justifyContent="center" flexWrap="wrap">
        {supportsWebkitDirectory ? (
          <Button
            data-testid="wizard-upload-folder-btn"
            variant="solid"
            color="primary"
            startDecorator={<CloudUploadIcon />}
            onClick={() => folderInputRef.current?.click()}
          >
            Upload Folder
          </Button>
        ) : (
          <Tooltip title="Folder upload is not supported in this browser. Please use Chrome, Edge, or Safari.">
            <span>
              <Button variant="solid" color="primary" startDecorator={<CloudUploadIcon />} disabled>
                Upload Folder
              </Button>
            </span>
          </Tooltip>
        )}

        <Button
          data-testid="wizard-select-files-btn"
          variant="outlined"
          color="neutral"
          startDecorator={<InsertDriveFileIcon />}
          onClick={() => fileInputRef.current?.click()}
        >
          Select Files
        </Button>

        <Tooltip title="Coming soon">
          <span>
            <Button variant="outlined" color="neutral" startDecorator={<CloudIcon />} disabled>
              Connect Google Drive
            </Button>
          </span>
        </Tooltip>
      </Stack>

      {/* Hidden file inputs */}
      <input
        ref={folderInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={e => handleFileInputChange(e.target.files)}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={e => handleFileInputChange(e.target.files)}
      />
    </Box>
  );
}
