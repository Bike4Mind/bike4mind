import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
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
  useTheme,
} from '@mui/joy';
import { type ReactArtifact } from '@bike4mind/common';
import { validateArtifactContent } from '@client/app/utils/artifactParser';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import Editor from 'react-simple-code-editor';
import Prism from 'prismjs';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-tsx';
import {
  PlayArrow as PreviewIcon,
  Code as CodeIcon,
  Save as SaveIcon,
  Undo as UndoIcon,
  Lock as LockIcon,
  LockOpen as UnlockIcon,
  Warning as WarningIcon,
} from '@mui/icons-material';
import { gray, whiteAlpha } from '@client/app/utils/themes/colors';
import { ArtifactVersionDropdown } from '@client/app/components/artifacts';
import { toast } from 'react-hot-toast';
import { api } from '@client/app/contexts/ApiContext';
import {
  checkArtifactExists,
  saveArtifactToLocalStorage,
  getArtifactFromLocalStorage,
  saveArtifactVersionToLocalStorage,
  getArtifactVersionFromLocalStorage,
  clearOldCachedArtifacts,
} from '@client/app/utils/artifactPersistence';
import { getSelectedArtifactVersion, setSelectedArtifactVersion } from '@client/app/hooks/useSessionLayout';
import { useExperimentalFeatureSettings } from '@client/app/hooks/data/settings';
import { useReactArtifactSandbox } from '@client/app/hooks/useReactArtifactSandbox';

interface ReactArtifactViewerProps {
  artifact: ReactArtifact;
  onError?: (error: string) => void;
  onSave?: (updatedContent: string) => Promise<any>;
  onSaveSuccess?: () => void;
}

const DisabledPreviewMessage = () => (
  <Alert color="warning" sx={{ m: 2, height: '100%', display: 'flex', alignItems: 'center' }}>
    <Box>
      <Typography level="title-sm">React Viewer Disabled</Typography>
      <Typography level="body-sm" sx={{ mt: 1 }}>
        The React component viewer is currently disabled. An administrator can enable it in the admin settings under
        &quot;Experimental Features&quot; → &quot;Enable React Viewer&quot;.
      </Typography>
      <Typography level="body-sm" sx={{ mt: 1, fontStyle: 'italic' }}>
        You can view the source code using the &quot;Code&quot; tab.
      </Typography>
    </Box>
  </Alert>
);

const ReactArtifactViewer: React.FC<ReactArtifactViewerProps> = ({ artifact, onError, onSave, onSaveSuccess }) => {
  const theme = useTheme();
  const [error, setError] = useState<string | null>(null);
  // Check if React viewer is enabled via admin settings
  const { data: experimentalSettingsWithDefaults } = useExperimentalFeatureSettings();
  const isReactViewerEnabled =
    experimentalSettingsWithDefaults.find(s => s.settingName === 'EnableReactViewer')?.settingValue === 'true';

  // Syntax highlighting function for Editor
  const highlightCode = useCallback((code: string) => {
    try {
      return Prism.highlight(code, Prism.languages.tsx, 'tsx');
    } catch (e) {
      console.error('Error highlighting code:', e);
      return code;
    }
  }, []);

  const [activeTab, setActiveTab] = useState<number>(0); // 0 for preview, 1 for code

  // Version state - needs to be declared early since setEditableCode references it
  const [currentVersion, setCurrentVersion] = useState<number>(() => {
    // Check if there's a selected version in session layout
    const selectedVersion = getSelectedArtifactVersion(artifact.id);
    if (selectedVersion !== undefined) {
      return selectedVersion;
    }
    // Otherwise use the artifact's version if it has one, or default to 1
    return artifact.version || 1;
  });
  const [isViewingDifferentVersion, setIsViewingDifferentVersion] = useState<boolean>(() => {
    // If there's a selected version different from artifact version, we're viewing a different version
    const selectedVersion = getSelectedArtifactVersion(artifact.id);
    return selectedVersion !== undefined && selectedVersion !== (artifact.version || 1);
  });

  // Use a ref to track the currently viewed version to prevent overwrites
  const currentVersionRef = useRef(currentVersion);
  useEffect(() => {
    currentVersionRef.current = currentVersion;
  }, [currentVersion]);

  // Don't initialize with artifact.content if we're viewing a different version
  const [editableCode, setEditableCodeRaw] = useState(() => {
    // Try to load from localStorage first
    const cached = getArtifactFromLocalStorage(artifact.id);
    if (cached && cached.content) {
      console.log('[ReactArtifactViewer] Loaded artifact from localStorage:', artifact.id);
      return cached.content;
    }

    const selectedVersion = getSelectedArtifactVersion(artifact.id);
    // If viewing a different version, we'll fetch it in useEffect
    if (selectedVersion !== undefined && selectedVersion !== (artifact.version || 1)) {
      return artifact.content; // Temporary, will be replaced by fetched content
    }
    return artifact.content;
  });
  const [originalCode, setOriginalCode] = useState(artifact.content);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Stable wrapper around the editableCode setter
  const setEditableCode = useCallback((newCode: string) => {
    setEditableCodeRaw(newCode);
  }, []);

  // Check persistence status from database
  const [isPersisted, setIsPersisted] = useState(false);

  // Edit mode state
  const [isEditMode, setIsEditMode] = useState(false);
  const [showEditWarningModal, setShowEditWarningModal] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Check persistence status on mount and save to localStorage
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
  }, [artifact.id, artifact.type, artifact.title, artifact.content, artifact.metadata, artifact.version]);

  // Fetch content for selected version on mount if viewing a different version
  useEffect(() => {
    const fetchInitialVersion = async () => {
      if (isViewingDifferentVersion && currentVersion) {
        try {
          // Check localStorage first
          const cachedVersion = getArtifactVersionFromLocalStorage(artifact.id, currentVersion);
          if (cachedVersion && cachedVersion.content) {
            console.log('[ReactArtifactViewer] Loaded version from localStorage:', currentVersion);
            setEditableCode(cachedVersion.content);
            setOriginalCode(cachedVersion.content);
            return;
          }

          // Fetch from API if not in localStorage
          const response = await api.get(`/api/artifacts/${artifact.id}/versions/${currentVersion}`);
          if (response.data?.data?.content) {
            const versionContent = response.data.data.content;
            setEditableCode(versionContent);
            // Update originalCode to the version content so we don't show "unsaved changes"
            setOriginalCode(versionContent);
            // Save to localStorage for next time
            saveArtifactVersionToLocalStorage(artifact.id, currentVersion, versionContent);
          }
        } catch (error) {
          console.error('[ReactArtifactViewer] Error fetching initial version:', error);
          // Fall back to artifact content
          setEditableCode(artifact.content);
          setOriginalCode(artifact.content);
          setIsViewingDifferentVersion(false);
          setSelectedArtifactVersion(artifact.id, undefined);
        }
      }
    };

    fetchInitialVersion();
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Check if this is a legacy artifact ID
  const isLegacyArtifact = !artifact.id.startsWith('artifact_');

  // Update currentVersion when artifact changes (but not when viewing a different version)
  useEffect(() => {
    const artifactVersion = artifact.version;
    // Don't reset version if user is actively viewing a different version
    if (artifactVersion && artifactVersion !== currentVersion && !isViewingDifferentVersion) {
      setCurrentVersion(artifactVersion);
    }
  }, [artifact, currentVersion, isViewingDifferentVersion]);

  // Update editableCode when artifact content changes (but not when in edit mode or viewing a different version)
  useEffect(() => {
    // Don't update if we're actively viewing a different version
    // Check session layout for the selected version
    const selectedVersion = getSelectedArtifactVersion(artifact.id);
    const isActivelyViewingDifferentVersion = selectedVersion !== undefined;
    // Only update if we're NOT viewing a different version AND not in edit mode
    if (artifact.content && artifact.content !== editableCode && !isEditMode && !isActivelyViewingDifferentVersion) {
      setEditableCode(artifact.content);
      // Also update originalCode to prevent false "unsaved changes" indicator
      setOriginalCode(artifact.content);
    }
  }, [artifact.content, editableCode, isEditMode, isViewingDifferentVersion, setEditableCode]);

  useEffect(() => {
    const hasChangesValue = editableCode !== originalCode;
    setHasChanges(hasChangesValue);
  }, [editableCode, originalCode]);

  // Focus textarea when edit mode is enabled
  useEffect(() => {
    if (isEditMode && textareaRef.current) {
      setTimeout(() => {
        textareaRef.current?.focus();
        textareaRef.current?.click();
      }, 100);
    }
  }, [isEditMode]);

  // Validate the artifact content
  const validation = useMemo(() => {
    return validateArtifactContent(artifact.type, editableCode);
  }, [editableCode, artifact.type]);

  useEffect(() => {
    if (!validation.isValid) {
      const errorMsg = `Invalid React artifact: ${validation.errors.join(', ')}`;
      setError(errorMsg);
      onError?.(errorMsg);
    } else {
      setError(null);
    }
    // validation is memoized on [editableCode, artifact.type], so validation.errors is a
    // stable ref until the code changes - including it keeps the message fresh as edits
    // change which errors are reported, without looping.
  }, [validation.isValid, validation.errors, onError]);

  const memoizedDependencies = useMemo(() => {
    const metadataDeps = artifact.metadata?.dependencies || [];

    // Also extract dependencies from the actual code
    const codeImportRegex = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
    const codeDeps: string[] = [];
    let match;
    while ((match = codeImportRegex.exec(editableCode)) !== null) {
      const dep = match[1];
      // Only include external packages (not relative imports)
      if (!dep.startsWith('.') && !dep.startsWith('/') && dep !== 'react') {
        codeDeps.push(dep);
      }
    }

    // Combine and deduplicate (avoid spread on Set for TS compatibility)
    const combinedDeps = [...metadataDeps, ...codeDeps];
    const uniqueDepsSet = new Set(combinedDeps);
    const allDeps = Array.from(uniqueDepsSet);
    return allDeps;
  }, [artifact.metadata?.dependencies, editableCode]);

  // Debounce preview input: feed code+deps to the sandbox 1s after edits settle (matches the
  // prior blob-regeneration debounce), only when the viewer is enabled and the code is valid.
  const [preview, setPreview] = useState<{ code: string; deps: string[] } | null>(null);
  useEffect(() => {
    if (!validation.isValid || !isReactViewerEnabled) {
      setPreview(null);
      return;
    }
    const timeoutId = setTimeout(() => setPreview({ code: editableCode, deps: memoizedDependencies }), 1000);
    return () => clearTimeout(timeoutId);
  }, [editableCode, memoizedDependencies, validation.isValid, isReactViewerEnabled]);

  // React artifacts render in the dedicated /api/react-artifact-sandbox route - its own
  // per-route CSP carries 'unsafe-eval', so the app CSP stays clean. The iframe
  // remounts on change; transform/runtime errors render inline in the sandbox and are
  // surfaced here for telemetry.
  const {
    iframeRef: reactIframeRef,
    iframeKey: reactIframeKey,
    src: reactSandboxSrc,
    isLoading: reactPreviewLoading,
    error: reactRuntimeError,
  } = useReactArtifactSandbox(preview?.code ?? null, preview?.deps ?? []);
  useEffect(() => {
    if (reactRuntimeError) onError?.(reactRuntimeError);
  }, [reactRuntimeError, onError]);

  // Show validation errors but still allow editing
  const hasValidationErrors = !validation.isValid;

  const tabPanelValues = {
    // If there are validation errors, show the code tab first
    preview: hasValidationErrors ? 1 : 0,
    code: hasValidationErrors ? 0 : 1,
  };

  // Don't show error if it's the default export error
  // This error will be handled by the react viewer itself
  if (error && error !== 'Invalid React artifact: React components must have a default export') {
    return (
      <Alert color="danger" sx={{ m: 2 }}>
        <Typography level="title-sm">React Component Error</Typography>
        <Typography level="body-sm" sx={{ mt: 1, whiteSpace: 'pre-line', color: 'danger.100' }}>
          {error}
        </Typography>
      </Alert>
    );
  }

  const handleSave = async () => {
    if (!onSave) {
      return;
    }

    // Allow save when there are changes, or the artifact is not yet persisted (fresh)
    if (!hasChanges && isPersisted) {
      return;
    }

    setIsSaving(true);
    try {
      const result = await onSave(editableCode);
      // Don't update editableCode here; the parent re-renders with the updated artifact.

      // Update the current version if a new version was created.
      // Handle both {version: number} and {artifact: {version: number}} response formats
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

      onSaveSuccess?.();
    } catch (error) {
      console.error('🔧 DEBUG - Error in onSave:', error);
      console.error('Error saving code:', error);
      setError('Failed to save changes');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRevert = () => {
    setEditableCode(originalCode);
  };

  const handleVersionChange = async (version: number) => {
    // Don't do anything if we're already on this version
    if (version === currentVersion) {
      return;
    }
    // Set these FIRST to prevent race conditions with useEffect
    setCurrentVersion(version);
    setIsViewingDifferentVersion(true);
    // Store the selected version (keyed by this artifact's id) so KnowledgeViewer doesn't
    // override it and the selection can't bleed into other artifacts in the session
    setSelectedArtifactVersion(artifact.id, version);

    try {
      // Check localStorage first
      const cachedVersion = getArtifactVersionFromLocalStorage(artifact.id, version);
      if (cachedVersion && cachedVersion.content) {
        console.log('[ReactArtifactViewer] Loaded version from localStorage:', version);
        setEditableCode(cachedVersion.content);
        setOriginalCode(cachedVersion.content);
        return;
      }

      // Fetch from API if not in localStorage
      const response = await api.get(`/api/artifacts/${artifact.id}/versions/${version}`);
      if (response.data?.data?.content) {
        const versionContent = response.data.data.content;
        setEditableCode(versionContent);
        // Update originalCode to the version content so we don't show "unsaved changes"
        setOriginalCode(versionContent);
        // Save to localStorage for next time
        saveArtifactVersionToLocalStorage(artifact.id, version, versionContent);
      } else {
        console.error('No content in version response:', response.data);
        toast.error('Version has no content');
      }
    } catch (error) {
      console.error('Error fetching version content:', error);
      toast.error('Error loading version content');
    }
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
        {isLegacyArtifact && (
          <Alert color="warning" sx={{ mx: 2, mt: 2, mb: 1 }}>
            <Typography level="body-sm">
              This is a legacy artifact. It will be migrated to the new system when you save it.
            </Typography>
          </Alert>
        )}
        {hasValidationErrors && (
          <Alert
            color="danger"
            sx={{
              mx: 2,
              mt: isLegacyArtifact ? 0 : 2,
              mb: 1,
              bgcolor: 'danger.700',
              borderColor: 'danger.500',
              '& .MuiAlert-startDecorator': { color: 'danger.100' },
            }}
          >
            <Stack spacing={1}>
              <Typography level="title-sm" startDecorator={<WarningIcon />} sx={{ color: 'danger.50' }}>
                Invalid React Component
              </Typography>
              <Typography level="body-sm" sx={{ color: 'danger.100' }}>
                {validation.errors.join(', ')}
              </Typography>
              <Typography level="body-xs" sx={{ mt: 1, fontStyle: 'italic', color: 'danger.200' }}>
                Fix the issues in the Code tab, then save to update the preview.
              </Typography>
            </Stack>
          </Alert>
        )}
        <Tabs
          className="react-artifact-viewer-tabs"
          value={activeTab}
          onChange={(_event: React.SyntheticEvent | null, newValue: number | string | null) => {
            if (newValue !== null) {
              setActiveTab(newValue as number);
            }
          }}
          sx={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            // TabPanels should fill remaining space
            '& [role="tabpanel"]': {
              flex: 1,
              minHeight: 0,
              position: 'relative',
            },
          }}
        >
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
            <TabList className="react-artifact-viewer-tab-list" sx={{ minHeight: 'auto' }}>
              <Tab
                className="react-artifact-viewer-tab-preview"
                value={tabPanelValues.preview}
                sx={{ py: 0.5, minHeight: 'auto' }}
              >
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <PreviewIcon sx={{ fontSize: 18 }} />
                  <Typography className="react-artifact-viewer-tab-label" level="body-sm">
                    Preview
                  </Typography>
                </Stack>
              </Tab>
              <Tab
                className="react-artifact-viewer-tab-code"
                value={tabPanelValues.code}
                sx={{ py: 0.5, minHeight: 'auto' }}
              >
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <CodeIcon sx={{ fontSize: 18 }} />
                  <Typography className="react-artifact-viewer-tab-label" level="body-sm">
                    Code
                  </Typography>
                </Stack>
              </Tab>
            </TabList>

            <Stack className="react-artifact-viewer-toolbar" direction="row" spacing={1} alignItems="center">
              {onSave && !isEditMode && (
                <Button
                  className="react-artifact-viewer-edit-toggle view-only"
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
                    className="react-artifact-viewer-edit-toggle editing"
                    size="sm"
                    variant="outlined"
                    color="warning"
                    startDecorator={<LockIcon />}
                    onClick={() => setIsEditMode(false)}
                  >
                    Lock
                  </Button>
                  <Button
                    className="react-artifact-viewer-revert-button"
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
                    className="react-artifact-viewer-save-button"
                    size="sm"
                    variant="solid"
                    color={!isPersisted ? 'success' : 'primary'}
                    startDecorator={<SaveIcon />}
                    onClick={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleSave();
                    }}
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
                    ⚠️ Not saved to database
                  </Typography>
                )}
                {hasChanges && isPersisted && (
                  <Typography level="body-xs" sx={{ color: 'warning.main' }}>
                    ● Unsaved changes
                  </Typography>
                )}
                {isViewingDifferentVersion && (
                  <Typography level="body-xs" sx={{ color: 'info.main', fontStyle: 'italic' }}>
                    📌 Viewing version {currentVersion}
                  </Typography>
                )}
                {isEditMode && (
                  <Typography level="body-xs" sx={{ color: 'danger.main', fontWeight: 'bold' }}>
                    🔓 Edit mode active
                  </Typography>
                )}
              </Stack>
            </Box>
          )}

          <TabPanel
            className="react-artifact-viewer-preview-panel"
            value={tabPanelValues.preview}
            sx={{
              p: 0,
              position: 'relative',
            }}
          >
            {!isReactViewerEnabled ? (
              <DisabledPreviewMessage />
            ) : (
              <>
                {reactPreviewLoading && (
                  <Box
                    className="react-artifact-viewer-loading-overlay"
                    sx={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      bottom: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: whiteAlpha[0][80],
                      zIndex: 1,
                    }}
                  >
                    <CircularProgress className="react-artifact-viewer-loading-spinner" size="sm" />
                  </Box>
                )}

                {/* allow-modals is intentional on the full editor (artifacts may use
                    alert()/confirm(); see the Edit-Mode warning modal) - the inline
                    preview in InlineArtifactPreview deliberately omits it. */}
                <iframe
                  key={reactIframeKey}
                  ref={reactIframeRef}
                  src={reactSandboxSrc}
                  title={artifact.title}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    border: 'none',
                    borderRadius: '4px',
                  }}
                  sandbox="allow-scripts allow-modals"
                />
              </>
            )}
          </TabPanel>

          <TabPanel
            className="react-artifact-viewer-code-panel"
            value={tabPanelValues.code}
            sx={{
              p: 0,
              position: 'relative',
            }}
          >
            <Box
              className="react-artifact-viewer-code-container"
              sx={{
                flex: 1,
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                overflow: 'auto',
                // Enable smooth scrolling and proper scroll behavior
                WebkitOverflowScrolling: 'touch',
                '&::-webkit-scrollbar': {
                  width: '8px',
                },
                '&::-webkit-scrollbar-track': {
                  background: gray[830],
                },
                '&::-webkit-scrollbar-thumb': {
                  background: gray[660],
                  borderRadius: '4px',
                },
                '&::-webkit-scrollbar-thumb:hover': {
                  background: gray[655],
                },
              }}
            >
              {onSave && isEditMode ? (
                <Box
                  sx={{
                    width: '100%',
                    minHeight: '100%',
                    backgroundColor: theme.palette.mode === 'dark' ? '#282c34' : '#fafafa',
                    '& textarea': {
                      outline: 'none !important',
                    },
                    '& pre': {
                      margin: 0,
                      fontFamily: 'monospace',
                    },
                    // Prism syntax highlighting styles for dark mode (oneDark theme)
                    ...(theme.palette.mode === 'dark' && {
                      '& .token.comment, & .token.prolog, & .token.doctype, & .token.cdata': {
                        color: '#5c6370',
                      },
                      '& .token.punctuation': {
                        color: '#abb2bf',
                      },
                      '& .token.property, & .token.tag, & .token.constant, & .token.symbol, & .token.deleted': {
                        color: '#e06c75',
                      },
                      '& .token.boolean, & .token.number': {
                        color: '#d19a66',
                      },
                      '& .token.selector, & .token.attr-name, & .token.string, & .token.char, & .token.builtin, & .token.inserted':
                        {
                          color: '#98c379',
                        },
                      '& .token.operator, & .token.entity, & .token.url, & .language-css .token.string, & .style .token.string':
                        {
                          color: '#56b6c2',
                        },
                      '& .token.atrule, & .token.attr-value, & .token.keyword': {
                        color: '#c678dd',
                      },
                      '& .token.function, & .token.class-name': {
                        color: '#61afef',
                      },
                      '& .token.regex, & .token.important, & .token.variable': {
                        color: '#e5c07b',
                      },
                    }),
                    // Prism syntax highlighting styles for light mode
                    ...(theme.palette.mode === 'light' && {
                      '& .token.comment, & .token.prolog, & .token.doctype, & .token.cdata': {
                        color: '#008000',
                      },
                      '& .token.punctuation': {
                        color: '#393A34',
                      },
                      '& .token.property, & .token.tag, & .token.boolean, & .token.number, & .token.constant, & .token.symbol, & .token.deleted':
                        {
                          color: '#36acaa',
                        },
                      '& .token.selector, & .token.attr-name, & .token.string, & .token.char, & .token.builtin, & .token.inserted':
                        {
                          color: '#A31515',
                        },
                      '& .token.operator, & .token.entity, & .token.url, & .language-css .token.string, & .style .token.string':
                        {
                          color: '#393A34',
                        },
                      '& .token.atrule, & .token.attr-value, & .token.keyword': {
                        color: '#0000FF',
                      },
                      '& .token.function, & .token.class-name': {
                        color: '#795E26',
                      },
                      '& .token.regex, & .token.important, & .token.variable': {
                        color: '#e90',
                      },
                    }),
                  }}
                >
                  <Editor
                    value={editableCode}
                    onValueChange={code => setEditableCode(code)}
                    highlight={highlightCode}
                    padding={16}
                    placeholder="Enter your React component code here..."
                    style={{
                      fontFamily: '"Fira Code", "Fira Mono", Consolas, Menlo, Courier, monospace',
                      fontSize: 14,
                      lineHeight: 1.5,
                      minHeight: '100%',
                      backgroundColor: 'transparent',
                      color: theme.palette.mode === 'dark' ? '#abb2bf' : '#393A34',
                    }}
                  />
                </Box>
              ) : (
                <SyntaxHighlighter
                  language="typescript"
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

      {/* Edit Mode Warning Modal */}
      <Modal
        className="react-artifact-viewer-warning-modal"
        open={showEditWarningModal}
        onClose={() => setShowEditWarningModal(false)}
      >
        <ModalDialog
          className="react-artifact-viewer-warning-dialog"
          variant="outlined"
          role="alertdialog"
          sx={{ maxWidth: 500 }}
        >
          <ModalClose className="react-artifact-viewer-modal-close" />
          <Typography
            className="react-artifact-viewer-modal-title"
            level="h4"
            startDecorator={<WarningIcon color="warning" />}
          >
            Enable Code Editing
          </Typography>
          <Divider sx={{ my: 2 }} />

          <Stack className="react-artifact-viewer-modal-content" spacing={2}>
            <Typography className="react-artifact-viewer-modal-description" level="body-md">
              You&apos;re about to enable code editing mode. This allows you to modify and run custom React code in an
              isolated sandbox.
            </Typography>

            <Alert className="react-artifact-viewer-security-alert" color="warning" variant="soft">
              <Typography className="react-artifact-viewer-alert-title" level="body-sm" fontWeight="bold">
                Security Notice:
              </Typography>
              <Stack className="react-artifact-viewer-alert-list" spacing={0.5} sx={{ mt: 0.5 }}>
                <Typography className="react-artifact-viewer-alert-item" level="body-sm">
                  • Code runs in an isolated iframe with restricted permissions
                </Typography>
                <Typography className="react-artifact-viewer-alert-item" level="body-sm">
                  • Cannot access your data, cookies, or make network requests
                </Typography>
                <Typography className="react-artifact-viewer-alert-item" level="body-sm">
                  • Cannot affect other users or the backend
                </Typography>
              </Stack>
            </Alert>

            <Alert className="react-artifact-viewer-danger-alert" color="danger" variant="soft">
              <Typography className="react-artifact-viewer-alert-title" level="body-sm" fontWeight="bold">
                Potential Risks (your browser only):
              </Typography>
              <Stack className="react-artifact-viewer-alert-list" spacing={0.5} sx={{ mt: 0.5 }}>
                <Typography className="react-artifact-viewer-alert-item" level="body-sm">
                  • Infinite loops may freeze this browser tab
                </Typography>
                <Typography className="react-artifact-viewer-alert-item" level="body-sm">
                  • Excessive memory usage may slow your browser
                </Typography>
                <Typography className="react-artifact-viewer-alert-item" level="body-sm">
                  • Annoying alerts or console spam
                </Typography>
              </Stack>
            </Alert>

            <Typography className="react-artifact-viewer-warning-text" level="body-sm" sx={{ fontStyle: 'italic' }}>
              Only edit code from trusted sources. If your browser becomes unresponsive, close this tab.
            </Typography>
          </Stack>

          <Stack
            className="react-artifact-viewer-modal-actions"
            direction="row"
            spacing={1}
            sx={{ mt: 3, justifyContent: 'flex-end' }}
          >
            <Button
              className="react-artifact-viewer-cancel-button"
              variant="outlined"
              color="neutral"
              onClick={() => setShowEditWarningModal(false)}
            >
              Cancel
            </Button>
            <Button
              className="react-artifact-viewer-confirm-button"
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

export default ReactArtifactViewer;
