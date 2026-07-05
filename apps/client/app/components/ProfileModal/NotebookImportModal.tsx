import React, { useState, useRef } from 'react';
import {
  Modal,
  ModalDialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Stack,
  FormControl,
  FormLabel,
  Switch,
  Input,
  Select,
  Option,
  Typography,
  Alert,
  LinearProgress,
  Textarea,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  Link,
  Box,
} from '@mui/joy';
import { CloudUpload, Upload, DataObject, History } from '@mui/icons-material';
import { toast } from 'sonner';
import { ContextHelpButton } from '@client/app/components/help';
import { api } from '@client/app/contexts/ApiContext';

interface NotebookImportModalProps {
  open: boolean;
  onClose: () => void;
  onImport: (data: any, options: ImportOptions) => Promise<void>;
  onShowHistory?: () => void;
}

interface ImportOptions {
  conflictResolution: 'skip' | 'overwrite' | 'rename' | 'merge';
  preserveIds: boolean;
  importKnowledge: boolean;
  importArtifacts: boolean;
  importTools: boolean;
  importAgents: boolean;
  namePrefix?: string;
}

const NotebookImportModal: React.FC<NotebookImportModalProps> = ({ open, onClose, onImport, onShowHistory }) => {
  const [importMethod, setImportMethod] = useState<'file' | 'json'>('file');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [jsonData, setJsonData] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [options, setOptions] = useState<ImportOptions>({
    conflictResolution: 'rename',
    preserveIds: false,
    importKnowledge: true,
    importArtifacts: true,
    importTools: true,
    importAgents: true,
  });

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (!file.name.endsWith('.json')) {
        toast.error('Please select a JSON file');
        return;
      }
      setSelectedFile(file);
    }
  };

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) {
      if (!file.name.endsWith('.json')) {
        toast.error('Please drop a JSON file');
        return;
      }
      setSelectedFile(file);
    }
  };

  const handleImport = async () => {
    try {
      setIsImporting(true);

      // Get presigned URL from API with options
      const response = await api.post('/api/notebooks/import', options);

      if (!response.data.success) {
        throw new Error(response.data.message || 'Failed to get upload URL');
      }

      const { uploadUrl, importId } = response.data;

      let content: ArrayBuffer;
      let contentType = 'application/json';

      if (importMethod === 'file') {
        if (!selectedFile) {
          toast.error('Please select a file to import');
          return;
        }
        content = await selectedFile.arrayBuffer();
        contentType = selectedFile.type || 'application/json';
      } else {
        // JSON data method
        if (!jsonData.trim()) {
          toast.error('Please paste JSON data to import');
          return;
        }

        try {
          JSON.parse(jsonData);
        } catch (error) {
          toast.error('Invalid JSON format');
          return;
        }

        const encoder = new TextEncoder();
        content = encoder.encode(jsonData).buffer;
      }

      // Upload directly to S3 using XMLHttpRequest for progress tracking
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();

        xhr.upload.addEventListener('progress', event => {
          if (event.lengthComputable) {
            const percentComplete = Math.round((event.loaded / event.total) * 100);
            setUploadProgress(percentComplete);
          }
        });

        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            setUploadProgress(100);
            resolve();
          } else {
            reject(new Error('Failed to upload file to storage'));
          }
        });

        xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
        xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));

        xhr.open('PUT', uploadUrl);
        xhr.setRequestHeader('Content-Type', contentType);
        xhr.send(content);
      });

      toast.success('🚀 Import started! You will receive a notification when it is complete.', {
        description: `Import ID: ${importId}`,
        duration: 5000,
      });

      setTimeout(() => {
        onClose();
        resetForm();
      }, 1500);
    } catch (error: any) {
      console.error('Import error:', error);
      toast.error(error.message || 'Failed to import notebooks');
    } finally {
      setIsImporting(false);
      setUploadProgress(0);
    }
  };

  const updateOption = (key: keyof ImportOptions, value: any) => {
    setOptions(prev => ({ ...prev, [key]: value }));
  };

  const resetForm = () => {
    setSelectedFile(null);
    setJsonData('');
    setUploadProgress(0);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <Modal open={open} onClose={onClose} className="notebook-import-modal-root">
      <ModalDialog size="md" sx={{ maxWidth: 700 }} className="notebook-import-modal-dialog">
        <DialogTitle className="notebook-import-modal-title">
          <Box display="flex" alignItems="center" gap={1}>
            <CloudUpload sx={{ mr: 1 }} />
            Import Notebooks
            <ContextHelpButton helpId="features/notebook-export-import" tooltipText="Learn about Export & Import" />
          </Box>
        </DialogTitle>

        <DialogContent className="notebook-import-modal-content">
          <Stack className="notebook-import-modal-main-stack" spacing={3}>
            <Typography level="body-sm" color="neutral" className="notebook-import-modal-description">
              Import notebooks and chat sessions from a previous export. This allows you to restore backups or migrate
              data between environments.
            </Typography>

            {/* Import Method Tabs */}
            <Tabs
              value={importMethod}
              onChange={(e, value) => setImportMethod(value as 'file' | 'json')}
              className="notebook-import-modal-tabs"
            >
              <TabList className="notebook-import-modal-tab-list">
                <Tab value="file" className="notebook-import-modal-tab">
                  <Upload sx={{ mr: 1 }} />
                  File Upload
                </Tab>
                <Tab value="json" className="notebook-import-modal-tab">
                  <DataObject sx={{ mr: 1 }} />
                  JSON Data
                </Tab>
              </TabList>

              <TabPanel value="file" className="notebook-import-modal-tab-panel">
                <Stack spacing={2}>
                  <FormControl className="notebook-import-modal-form-control">
                    <FormLabel className="notebook-import-modal-form-label">Select Export File</FormLabel>
                    <Stack
                      sx={{
                        border: '2px dashed',
                        borderColor: selectedFile ? 'success.main' : 'neutral.outlinedBorder',
                        borderRadius: 'md',
                        p: 3,
                        textAlign: 'center',
                        cursor: 'pointer',
                        '&:hover': {
                          borderColor: 'primary.main',
                          bgcolor: 'background.level1',
                        },
                      }}
                      onDragOver={handleDragOver}
                      onDrop={handleDrop}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <input
                        className="notebook-import-modal-file-input"
                        ref={fileInputRef}
                        type="file"
                        accept=".json"
                        style={{ display: 'none' }}
                        onChange={handleFileSelect}
                      />
                      {selectedFile ? (
                        <Stack spacing={1}>
                          <Typography color="success" level="title-sm">
                            ✓ {selectedFile.name}
                          </Typography>
                          <Typography level="body-sm" color="neutral">
                            {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                          </Typography>
                        </Stack>
                      ) : (
                        <Stack spacing={1}>
                          <Upload sx={{ fontSize: 32, color: 'neutral.400' }} />
                          <Typography level="title-sm">Drop a JSON export file here or click to browse</Typography>
                          <Typography level="body-xs" color="neutral">
                            Only .json files are supported
                          </Typography>
                        </Stack>
                      )}
                    </Stack>
                  </FormControl>
                </Stack>
              </TabPanel>

              <TabPanel value="json" className="notebook-import-modal-tab-panel">
                <FormControl>
                  <FormLabel>JSON Data</FormLabel>
                  <Textarea
                    className="notebook-import-modal-textarea"
                    minRows={8}
                    maxRows={12}
                    placeholder="Paste your exported notebook JSON data here..."
                    value={jsonData}
                    onChange={e => setJsonData(e.target.value)}
                    sx={{ fontFamily: 'monospace', fontSize: 'sm' }}
                  />
                  <Typography level="body-xs" color="neutral">
                    Paste the content of your exported notebooks JSON file
                  </Typography>
                </FormControl>
              </TabPanel>
            </Tabs>

            {/* Import Options */}
            <Stack spacing={2}>
              <Typography level="title-sm">Import Options</Typography>

              <FormControl>
                <FormLabel>Conflict Resolution</FormLabel>
                <Select
                  className="notebook-import-modal-select"
                  value={options.conflictResolution}
                  onChange={(e, value) => updateOption('conflictResolution', value)}
                >
                  <Option value="skip" className="notebook-import-modal-option">
                    Skip existing notebooks
                  </Option>
                  <Option value="rename">Rename duplicates</Option>
                  <Option value="overwrite">Overwrite existing</Option>
                  <Option value="merge">Merge chat history</Option>
                </Select>
                <Typography level="body-xs" color="neutral">
                  How to handle notebooks with names that already exist
                </Typography>
              </FormControl>

              <Stack spacing={1}>
                <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
                  <FormLabel>Preserve Original IDs</FormLabel>
                  <Switch
                    className="notebook-import-modal-switch"
                    checked={options.preserveIds}
                    onChange={e => updateOption('preserveIds', e.target.checked)}
                  />
                </FormControl>
                <Typography level="body-xs" color="neutral">
                  Keep original IDs for same-platform imports (useful for developers)
                </Typography>
              </Stack>

              <FormControl>
                <FormLabel>Name Prefix (Optional)</FormLabel>
                <Input
                  className="notebook-import-modal-input"
                  placeholder="e.g., 'Imported - '"
                  value={options.namePrefix || ''}
                  onChange={e => updateOption('namePrefix', e.target.value || undefined)}
                />
                <Typography level="body-xs" color="neutral">
                  Add a prefix to all imported notebook names
                </Typography>
              </FormControl>
            </Stack>

            {/* Content Options */}
            <Stack spacing={2}>
              <Typography level="title-sm">Content to Import</Typography>

              <Stack spacing={1}>
                <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
                  <FormLabel>Knowledge Files</FormLabel>
                  <Switch
                    checked={options.importKnowledge}
                    onChange={e => updateOption('importKnowledge', e.target.checked)}
                  />
                </FormControl>

                <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
                  <FormLabel>Artifacts</FormLabel>
                  <Switch
                    checked={options.importArtifacts}
                    onChange={e => updateOption('importArtifacts', e.target.checked)}
                  />
                </FormControl>

                <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
                  <FormLabel>Tools</FormLabel>
                  <Switch checked={options.importTools} onChange={e => updateOption('importTools', e.target.checked)} />
                </FormControl>

                <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
                  <FormLabel>Agents</FormLabel>
                  <Switch
                    checked={options.importAgents}
                    onChange={e => updateOption('importAgents', e.target.checked)}
                  />
                </FormControl>
              </Stack>
            </Stack>

            {/* Progress */}
            {isImporting && (
              <Stack spacing={1}>
                <Typography level="body-sm">
                  {uploadProgress < 100 ? `Uploading... ${uploadProgress}%` : 'Processing import...'}
                </Typography>
                <LinearProgress
                  className="notebook-import-modal-progress"
                  determinate={uploadProgress > 0}
                  value={uploadProgress}
                />
              </Stack>
            )}

            {/* Import Note */}
            <Alert color="primary" variant="soft" className="notebook-import-modal-alert">
              <Typography level="body-sm">
                📌 <strong>Note:</strong> Import processing happens in the background. You will receive a notification
                in your inbox when the import is complete. Large imports may take a few minutes.
              </Typography>
            </Alert>
          </Stack>
        </DialogContent>

        <DialogActions className="notebook-import-modal-actions">
          <Stack
            direction="row"
            spacing={2}
            sx={{ width: '100%', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <Box>
              {onShowHistory && (
                <Link
                  component="button"
                  onClick={onShowHistory}
                  startDecorator={<History />}
                  level="body-sm"
                  data-testid="view-notebook-import-history-link"
                >
                  View Import History
                </Link>
              )}
            </Box>
            <Stack direction="row" spacing={2}>
              <Button variant="plain" onClick={onClose} className="notebook-import-modal-close-button">
                Close
              </Button>
              <Button
                variant="outlined"
                onClick={resetForm}
                disabled={isImporting}
                className="notebook-import-modal-reset-button"
              >
                Reset
              </Button>
              <Button
                variant="solid"
                color="primary"
                onClick={handleImport}
                loading={isImporting}
                disabled={
                  isImporting ||
                  (!selectedFile && importMethod === 'file') ||
                  (!jsonData.trim() && importMethod === 'json')
                }
                startDecorator={!isImporting ? <CloudUpload /> : undefined}
              >
                {isImporting ? 'Importing...' : 'Import Notebooks'}
              </Button>
            </Stack>
          </Stack>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
};

export default NotebookImportModal;
