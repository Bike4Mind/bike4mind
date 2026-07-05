import { FC, useState, useRef, useEffect } from 'react';
import OptimizeHistoryScriptModal from './OptimizeHistoryScriptModal';
import {
  Modal,
  ModalDialog,
  Button,
  Tooltip,
  Input,
  Typography,
  Stack,
  IconButton,
  Box,
  Switch,
  LinearProgress,
  Link,
  Alert,
} from '@mui/joy';
import FileUploadOutlinedIcon from '@mui/icons-material/FileUploadOutlined';
import CloseIcon from '@mui/icons-material/Close';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { FieldTooltip } from '@client/app/components/help';
import ContentPasteIcon from '@mui/icons-material/ContentPaste';
import HistoryIcon from '@mui/icons-material/History';
import WarningIcon from '@mui/icons-material/Warning';
import { toast } from 'sonner';
import { ContextHelpButton } from '@client/app/components/help';

enum ImportSource {
  OPENAI = 'OpenAI',
  CLAUDE = 'Claude',
}

interface IUploadImportHistoryModalProps {
  open: boolean;
  onClose: () => void;
  onUpload: (source: ImportSource, file: File) => Promise<void>;
  onUrlGiven: (source: ImportSource, url: string) => Promise<void>;
  uploadProgress?: number;
  onShowHistory?: () => void;
}

const UploadImportHistoryModal: FC<IUploadImportHistoryModalProps> = ({
  open,
  onClose,
  onUpload,
  onUrlGiven,
  uploadProgress = 0,
  onShowHistory,
}) => {
  const [url, setUrl] = useState<string>('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [source, setSource] = useState<ImportSource>(ImportSource.OPENAI);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileButtonRef = useRef<HTMLButtonElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const modalDescriptionId = 'modal-description';
  const urlErrorId = 'url-error';
  const [showScriptModal, setShowScriptModal] = useState(false);
  // setSubmitting alone can't stop a second click fired before React commits the
  // re-render - this ref is checked synchronously so a rapid double-click can't
  // slip both calls past the disabled/loading button state.
  const submittingRef = useRef(false);

  const resetFileInput = () => {
    setFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const resetUrlInput = () => {
    setUrl('');
    setUrlError(null);
  };

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      const droppedFile = files[0];
      if (droppedFile.name.endsWith('.zip')) {
        setFile(droppedFile);
        resetUrlInput();
      } else {
        toast.error('Please upload a .zip file');
      }
    }
  };

  useEffect(() => {
    if (!open) {
      resetFileInput();
      resetUrlInput();
      fileButtonRef.current?.focus();
    }
  }, [open]);

  const onSubmit = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      if (url) {
        await onUrlGiven(source, url);
      } else if (file) {
        await onUpload(source, file);
      }
      onClose();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  const focusNextElement = (
    currentRef: React.RefObject<HTMLElement | null>,
    nextRef: React.RefObject<HTMLElement | null>
  ) => {
    if (currentRef.current === document.activeElement) {
      nextRef.current?.focus();
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0] ?? null;
    setFile(selectedFile);
    resetUrlInput();
  };

  const handleFileButtonClick = () => {
    fileInputRef.current?.click();
  };

  const validateUrl = (input: string): ImportSource | null => {
    const openaiUrlPattern =
      /^https:\/\/proddatamgmtqueue\.blob\.core\.windows\.net\/exportcontainer\/[a-f0-9]+-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.zip\?/;
    const claudeUrlPattern = /^https:\/\/url[0-9]*\.mail\.anthropic\.com\/ls\/click\?upn=.*/;
    if (openaiUrlPattern.test(input)) return ImportSource.OPENAI;
    if (claudeUrlPattern.test(input)) return ImportSource.CLAUDE;
    return null;
  };

  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newUrl = e.target.value;
    setUrl(newUrl);
    setFile(null);
    const newSource = newUrl && validateUrl(newUrl);
    if (newSource) {
      setSource(newSource);
      setUrlError(null);
    } else {
      setUrlError('Invalid import URL format');
    }
  };

  const handleSourceSwitchChange = () => {
    setSource(source === 'OpenAI' ? ImportSource.CLAUDE : ImportSource.OPENAI);
  };

  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const newUrl = text.trim();
      setUrl(newUrl);
      const newSource = newUrl && validateUrl(newUrl);
      if (!newSource) {
        setUrlError('Invalid import URL format');
      } else {
        setSource(newSource);
        setUrlError(null);
      }
      setFile(null);
    } catch (err) {
      console.error('Failed to read clipboard contents: ', err);
      toast.error(`Failed to read clipboard contents: ${String(err)}`);
    }
  };

  const isSubmitDisabled = (!file && (!url || !!urlError)) || submitting;

  return (
    <>
      <Modal
        className="import-history-modal"
        open={open}
        onClose={onClose}
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-labelledby="modal-title"
        aria-describedby={modalDescriptionId}
      >
        <ModalDialog className="import-history-modal-dialog">
          <Box display="flex" alignItems="center" gap={1}>
            <Typography className="import-history-modal-title" id="modal-title" level="h2" mb={2}>
              Upload LLM History
            </Typography>
            <ContextHelpButton helpId="features/chat-history-import" tooltipText="Learn about Chat History Import" />
          </Box>
          <Typography className="import-history-modal-description" id={modalDescriptionId} sx={{ mb: 2 }}>
            Choose a file or provide a URL to upload your exported LLM history.
          </Typography>
          {source === 'OpenAI' && (
            <Alert
              className="import-history-warning"
              variant="soft"
              color="warning"
              startDecorator={<WarningIcon />}
              sx={{ mb: 2 }}
            >
              <Stack spacing={1}>
                <Typography level="title-sm">Large File Warning</Typography>
                <Typography level="body-sm">
                  OpenAI exports with voice conversations can be very large (1+ GB) and may crash your browser. We only
                  need the text data for import.
                </Typography>
                <Button
                  variant="soft"
                  color="primary"
                  size="sm"
                  onClick={() => setShowScriptModal(true)}
                  sx={{ alignSelf: 'flex-start', fontWeight: 'bold' }}
                >
                  Get our free optimization tool (reduces file size by ~95%)
                </Button>
              </Stack>
            </Alert>
          )}
          <Stack spacing={2}>
            <Typography
              className="import-history-source-switch-label"
              component="label"
              startDecorator={ImportSource.OPENAI}
              endDecorator={ImportSource.CLAUDE}
              sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <Switch
                className="import-history-source-switch"
                checked={source === 'Claude'}
                onChange={handleSourceSwitchChange}
              />
            </Typography>
            <Input
              className="import-history-file-input"
              sx={{ display: 'none' }}
              slotProps={{
                input: {
                  ref: fileInputRef,
                  type: 'file',
                  accept: '.zip',
                  onChange: handleFileChange,
                },
              }}
            />
            <Box
              className="import-history-drop-zone"
              ref={dropZoneRef}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              sx={{
                border: '2px dashed',
                borderColor: isDragging ? 'primary.main' : 'neutral.outlinedBorder',
                borderRadius: 'sm',
                p: 2,
                textAlign: 'center',
                transition: 'border-color 0.3s, background-color 0.3s',
                '&:hover': {
                  bgcolor: 'action.hover',
                },
                bgcolor: isDragging ? 'action.hover' : 'background.surface',
              }}
            >
              <Button
                className="import-history-file-button"
                ref={fileButtonRef}
                onClick={handleFileButtonClick}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleFileButtonClick();
                  if (e.key === 'ArrowDown') focusNextElement(fileButtonRef, urlInputRef);
                }}
                startDecorator={<FileUploadOutlinedIcon />}
                variant="outlined"
                color="neutral"
                fullWidth
                aria-label={`Choose ${source} History File`}
              >
                {file ? file.name : `Choose or drag ${source} History File`}
              </Button>
              {!file && (
                <Typography className="import-history-drop-instructions" level="h4" mt={1}>
                  Drag and drop your .zip file here, or click to select
                </Typography>
              )}
            </Box>
            {file && (
              <Button
                className="import-history-clear-file-button"
                color="warning"
                onClick={resetFileInput}
                onKeyDown={e => {
                  if (e.key === 'ArrowDown') focusNextElement(fileButtonRef, urlInputRef);
                }}
                fullWidth
                aria-label={`Clear ${source} History File`}
              >
                Clear {source} History File
              </Button>
            )}
            <Stack className="import-history-url-section" direction="row" alignItems="center">
              <Typography className="import-history-url-label">
                Or, paste the URL that {source} sent in its email:
              </Typography>
              <Box sx={{ ml: 1, display: 'inline-flex' }}>
                <FieldTooltip
                  ariaLabel="URL format information"
                  content="The URL should start with https://... and end with .zip"
                  iconSize={16}
                />
              </Box>
            </Stack>
            <Input
              className="import-history-url-input"
              type="text"
              placeholder="https://..."
              value={url}
              onChange={handleUrlChange}
              onKeyDown={e => {
                if (e.key === 'ArrowUp') focusNextElement(urlInputRef, fileButtonRef);
                if (e.key === 'ArrowDown') focusNextElement(urlInputRef, submitButtonRef);
              }}
              ref={urlInputRef}
              disabled={!!file}
              error={!!urlError}
              startDecorator={url && !urlError && <CheckCircleOutlineIcon sx={{ color: 'green' }} />}
              endDecorator={
                <>
                  {url && (
                    <IconButton
                      className="import-history-clear-url-button"
                      onClick={resetUrlInput}
                      size="sm"
                      aria-label="Clear URL"
                    >
                      <CloseIcon />
                    </IconButton>
                  )}
                  <Tooltip title="Paste from clipboard">
                    <IconButton
                      className="import-history-paste-button"
                      onClick={handlePasteFromClipboard}
                      size="sm"
                      aria-label="Paste from clipboard"
                    >
                      <ContentPasteIcon />
                    </IconButton>
                  </Tooltip>
                </>
              }
              aria-describedby={urlError ? urlErrorId : undefined}
            />{' '}
            {urlError && (
              <Typography
                className="import-history-url-error"
                id={urlErrorId}
                color="danger"
                startDecorator={<ErrorOutlineIcon />}
                aria-live="polite"
              >
                {urlError}
              </Typography>
            )}
            {submitting && uploadProgress > 0 && (
              <Stack spacing={1}>
                <Typography level="body-sm">Uploading... {uploadProgress}%</Typography>
                <LinearProgress determinate value={uploadProgress} sx={{ width: '100%' }} />
              </Stack>
            )}
            <Button
              className="import-history-submit-button"
              ref={submitButtonRef}
              onClick={onSubmit}
              onKeyDown={e => {
                if (e.key === 'ArrowUp') focusNextElement(submitButtonRef, urlInputRef);
              }}
              disabled={isSubmitDisabled}
              color={isSubmitDisabled ? 'neutral' : 'primary'}
              fullWidth
              aria-label="Upload LLM History"
            >
              {submitting ? 'Uploading...' : 'Upload'}
            </Button>
            {onShowHistory && (
              <Box sx={{ textAlign: 'center', mt: 2 }}>
                <Link
                  component="button"
                  onClick={onShowHistory}
                  startDecorator={<HistoryIcon />}
                  level="body-sm"
                  data-testid="view-import-history-link"
                >
                  View Import History
                </Link>
              </Box>
            )}
          </Stack>
        </ModalDialog>
      </Modal>

      {/* Script Modal */}
      <OptimizeHistoryScriptModal open={showScriptModal} onClose={() => setShowScriptModal(false)} />
    </>
  );
};

export default UploadImportHistoryModal;
