import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Box,
  Typography,
  Alert,
  CircularProgress,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  Stack,
  Button,
  Modal,
  ModalDialog,
  ModalClose,
  Divider,
  LinearProgress,
  useTheme,
} from '@mui/joy';
import { type PythonArtifact } from '@bike4mind/common';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import Editor from 'react-simple-code-editor';
import Prism from 'prismjs';
import 'prismjs/components/prism-python';
import {
  PlayArrow as RunIcon,
  Stop as StopIcon,
  Code as CodeIcon,
  Save as SaveIcon,
  Undo as UndoIcon,
  Lock as LockIcon,
  LockOpen as UnlockIcon,
  Warning as WarningIcon,
  Terminal as OutputIcon,
} from '@mui/icons-material';
import { ArtifactVersionDropdown } from '@client/app/components/artifacts';
import { toast } from 'react-hot-toast';
import { api } from '@client/app/contexts/ApiContext';
import {
  checkArtifactExists,
  saveArtifactToLocalStorage,
  saveArtifactVersionToLocalStorage,
  getArtifactVersionFromLocalStorage,
  clearOldCachedArtifacts,
} from '@client/app/utils/artifactPersistence';
import { setSelectedArtifactVersion } from '@client/app/hooks/useSessionLayout';
import { usePyodide } from '@client/app/hooks/usePyodide';

interface PythonArtifactViewerProps {
  artifact: PythonArtifact;
  onError?: (error: string) => void;
  onSave?: (updatedContent: string) => Promise<any>;
  onSaveSuccess?: () => void;
}

const PythonArtifactViewer: React.FC<PythonArtifactViewerProps> = ({ artifact, onError, onSave, onSaveSuccess }) => {
  const theme = useTheme();
  const mode = theme.palette.mode;

  // Pyodide state
  const {
    isLoading: isPyodideLoading,
    loadProgress,
    error: pyodideError,
    isExecuting,
    streamingOutput,
    initialize,
    execute,
    interrupt,
    detectPackages,
    isReady,
  } = usePyodide();

  // Tab state: 0 = Output, 1 = Code
  const [activeTab, setActiveTab] = useState<number>(0);

  // Execution state
  const [executionOutput, setExecutionOutput] = useState<string>('');
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [executionPlots, setExecutionPlots] = useState<string[]>([]);
  const [executionTime, setExecutionTime] = useState<number | null>(null);
  const [hasRun, setHasRun] = useState(false);

  // Edit state (mirroring ReactArtifactViewer)
  const [editableCode, setEditableCode] = useState(artifact.content);
  const [originalCode, setOriginalCode] = useState(artifact.content);
  const [hasChanges, setHasChanges] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [showEditWarningModal, setShowEditWarningModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isPersisted, setIsPersisted] = useState(false);

  // Version state
  const [currentVersion, setCurrentVersion] = useState<number>(artifact.version || 1);
  const [isViewingDifferentVersion, setIsViewingDifferentVersion] = useState(false);

  // Syntax highlighting for Python
  const highlightCode = useCallback((code: string) => {
    try {
      return Prism.highlight(code, Prism.languages.python, 'python');
    } catch (e) {
      console.error('Error highlighting code:', e);
      return code;
    }
  }, []);

  // Check persistence on mount
  useEffect(() => {
    const checkPersistence = async () => {
      const persisted = await checkArtifactExists(artifact.id);
      setIsPersisted(persisted);
    };
    checkPersistence();

    saveArtifactToLocalStorage({
      id: artifact.id,
      type: artifact.type,
      title: artifact.title,
      content: artifact.content,
      version: artifact.version,
      metadata: artifact.metadata,
    });

    clearOldCachedArtifacts();
  }, [artifact]);

  useEffect(() => {
    setHasChanges(editableCode !== originalCode);
  }, [editableCode, originalCode]);

  // Initialize Pyodide on first render
  useEffect(() => {
    initialize().catch(console.error);
  }, [initialize]);

  const detectedPackages = useMemo(() => {
    return detectPackages(editableCode);
  }, [editableCode, detectPackages]);

  const handleRun = useCallback(async () => {
    setExecutionError(null);
    setExecutionOutput('');
    setExecutionPlots([]);
    setHasRun(true);

    try {
      const result = await execute(editableCode, detectedPackages);

      setExecutionOutput(result.output);
      setExecutionPlots(result.plots);
      setExecutionTime(result.executionTime);

      if (!result.success) {
        const errorMsg = result.error || 'Execution failed';
        setExecutionError(errorMsg);
        onError?.(errorMsg);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Execution failed';
      setExecutionError(errorMsg);
      onError?.(errorMsg);
    }
  }, [editableCode, detectedPackages, execute, onError]);

  // Save handler (mirrors ReactArtifactViewer)
  const handleSave = async () => {
    if (!onSave || (!hasChanges && isPersisted)) return;

    setIsSaving(true);
    try {
      const result = await onSave(editableCode);

      const newVersion = result?.artifact?.version ?? result?.version;
      if (newVersion && typeof newVersion === 'number' && newVersion !== currentVersion) {
        setCurrentVersion(newVersion);
        saveArtifactVersionToLocalStorage(artifact.id, newVersion, editableCode);
      }

      saveArtifactToLocalStorage({
        id: artifact.id,
        type: artifact.type,
        title: artifact.title,
        content: editableCode,
        version: newVersion || currentVersion,
        metadata: artifact.metadata,
      });

      setHasChanges(false);
      setOriginalCode(editableCode);
      onSaveSuccess?.();
    } catch (error) {
      console.error('Error saving code:', error);
      toast.error('Failed to save changes');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRevert = () => {
    setEditableCode(originalCode);
  };

  const handleVersionChange = async (version: number) => {
    if (version === currentVersion) return;

    setCurrentVersion(version);
    setIsViewingDifferentVersion(true);
    setSelectedArtifactVersion(artifact.id, version);

    try {
      const cachedVersion = getArtifactVersionFromLocalStorage(artifact.id, version);
      if (cachedVersion?.content) {
        setEditableCode(cachedVersion.content);
        setOriginalCode(cachedVersion.content);
        return;
      }

      const response = await api.get(`/api/artifacts/${artifact.id}/versions/${version}`);
      if (response.data?.data?.content) {
        const versionContent = response.data.data.content;
        setEditableCode(versionContent);
        setOriginalCode(versionContent);
        saveArtifactVersionToLocalStorage(artifact.id, version, versionContent);
      }
    } catch (error) {
      console.error('Error fetching version:', error);
      toast.error('Error loading version content');
    }
  };

  const renderOutput = () => {
    if (!hasRun) {
      return (
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'text.secondary',
            p: 4,
          }}
        >
          <RunIcon sx={{ fontSize: 48, mb: 2, opacity: 0.5 }} />
          <Typography level="body-md">Click &quot;Run&quot; to execute Python code</Typography>
          {detectedPackages.length > 0 && (
            <Typography level="body-sm" sx={{ mt: 1, opacity: 0.7 }}>
              Packages: {detectedPackages.join(', ')}
            </Typography>
          )}
        </Box>
      );
    }

    return (
      <Stack spacing={2} sx={{ height: '100%', overflow: 'auto', p: 2 }}>
        {/* Execution time */}
        {executionTime !== null && (
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
            Executed in {executionTime.toFixed(2)}ms
          </Typography>
        )}

        {/* Plots */}
        {executionPlots.length > 0 && (
          <Stack spacing={2}>
            {executionPlots.map((plot, index) => (
              <Box
                key={index}
                component="img"
                src={`data:image/png;base64,${plot}`}
                alt={`Plot ${index + 1}`}
                sx={{
                  maxWidth: '100%',
                  borderRadius: 1,
                  border: '1px solid',
                  borderColor: 'divider',
                }}
              />
            ))}
          </Stack>
        )}

        {/* Text output */}
        {executionOutput && (
          <Box
            sx={{
              backgroundColor: mode === 'dark' ? '#1e1e1e' : '#f5f5f5',
              borderRadius: 1,
              p: 2,
              fontFamily: 'monospace',
              fontSize: '14px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {executionOutput}
          </Box>
        )}

        {/* Error output */}
        {executionError && (
          <Alert
            color="danger"
            variant="solid"
            sx={{
              bgcolor: 'danger.700',
              color: 'white',
              '& .MuiTypography-root': { color: 'white' },
            }}
          >
            <Typography level="body-sm" sx={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
              {executionError}
            </Typography>
          </Alert>
        )}

        {/* Running state with streaming output */}
        {isExecuting && (
          <>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ color: 'text.secondary' }}>
              <CircularProgress size="sm" />
              <Typography level="body-sm">Running...</Typography>
            </Stack>
            {streamingOutput && (
              <Box
                sx={{
                  backgroundColor: mode === 'dark' ? '#1e1e1e' : '#f5f5f5',
                  borderRadius: 1,
                  p: 2,
                  fontFamily: 'monospace',
                  fontSize: '14px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: '400px',
                  overflow: 'auto',
                }}
              >
                {streamingOutput}
              </Box>
            )}
          </>
        )}

        {/* No output message - only show when not executing */}
        {!isExecuting && !executionOutput && !executionError && executionPlots.length === 0 && (
          <Typography level="body-sm" sx={{ color: 'text.tertiary', fontStyle: 'italic' }}>
            Code executed successfully with no output.
          </Typography>
        )}
      </Stack>
    );
  };

  return (
    <>
      <Box
        sx={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          minHeight: 0,
        }}
      >
        {/* Pyodide loading indicator */}
        {isPyodideLoading && (
          <Box sx={{ px: 2, pt: 1 }}>
            <Stack spacing={1}>
              <Typography level="body-sm">Loading Python runtime ({loadProgress}%)</Typography>
              <LinearProgress determinate value={loadProgress} />
            </Stack>
          </Box>
        )}

        {/* Pyodide error */}
        {pyodideError && (
          <Alert
            color="danger"
            variant="solid"
            sx={{
              m: 2,
              bgcolor: 'danger.700',
              color: 'white',
              '& .MuiTypography-root': { color: 'white' },
            }}
          >
            <Typography level="title-sm">Python Runtime Error</Typography>
            <Typography level="body-sm">{pyodideError}</Typography>
          </Alert>
        )}

        <Tabs
          value={activeTab}
          onChange={(_, newValue) => setActiveTab(newValue as number)}
          sx={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            '& [role="tabpanel"]': {
              flex: 1,
              minHeight: 0,
              position: 'relative',
            },
          }}
        >
          {/* Tab header with controls */}
          <Box
            sx={{
              borderBottom: '1px solid',
              borderColor: 'divider',
              px: 2,
              py: 1,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexShrink: 0,
            }}
          >
            <TabList sx={{ minHeight: 'auto' }}>
              <Tab value={0} sx={{ py: 0.5, minHeight: 'auto' }}>
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <OutputIcon sx={{ fontSize: 18 }} />
                  <Typography level="body-sm">Output</Typography>
                </Stack>
              </Tab>
              <Tab value={1} sx={{ py: 0.5, minHeight: 'auto' }}>
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <CodeIcon sx={{ fontSize: 18 }} />
                  <Typography level="body-sm">Code</Typography>
                </Stack>
              </Tab>
            </TabList>

            <Stack direction="row" spacing={1} alignItems="center">
              {/* Run/Stop button */}
              {isExecuting ? (
                <Button size="sm" variant="solid" color="danger" startDecorator={<StopIcon />} onClick={interrupt}>
                  Stop
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="solid"
                  color="success"
                  startDecorator={isPyodideLoading ? <CircularProgress size="sm" /> : <RunIcon />}
                  onClick={handleRun}
                  disabled={isPyodideLoading || !isReady()}
                >
                  Run
                </Button>
              )}

              {/* Edit mode controls */}
              {onSave && !isEditMode && (
                <Button
                  size="sm"
                  variant="outlined"
                  color="neutral"
                  startDecorator={<UnlockIcon />}
                  onClick={() => setShowEditWarningModal(true)}
                >
                  Enable Edit Mode
                </Button>
              )}

              {onSave && isEditMode && (
                <>
                  <Button
                    size="sm"
                    variant="outlined"
                    color="warning"
                    startDecorator={<LockIcon />}
                    onClick={() => setIsEditMode(false)}
                  >
                    Lock
                  </Button>
                  <Button
                    size="sm"
                    variant="outlined"
                    color="neutral"
                    startDecorator={<UndoIcon />}
                    onClick={handleRevert}
                    disabled={!hasChanges}
                  >
                    Revert
                  </Button>
                  <Button
                    size="sm"
                    variant="solid"
                    color={!isPersisted ? 'success' : 'primary'}
                    startDecorator={<SaveIcon />}
                    onClick={handleSave}
                    disabled={(!hasChanges && isPersisted) || isSaving}
                    loading={isSaving}
                  >
                    {!isPersisted ? 'Save to Database' : 'Save'}
                  </Button>
                </>
              )}

              <ArtifactVersionDropdown
                artifactId={artifact.id}
                currentVersion={currentVersion}
                onVersionChange={handleVersionChange}
              />
            </Stack>
          </Box>

          {/* Status bar */}
          {onSave && (hasChanges || !isPersisted || isViewingDifferentVersion) && (
            <Box
              sx={{
                px: 2,
                py: 0.5,
                borderBottom: '1px solid',
                borderColor: 'divider',
                backgroundColor: 'background.level1',
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                flexShrink: 0,
              }}
            >
              <Stack direction="row" spacing={2} alignItems="center" sx={{ flex: 1 }}>
                {!isPersisted && (
                  <Typography level="body-xs" sx={{ color: 'warning.main' }}>
                    Not saved to database
                  </Typography>
                )}
                {hasChanges && isPersisted && (
                  <Typography level="body-xs" sx={{ color: 'warning.main' }}>
                    Unsaved changes
                  </Typography>
                )}
                {isViewingDifferentVersion && (
                  <Typography level="body-xs" sx={{ color: 'primary.main', fontStyle: 'italic' }}>
                    Viewing version {currentVersion}
                  </Typography>
                )}
                {isEditMode && (
                  <Typography level="body-xs" sx={{ color: 'danger.main', fontWeight: 'bold' }}>
                    Edit mode active
                  </Typography>
                )}
              </Stack>
            </Box>
          )}

          {/* Output Panel */}
          <TabPanel value={0} sx={{ p: 0, position: 'relative' }}>
            {renderOutput()}
          </TabPanel>

          {/* Code Panel */}
          <TabPanel value={1} sx={{ p: 0, position: 'relative' }}>
            <Box
              sx={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                overflow: 'auto',
              }}
            >
              {onSave && isEditMode ? (
                <Box
                  sx={{
                    width: '100%',
                    minHeight: '100%',
                    backgroundColor: mode === 'dark' ? '#282c34' : '#fafafa',
                    '& textarea': { outline: 'none !important' },
                    '& pre': { margin: 0, fontFamily: 'monospace' },
                  }}
                >
                  <Editor
                    value={editableCode}
                    onValueChange={setEditableCode}
                    highlight={highlightCode}
                    padding={16}
                    placeholder="Enter your Python code here..."
                    style={{
                      fontFamily: '"Fira Code", "Fira Mono", Consolas, Menlo, Courier, monospace',
                      fontSize: 14,
                      lineHeight: 1.5,
                      minHeight: '100%',
                      backgroundColor: 'transparent',
                      color: mode === 'dark' ? '#abb2bf' : '#393A34',
                    }}
                  />
                </Box>
              ) : (
                <SyntaxHighlighter
                  language="python"
                  style={oneDark}
                  customStyle={{
                    margin: 0,
                    minHeight: '100%',
                    fontSize: '14px',
                    lineHeight: '1.5',
                    padding: '16px',
                  }}
                  showLineNumbers
                >
                  {editableCode}
                </SyntaxHighlighter>
              )}
            </Box>
          </TabPanel>
        </Tabs>
      </Box>

      {/* Edit Mode Warning Modal (similar to ReactArtifactViewer) */}
      <Modal open={showEditWarningModal} onClose={() => setShowEditWarningModal(false)}>
        <ModalDialog variant="outlined" role="alertdialog" sx={{ maxWidth: 500 }}>
          <ModalClose />
          <Typography level="h4" startDecorator={<WarningIcon color="warning" />}>
            Enable Code Editing
          </Typography>
          <Divider sx={{ my: 2 }} />

          <Stack spacing={2}>
            <Typography level="body-md">
              You&apos;re about to enable code editing mode. This allows you to modify and run Python code in your
              browser using Pyodide (WebAssembly).
            </Typography>

            <Alert color="warning" variant="soft">
              <Typography level="body-sm" fontWeight="bold">
                Security Notice:
              </Typography>
              <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                <Typography level="body-sm">Python code runs entirely in your browser (no server execution)</Typography>
                <Typography level="body-sm">Cannot access files outside the browser sandbox</Typography>
                <Typography level="body-sm">Network access is restricted to CORS-allowed endpoints</Typography>
              </Stack>
            </Alert>

            <Alert color="neutral" variant="soft">
              <Typography level="body-sm" fontWeight="bold">
                Execution Control:
              </Typography>
              <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                <Typography level="body-sm">Code runs in a background thread (UI stays responsive)</Typography>
                <Typography level="body-sm">
                  Click &quot;Stop&quot; to interrupt infinite loops or long calculations
                </Typography>
                <Typography level="body-sm">Large data operations may use significant memory</Typography>
              </Stack>
            </Alert>
          </Stack>

          <Stack direction="row" spacing={1} sx={{ mt: 3, justifyContent: 'flex-end' }}>
            <Button variant="outlined" color="neutral" onClick={() => setShowEditWarningModal(false)}>
              Cancel
            </Button>
            <Button
              variant="solid"
              color="warning"
              startDecorator={<UnlockIcon />}
              onClick={() => {
                setIsEditMode(true);
                setShowEditWarningModal(false);
              }}
            >
              I Understand, Enable Editing
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>
    </>
  );
};

export default PythonArtifactViewer;
