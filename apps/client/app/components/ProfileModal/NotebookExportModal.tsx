import React, { useState } from 'react';
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
  Typography,
  Alert,
  LinearProgress,
  Box,
  Select,
  Option,
} from '@mui/joy';
import { CloudDownload } from '@mui/icons-material';
import { toast } from 'sonner';
import { ContextHelpButton } from '@client/app/components/help';
import { api } from '@client/app/contexts/ApiContext';
import {
  notebooksToExcel,
  notebooksToDocx,
  notebooksToMarkdown,
  downloadBlob,
  BulkExportData,
} from '@client/app/utils/bulkNotebookExport';

type ExportFormat = 'json' | 'excel' | 'word' | 'markdown';

interface NotebookExportModalProps {
  open: boolean;
  onClose: () => void;
}

interface ExportOptions {
  includeKnowledge: boolean;
  includeArtifacts: boolean;
  includeTools: boolean;
  includeAgents: boolean;
  anonymize: boolean;
  includeMetadata: boolean;
  includeImages: boolean;
  maxFileSize: number;
  fromDate?: string;
  toDate?: string;
  format: ExportFormat;
}

const NotebookExportModal: React.FC<NotebookExportModalProps> = ({ open, onClose }) => {
  const [options, setOptions] = useState<ExportOptions>({
    includeKnowledge: true,
    includeArtifacts: true,
    includeTools: true,
    includeAgents: true,
    anonymize: false,
    includeMetadata: true,
    includeImages: true,
    maxFileSize: 10 * 1024 * 1024, // 10MB
    format: 'json',
  });

  const [isExporting, setIsExporting] = useState(false);
  const [exportResult, setExportResult] = useState<any>(null);

  const handleExport = async () => {
    try {
      setIsExporting(true);
      setExportResult(null);

      const response = await api.post('/api/notebooks/export', options);

      if (response.data.success) {
        setExportResult(response.data.data);
        toast.success('Notebooks exported successfully!');
      } else {
        throw new Error(response.data.message || 'Export failed');
      }
    } catch (error: any) {
      console.error('Export error:', error);
      toast.error(error.message || 'Failed to export notebooks');
    } finally {
      setIsExporting(false);
    }
  };

  const [isConverting, setIsConverting] = useState(false);

  const handleDownload = async () => {
    if (!exportResult?.downloadUrl) return;

    if (options.format === 'json') {
      // Direct download for JSON
      window.open(exportResult.downloadUrl, '_blank');
      return;
    }

    // For other formats, fetch JSON and convert client-side
    try {
      setIsConverting(true);
      toast.info(`Converting to ${options.format.toUpperCase()} format...`);

      const response = await fetch(exportResult.downloadUrl);
      if (!response.ok) throw new Error('Failed to fetch export data');
      const data: BulkExportData = await response.json();

      const dateStr = new Date().toISOString().split('T')[0];
      const baseFilename = `notebooks-export-${dateStr}`;

      switch (options.format) {
        case 'excel': {
          const blob = await notebooksToExcel(data);
          downloadBlob(blob, `${baseFilename}.xlsx`);
          toast.success('Excel file downloaded!');
          break;
        }
        case 'word': {
          const blob = await notebooksToDocx(data);
          downloadBlob(blob, `${baseFilename}.docx`);
          toast.success('Word document downloaded!');
          break;
        }
        case 'markdown': {
          const markdown = notebooksToMarkdown(data);
          const blob = new Blob([markdown], { type: 'text/markdown' });
          downloadBlob(blob, `${baseFilename}.md`);
          toast.success('Markdown file downloaded!');
          break;
        }
      }
    } catch (error) {
      console.error('Conversion error:', error);
      toast.error('Failed to convert export data');
    } finally {
      setIsConverting(false);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const updateOption = (key: keyof ExportOptions, value: any) => {
    setOptions(prev => ({ ...prev, [key]: value }));
  };

  return (
    <Modal open={open} onClose={onClose} className="notebook-export-modal-root">
      <ModalDialog size="md" sx={{ maxWidth: 600 }} className="notebook-export-modal-dialog">
        <DialogTitle className="notebook-export-modal-title">
          <Box display="flex" alignItems="center" gap={1}>
            <CloudDownload sx={{ mr: 1 }} />
            Export Notebooks
            <ContextHelpButton helpId="features/notebook-export-import" tooltipText="Learn about Export & Import" />
          </Box>
        </DialogTitle>

        <DialogContent className="notebook-export-modal-content">
          <Stack spacing={3} className="notebook-export-modal-main-stack">
            <Typography level="body-sm" color="neutral" className="notebook-export-modal-description">
              Export your notebooks and chat sessions in a portable format. This allows you to backup your data or move
              it between environments.
            </Typography>

            {/* Content Options */}
            <Stack spacing={2} className="notebook-export-modal-section">
              <Typography level="title-sm" className="notebook-export-modal-section-title">
                Content to Include
              </Typography>

              <Stack spacing={1} className="notebook-export-modal-options">
                <FormControl
                  orientation="horizontal"
                  sx={{ justifyContent: 'space-between' }}
                  className="notebook-export-modal-form-control"
                >
                  <FormLabel className="notebook-export-modal-form-label">Knowledge Files</FormLabel>
                  <Switch
                    className="notebook-export-modal-switch"
                    checked={options.includeKnowledge}
                    onChange={e => updateOption('includeKnowledge', e.target.checked)}
                  />
                </FormControl>

                <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
                  <FormLabel>Artifacts</FormLabel>
                  <Switch
                    checked={options.includeArtifacts}
                    onChange={e => updateOption('includeArtifacts', e.target.checked)}
                  />
                </FormControl>

                <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
                  <FormLabel>Tools</FormLabel>
                  <Switch
                    checked={options.includeTools}
                    onChange={e => updateOption('includeTools', e.target.checked)}
                  />
                </FormControl>

                <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
                  <FormLabel>Agents</FormLabel>
                  <Switch
                    checked={options.includeAgents}
                    onChange={e => updateOption('includeAgents', e.target.checked)}
                  />
                </FormControl>

                <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
                  <FormLabel>Images</FormLabel>
                  <Switch
                    checked={options.includeImages}
                    onChange={e => updateOption('includeImages', e.target.checked)}
                  />
                </FormControl>
              </Stack>
            </Stack>

            {/* Privacy Options */}
            <Stack spacing={2}>
              <Typography level="title-sm">Privacy & Metadata</Typography>

              <Stack spacing={1}>
                <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
                  <FormLabel>Include Usage Metadata</FormLabel>
                  <Switch
                    checked={options.includeMetadata}
                    onChange={e => updateOption('includeMetadata', e.target.checked)}
                  />
                </FormControl>

                <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
                  <FormLabel>Anonymize Export</FormLabel>
                  <Switch checked={options.anonymize} onChange={e => updateOption('anonymize', e.target.checked)} />
                </FormControl>
              </Stack>
            </Stack>

            {/* Export Format */}
            <FormControl>
              <FormLabel>Export Format</FormLabel>
              <Select
                value={options.format}
                onChange={(_, value) => value && updateOption('format', value)}
                className="notebook-export-modal-format-select"
              >
                <Option value="json">JSON (Full Data)</Option>
                <Option value="excel">Excel (.xlsx)</Option>
                <Option value="word">Word (.docx)</Option>
                <Option value="markdown">Markdown (.md)</Option>
              </Select>
              <Typography level="body-xs" color="neutral">
                {options.format === 'json' && 'Complete export with all metadata - best for backup and import'}
                {options.format === 'excel' && 'Spreadsheet format with separate sheets for notebooks and messages'}
                {options.format === 'word' && 'Document format with formatted conversations'}
                {options.format === 'markdown' && 'Plain text format suitable for viewing and sharing'}
              </Typography>
            </FormControl>

            {/* File Size Limit */}
            <FormControl>
              <FormLabel>Maximum File Size for Embedding</FormLabel>
              <Input
                className="notebook-export-modal-input"
                type="number"
                value={Math.round(options.maxFileSize / (1024 * 1024))}
                onChange={e => updateOption('maxFileSize', parseInt(e.target.value) * 1024 * 1024)}
                endDecorator="MB"
                slotProps={{
                  input: {
                    min: 1,
                    max: 100,
                  },
                }}
              />
              <Typography level="body-xs" color="neutral" className="notebook-export-modal-hint">
                Files larger than this will be referenced by URL instead of embedded in the export
              </Typography>
            </FormControl>

            {/* Date Range */}
            <Stack spacing={2}>
              <Typography level="title-sm">Date Range (Optional)</Typography>
              <Stack direction="row" spacing={2} className="notebook-export-modal-row">
                <FormControl sx={{ flex: 1 }} className="notebook-export-modal-form-control">
                  <FormLabel>From Date</FormLabel>
                  <Input
                    type="date"
                    value={options.fromDate || ''}
                    onChange={e => updateOption('fromDate', e.target.value || undefined)}
                  />
                </FormControl>
                <FormControl sx={{ flex: 1 }}>
                  <FormLabel>To Date</FormLabel>
                  <Input
                    type="date"
                    value={options.toDate || ''}
                    onChange={e => updateOption('toDate', e.target.value || undefined)}
                  />
                </FormControl>
              </Stack>
            </Stack>

            {/* Progress */}
            {isExporting && (
              <Stack spacing={1}>
                <Typography level="body-sm">Exporting notebooks...</Typography>
                <LinearProgress className="notebook-export-modal-progress" />
              </Stack>
            )}

            {/* Export Result */}
            {exportResult && (
              <Alert color="success" className="notebook-export-modal-alert">
                <Stack spacing={1}>
                  <Typography level="title-sm">Export Complete!</Typography>
                  <Stack spacing={0.5}>
                    <Typography level="body-sm">
                      Exported {exportResult.notebookCount} notebooks with {exportResult.messageCount} messages
                    </Typography>
                    <Typography level="body-sm">File size: {formatFileSize(exportResult.fileSize)}</Typography>
                    <Typography level="body-sm">Attachments: {exportResult.attachmentCount}</Typography>
                  </Stack>
                  {exportResult.downloadUrl && (
                    <Button
                      className="notebook-export-modal-export-button"
                      size="sm"
                      startDecorator={!isConverting ? <CloudDownload /> : undefined}
                      onClick={handleDownload}
                      loading={isConverting}
                      disabled={isConverting}
                    >
                      {isConverting ? 'Converting...' : 'Download Export File'}
                    </Button>
                  )}
                </Stack>
              </Alert>
            )}
          </Stack>
        </DialogContent>

        <DialogActions className="notebook-export-modal-actions">
          <Button variant="plain" onClick={onClose} className="notebook-export-modal-close-button">
            Close
          </Button>
          <Button
            variant="solid"
            color="primary"
            onClick={handleExport}
            loading={isExporting}
            disabled={isExporting}
            startDecorator={!isExporting ? <CloudDownload /> : undefined}
          >
            {isExporting ? 'Exporting...' : 'Export Notebooks'}
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
};

export default NotebookExportModal;
