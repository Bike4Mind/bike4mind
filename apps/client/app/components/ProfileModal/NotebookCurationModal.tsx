import React, { useState, useEffect, useRef, memo } from 'react';
import {
  Modal,
  ModalDialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Stack,
  Typography,
  Alert,
  LinearProgress,
  Box,
  List,
  ListItem,
  ListItemDecorator,
  Radio,
  RadioGroup,
  FormControl,
  FormLabel,
  Autocomplete,
  ListItemContent,
  Checkbox,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  AccordionGroup,
  Chip,
  Select,
  Option,
  Input,
  Textarea,
} from '@mui/joy';
import {
  AutoAwesome,
  CheckCircle,
  Error as ErrorIcon,
  HourglassEmpty,
  Description,
  Psychology,
  MenuBook,
  Code as CodeIcon,
  Image as ImageIcon,
  DataObject,
  BarChart,
  AccountTree,
  Language,
  Science,
  Assignment,
  Email as EmailIcon,
  Add as AddIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import { toast } from 'sonner';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import { useGetOwnSessions } from '@client/app/hooks/data/sessions';
import { useCurateNotebooks, useDownloadNotebooks, useSendNotebooksEmail } from '@client/app/hooks/data/notebooks';
import { useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { CurationType, ExportFormat, CurationArtifactTypeSchema } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { formatSessionTitle } from '@client/app/utils/sessionTitle';

// Inferred type for uppercase API artifact types
type CurationArtifactTypeAPI = z.infer<typeof CurationArtifactTypeSchema>;

interface NotebookCurationModalProps {
  open: boolean;
  onClose: () => void;
  preSelectedSessionIds?: string[];
}

interface SessionCurationResult {
  curationJobId: string;
  sessionId: string;
  sessionName: string;
  status: 'pending' | 'loading' | 'extracting' | 'generating' | 'storing' | 'completed' | 'failed';
  stage?: 'loading' | 'extracting' | 'generating' | 'storing';
  percentage: number;
  message?: string;
  messagesProcessed?: number;
  totalMessages?: number;
  artifactsFound?: number;
  curatedFileId?: string;
  errorMessage?: string;
  tokensDeducted?: number;
}

interface BatchCurationResult {
  batchJobId: string;
  sessionIds: string[];
  sessions: SessionCurationResult[];
  batchTotal: number;
  completedCount: number;
  failedCount: number;
}

const ARTIFACT_TYPES: {
  value: CurationArtifactTypeAPI;
  label: string;
  icon: React.JSX.Element;
  description: string;
}[] = [
  { value: 'CODE', label: 'Code Snippets', icon: <CodeIcon />, description: 'Generic code blocks' },
  { value: 'REACT', label: 'React Components', icon: <DataObject />, description: 'React/JSX components' },
  { value: 'MERMAID', label: 'Mermaid Diagrams', icon: <AccountTree />, description: 'Flowcharts and diagrams' },
  { value: 'RECHARTS', label: 'Charts', icon: <BarChart />, description: 'Data visualizations' },
  { value: 'SVG', label: 'SVG Graphics', icon: <ImageIcon />, description: 'Vector graphics' },
  { value: 'HTML', label: 'HTML Pages', icon: <Language />, description: 'HTML content' },
  { value: 'QUESTMASTER_PLAN', label: 'QuestMaster Plans', icon: <Assignment />, description: 'Task plans' },
  { value: 'DEEP_RESEARCH', label: 'Deep Research', icon: <Science />, description: 'Research findings' },
  { value: 'IMAGE', label: 'Images', icon: <ImageIcon />, description: 'Image attachments' },
];

const NotebookCurationModal: React.FC<NotebookCurationModalProps> = ({ open, onClose, preSelectedSessionIds }) => {
  const { subscribeToAction } = useWebsocket();
  const queryClient = useQueryClient();
  const { currentUser } = useUser();
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(() => new Set(preSelectedSessionIds || []));
  const [searchQuery, setSearchQuery] = useState('');
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailRecipients, setEmailRecipients] = useState<string[]>(['']);
  const [emailMessage, setEmailMessage] = useState('');
  const [batchResult, setBatchResult] = useState<BatchCurationResult | null>(null);
  const completedToastsRef = useRef<Set<string>>(new Set()); // Track shown toasts synchronously
  const processedMessagesRef = useRef<Set<string>>(new Set()); // Track processed WebSocket messages
  const unsubscribeRef = useRef<(() => void) | null>(null); // Track active subscription for cleanup
  const [curationType, setCurationType] = useState<CurationType>(CurationType.TRANSCRIPT);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('markdown');
  const [selectedArtifactTypes, setSelectedArtifactTypes] = useState<Set<CurationArtifactTypeAPI>>(
    new Set(ARTIFACT_TYPES.map(t => t.value))
  );
  const [customNotebookName, setCustomNotebookName] = useState<string>('');

  const {
    data: sessionsData,
    fetchNextPage,
    hasNextPage,
    isLoading: isLoadingSessions,
  } = useGetOwnSessions(searchQuery);

  const curateNotebooks = useCurateNotebooks({
    onSuccess: data => {
      const { batchJobId, curationJobs, batchTotal } = data;

      const sessionMap = new Map<string, string>();
      allSessions.forEach(s => sessionMap.set(s.id, s.name || 'Untitled Session'));

      setBatchResult({
        batchJobId,
        sessionIds: Array.from(selectedSessions),
        batchTotal,
        completedCount: 0,
        failedCount: 0,
        sessions: curationJobs.map(job => ({
          curationJobId: job.curationJobId,
          sessionId: job.sessionId,
          sessionName: sessionMap.get(job.sessionId) || 'Unknown Session',
          status: 'pending',
          percentage: 0,
        })),
      });
    },
  });

  const downloadNotebooks = useDownloadNotebooks();

  const sendNotebooksEmail = useSendNotebooksEmail({
    onSuccess: () => {
      setShowEmailModal(false);
      setEmailRecipients(['']);
      setEmailMessage('');
    },
  });

  // Cleanup on unmount to handle HMR edge cases
  useEffect(() => {
    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, []);

  // WebSocket listener for progress updates
  useEffect(() => {
    if (!batchResult || !open) return;

    // Clean up any existing subscription first
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }

    const unsubscribe = subscribeToAction('notebook_curation_progress', async (data: any) => {
      // Deduplicate messages using a unique key
      const messageKey = `${data.curationJobId}-${data.status}-${data.percentage || 0}`;
      if (processedMessagesRef.current.has(messageKey)) {
        return;
      }
      processedMessagesRef.current.add(messageKey);

      // Check if this update belongs to our batch
      setBatchResult(prev => {
        if (!prev) return prev;

        const sessionIndex = prev.sessions.findIndex(s => s.curationJobId === data.curationJobId);
        if (sessionIndex === -1) return prev; // Not our batch

        const newSessions = [...prev.sessions];
        newSessions[sessionIndex] = {
          ...newSessions[sessionIndex],
          status: data.status,
          stage: data.stage,
          percentage: data.percentage || 0,
          message: data.message,
          messagesProcessed: data.messagesProcessed,
          totalMessages: data.totalMessages,
          artifactsFound: data.artifactsFound,
          curatedFileId: data.curatedFileId,
          errorMessage: data.errorMessage,
          tokensDeducted: data.tokensDeducted,
        };

        const completedCount = newSessions.filter(s => s.status === 'completed').length;
        const failedCount = newSessions.filter(s => s.status === 'failed').length;
        const allDone = completedCount + failedCount === prev.batchTotal;

        if (data.status === 'completed') {
          const sessionName = newSessions[sessionIndex].sessionName;
          const jobId = data.curationJobId;

          // Only show toast if we haven't already shown it for this job (synchronous check)
          const alreadyShown = completedToastsRef.current.has(jobId);

          if (!alreadyShown) {
            toast.success(`"${sessionName}" curated successfully!`);
            completedToastsRef.current.add(jobId);
          }

          if (allDone) {
            // Only show batch complete toast once - check if we haven't shown it yet
            const batchCompleteKey = `${prev.batchJobId}-complete`;
            if (!completedToastsRef.current.has(batchCompleteKey)) {
              toast.success(`Batch complete! ${completedCount} successful, ${failedCount} failed.`);
              completedToastsRef.current.add(batchCompleteKey);
            }
          }

          // Invalidate fabFiles queries to refresh file browser immediately
          queryClient.invalidateQueries({ queryKey: ['fabFiles'], exact: false });
        } else if (data.status === 'failed') {
          const sessionName = newSessions[sessionIndex].sessionName;
          const jobId = data.curationJobId;

          // Only show toast if we haven't already shown it for this job (synchronous check)
          const alreadyShown = completedToastsRef.current.has(jobId);

          if (!alreadyShown) {
            toast.error(`"${sessionName}": ${data.errorMessage || 'Curation failed'}`);
            completedToastsRef.current.add(jobId);
          }

          if (allDone) {
            // Only show batch complete toast once - check if we haven't shown it yet
            const batchCompleteKey = `${prev.batchJobId}-complete`;
            if (!completedToastsRef.current.has(batchCompleteKey)) {
              toast.info(`Batch complete! ${completedCount} successful, ${failedCount} failed.`);
              completedToastsRef.current.add(batchCompleteKey);
            }
          }
        }

        return {
          ...prev,
          sessions: newSessions,
          completedCount,
          failedCount,
        };
      });
    });

    // Store unsubscribe function in ref for manual cleanup
    unsubscribeRef.current = unsubscribe;

    return () => {
      unsubscribe();
      unsubscribeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchResult?.batchJobId, open, subscribeToAction]);

  const estimatedCostPerSession = curationType === CurationType.TRANSCRIPT ? 100 : 1500;
  const totalEstimatedCost = selectedSessions.size * estimatedCostPerSession;
  const currentCredits = currentUser?.currentCredits || 0;
  const hasInsufficientCredits = totalEstimatedCost > currentCredits;

  const handleCurate = () => {
    if (selectedSessions.size === 0) {
      toast.error('Please select at least one session to curate');
      return;
    }

    if (hasInsufficientCredits) {
      toast.error('Insufficient credits. Please purchase more credits to continue.');
      return;
    }

    setBatchResult(null);
    completedToastsRef.current.clear(); // Reset toast tracker for new batch
    processedMessagesRef.current.clear(); // Reset message deduplication for new batch

    curateNotebooks.mutate({
      sessionIds: Array.from(selectedSessions),
      curationType,
      artifactTypes: Array.from(selectedArtifactTypes),
      exportFormat,
      customNotebookName: customNotebookName.trim() || undefined,
    });
  };

  const handleDownload = () => {
    if (!batchResult) return;

    const completedSessions = batchResult.sessions.filter(s => s.status === 'completed' && s.curatedFileId);
    if (completedSessions.length === 0) {
      toast.error('No completed curations to download');
      return;
    }

    const sessionIds = completedSessions.map(s => s.sessionId);
    const downloadAsZip = sessionIds.length > 1;

    downloadNotebooks.mutate({
      sessionIds,
      format: exportFormat,
      downloadAsZip,
    });
  };

  const handleSendEmail = () => {
    if (!batchResult) return;

    const completedSessions = batchResult.sessions.filter(s => s.status === 'completed' && s.curatedFileId);
    if (completedSessions.length === 0) {
      toast.error('No completed curations to send');
      return;
    }

    const validRecipients = emailRecipients.filter(email => {
      const trimmed = email.trim();
      return trimmed && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
    });

    if (validRecipients.length === 0) {
      toast.error('Please enter at least one valid email address');
      return;
    }

    const sessionIds = completedSessions.map(s => s.sessionId);

    sendNotebooksEmail.mutate({
      type: 'notebooks',
      sessionIds,
      recipients: validRecipients,
      format: exportFormat,
      message: emailMessage.trim() || undefined,
    });
  };

  const addEmailRecipient = () => {
    setEmailRecipients([...emailRecipients, '']);
  };

  const removeEmailRecipient = (index: number) => {
    if (emailRecipients.length > 1) {
      setEmailRecipients(emailRecipients.filter((_, i) => i !== index));
    }
  };

  const updateEmailRecipient = (index: number, value: string) => {
    const newRecipients = [...emailRecipients];
    newRecipients[index] = value;
    setEmailRecipients(newRecipients);
  };

  const getStageIcon = (stage: string, session: SessionCurationResult) => {
    const currentStage = session?.stage;
    const currentStatus = session?.status;
    const completed = currentStatus === 'completed';

    // If completed, show all stages as completed
    if (completed) {
      return <CheckCircle color="success" />;
    }

    // If failed, show error
    if (currentStatus === 'failed') {
      return <ErrorIcon color="error" />;
    }

    // If current stage is past this stage, show as completed
    if (currentStage && getStageOrder(currentStage) > getStageOrder(stage)) {
      return <CheckCircle color="success" />;
    }

    // If this is the current active stage
    if (currentStage === stage) {
      return <HourglassEmpty color="primary" />;
    }

    // Not yet reached this stage
    return <HourglassEmpty color="disabled" />;
  };

  const getStageOrder = (stage: string): number => {
    const order: Record<string, number> = {
      loading: 1,
      extracting: 2,
      generating: 3,
      storing: 4,
    };
    return order[stage] || 0;
  };

  const toggleArtifactType = (type: CurationArtifactTypeAPI) => {
    setSelectedArtifactTypes(prev => {
      const newSet = new Set(prev);
      if (newSet.has(type)) {
        newSet.delete(type);
      } else {
        newSet.add(type);
      }
      return newSet;
    });
  };

  const selectAllArtifacts = () => {
    setSelectedArtifactTypes(new Set(ARTIFACT_TYPES.map(t => t.value)));
  };

  const deselectAllArtifacts = () => {
    setSelectedArtifactTypes(new Set());
  };

  const toggleSessionSelection = (sessionId: string) => {
    setSelectedSessions(prev => {
      const newSet = new Set(prev);
      if (newSet.has(sessionId)) {
        newSet.delete(sessionId);
      } else {
        newSet.add(sessionId);
      }
      return newSet;
    });
  };

  const selectAllSessions = () => {
    const allIds = allSessions.map(s => s.id);
    setSelectedSessions(new Set(allIds));
  };

  const deselectAllSessions = () => {
    setSelectedSessions(new Set());
  };

  const resetModal = () => {
    setBatchResult(null);
    completedToastsRef.current.clear(); // Reset toast tracker
    processedMessagesRef.current.clear(); // Reset message deduplication
    setCurationType(CurationType.TRANSCRIPT);
    setExportFormat('markdown');
    setSelectedArtifactTypes(new Set(ARTIFACT_TYPES.map(t => t.value)));
    setSelectedSessions(new Set());
    setSearchQuery('');
    setShowEmailModal(false);
    setEmailRecipients(['']);
    setEmailMessage('');
    setCustomNotebookName('');
  };

  const allSessions = sessionsData?.pages.flatMap(page => page.data) ?? [];

  const handleClose = () => {
    const allDone = batchResult
      ? batchResult.completedCount + batchResult.failedCount === batchResult.batchTotal
      : true;

    if (curateNotebooks.isPending && !allDone) {
      if (window.confirm('Curation is in progress. Are you sure you want to cancel?')) {
        resetModal();
        onClose();
      }
    } else {
      resetModal();
      onClose();
    }
  };

  return (
    <>
      <Modal open={open} onClose={handleClose}>
        <ModalDialog size="md" sx={{ width: 600, maxWidth: '90vw' }}>
          <DialogTitle>
            <AutoAwesome sx={{ mr: 1 }} />
            Curate Notebook
          </DialogTitle>

          <DialogContent sx={{ overflow: 'auto', maxHeight: '70vh' }}>
            <Stack spacing={2}>
              {!batchResult && (
                <>
                  {/* Multi-Session Selector */}
                  <Stack spacing={1}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <FormLabel>Select Sessions to Curate</FormLabel>
                      <Box sx={{ display: 'flex', gap: 1 }}>
                        <Button size="sm" variant="plain" onClick={selectAllSessions} data-testid="select-all-sessions">
                          Select All
                        </Button>
                        <Button
                          size="sm"
                          variant="plain"
                          onClick={deselectAllSessions}
                          data-testid="deselect-all-sessions"
                        >
                          Deselect All
                        </Button>
                      </Box>
                    </Box>

                    {/* Search bar */}
                    <Autocomplete
                      placeholder="Search sessions..."
                      inputValue={searchQuery}
                      onInputChange={(_, newValue) => setSearchQuery(newValue)}
                      options={[]}
                      freeSolo
                      startDecorator={<MenuBook />}
                      data-testid="curate-session-search"
                    />

                    {/* Scrollable session list with checkboxes */}
                    <Box
                      sx={{
                        maxHeight: '300px',
                        overflowY: 'auto',
                        border: '1px solid',
                        borderColor: 'neutral.outlinedBorder',
                        borderRadius: 'sm',
                        p: 1,
                      }}
                      onScroll={(event: React.UIEvent<HTMLDivElement>) => {
                        const box = event.currentTarget;
                        if (box.scrollTop + box.clientHeight >= box.scrollHeight - 10 && hasNextPage) {
                          fetchNextPage();
                        }
                      }}
                    >
                      {isLoadingSessions && allSessions.length === 0 ? (
                        <Typography level="body-sm" sx={{ textAlign: 'center', p: 2 }}>
                          Loading sessions...
                        </Typography>
                      ) : allSessions.length === 0 ? (
                        <Typography level="body-sm" sx={{ textAlign: 'center', p: 2 }}>
                          No sessions found
                        </Typography>
                      ) : (
                        <List size="sm">
                          {allSessions.map(session => (
                            <ListItem
                              key={session.id}
                              sx={{
                                cursor: 'pointer',
                                borderRadius: 'sm',
                                '&:hover': {
                                  bgcolor: 'background.level1',
                                },
                              }}
                              onClick={() => toggleSessionSelection(session.id)}
                              data-testid={`curate-session-list-item-${session.name}`}
                            >
                              <Checkbox
                                checked={selectedSessions.has(session.id)}
                                onChange={() => toggleSessionSelection(session.id)}
                                sx={{ pointerEvents: 'none' }}
                                data-testid={`curate-session-checkbox-${session.name}`}
                              />
                              <ListItemContent>
                                <Typography level="body-sm">{formatSessionTitle(session.name)}</Typography>
                                {session.createdAt && (
                                  <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                                    {new Date(session.createdAt).toLocaleDateString()}
                                  </Typography>
                                )}
                              </ListItemContent>
                            </ListItem>
                          ))}
                        </List>
                      )}
                    </Box>
                  </Stack>

                  {/* Custom Notebook Name */}
                  <FormControl>
                    <FormLabel>Notebook Name (Optional)</FormLabel>
                    <Input
                      placeholder="Leave empty to use default naming"
                      value={customNotebookName}
                      onChange={e => setCustomNotebookName(e.target.value)}
                      data-testid="custom-notebook-name-input"
                    />
                    <Typography level="body-xs" sx={{ mt: 0.5, color: 'text.tertiary' }}>
                      Default format: curated-notebook-[session-id]
                    </Typography>
                  </FormControl>

                  {selectedSessions.size > 0 && (
                    <>
                      <Alert color="primary" variant="soft">
                        <Stack spacing={1}>
                          <Typography level="body-sm">
                            <strong>Selected:</strong> {selectedSessions.size} session(s)
                          </Typography>
                          <Typography level="body-sm">
                            Choose how to curate your conversation(s) into shareable markdown documents.
                          </Typography>
                        </Stack>
                      </Alert>

                      {/* Credits Display */}
                      <Alert
                        color={hasInsufficientCredits ? 'danger' : 'success'}
                        variant="soft"
                        data-testid="credits-display-alert"
                      >
                        <Stack spacing={1}>
                          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <Typography level="body-sm">
                              <strong>Current Credits:</strong>
                            </Typography>
                            <Typography level="body-sm" sx={{ fontWeight: 600 }} data-testid="current-credits-value">
                              {currentCredits.toLocaleString()} credits
                            </Typography>
                          </Box>
                          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <Typography level="body-sm">
                              <strong>Estimated Cost:</strong>
                            </Typography>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                              <Chip size="sm" variant="soft" color="neutral">
                                Est.
                              </Chip>
                              <Typography level="body-sm" sx={{ fontWeight: 600 }} data-testid="estimated-cost-value">
                                {totalEstimatedCost.toLocaleString()} credits
                              </Typography>
                            </Box>
                          </Box>
                          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <Typography level="body-sm">
                              <strong>Remaining After:</strong>
                            </Typography>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                              <Chip size="sm" variant="soft" color="neutral">
                                Est.
                              </Chip>
                              <Typography
                                level="body-sm"
                                sx={{ fontWeight: 600 }}
                                data-testid="remaining-credits-value"
                              >
                                {Math.max(0, currentCredits - totalEstimatedCost).toLocaleString()} credits
                              </Typography>
                            </Box>
                          </Box>
                          {hasInsufficientCredits && (
                            <Typography
                              level="body-xs"
                              sx={{ color: 'danger.plainColor', mt: 0.5 }}
                              data-testid="insufficient-credits-warning"
                            >
                              ⚠️ Insufficient credits. Please purchase more credits to continue.
                            </Typography>
                          )}
                        </Stack>
                      </Alert>
                    </>
                  )}

                  <FormControl>
                    <FormLabel>Curation Type</FormLabel>
                    <RadioGroup value={curationType} onChange={e => setCurationType(e.target.value as CurationType)}>
                      <Box
                        onClick={() => setCurationType(CurationType.TRANSCRIPT)}
                        sx={{
                          p: 2,
                          borderRadius: 'sm',
                          border: '1px solid',
                          borderColor:
                            curationType === CurationType.TRANSCRIPT ? 'success.500' : 'neutral.outlinedBorder',
                          transition: 'all 0.2s ease',
                          cursor: 'pointer',
                          '&:hover': {
                            borderColor:
                              curationType === CurationType.TRANSCRIPT ? 'success.600' : 'neutral.outlinedHoverBorder',
                          },
                        }}
                      >
                        <Box>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Radio
                              value={CurationType.TRANSCRIPT}
                              data-testid="curate-radio-raw-transcript"
                              sx={{
                                '--Radio-size': '20px',
                                gap: 1.5,
                                pointerEvents: 'none',
                                bgcolor: 'transparent',
                                '&:hover': {
                                  bgcolor: 'transparent',
                                },
                                '&::before': {
                                  display: 'none',
                                },
                                border: 'none !important',
                                outline: 'none !important',
                                boxShadow: 'none !important',
                              }}
                            />
                            <Description fontSize="small" />
                            <Typography level="title-sm">Raw Transcript</Typography>
                          </Stack>
                          <Typography level="body-xs" sx={{ mt: 1, ml: '28px' }}>
                            Complete conversation with all messages, code, and artifacts. Perfect for HR, legal, or
                            compliance needs.
                          </Typography>
                          <Typography level="body-xs" sx={{ mt: 0.5, ml: '28px', color: 'text.tertiary' }}>
                            Cost: 100 tokens
                          </Typography>
                        </Box>
                      </Box>
                      <Box
                        onClick={() => setCurationType(CurationType.EXECUTIVE_SUMMARY)}
                        sx={{
                          p: 2,
                          borderRadius: 'sm',
                          border: '1px solid',
                          borderColor:
                            curationType === CurationType.EXECUTIVE_SUMMARY ? 'success.500' : 'neutral.outlinedBorder',
                          transition: 'all 0.2s ease',
                          cursor: 'pointer',
                          '&:hover': {
                            borderColor:
                              curationType === CurationType.EXECUTIVE_SUMMARY
                                ? 'success.600'
                                : 'neutral.outlinedHoverBorder',
                          },
                        }}
                      >
                        <Box>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Radio
                              value={CurationType.EXECUTIVE_SUMMARY}
                              data-testid="curate-radio-executive-summary"
                              sx={{
                                '--Radio-size': '20px',
                                gap: 1.5,
                                pointerEvents: 'none',
                                bgcolor: 'transparent',
                                '&:hover': {
                                  bgcolor: 'transparent',
                                },
                                '&::before': {
                                  display: 'none',
                                },
                                border: 'none !important',
                                outline: 'none !important',
                                boxShadow: 'none !important',
                              }}
                            />
                            <Psychology fontSize="small" />
                            <Typography level="title-sm">Executive Summary (AI-Powered)</Typography>
                          </Stack>
                          <Typography level="body-xs" sx={{ mt: 1, ml: '28px' }}>
                            AI-generated insights, key decisions, and organized artifacts. Ideal for knowledge sharing
                            and team collaboration.
                          </Typography>
                          <Typography level="body-xs" sx={{ mt: 0.5, ml: '28px', color: 'text.tertiary' }}>
                            Cost: ~100-2000+ tokens (varies significantly by conversation length)
                          </Typography>
                        </Box>
                      </Box>
                    </RadioGroup>
                  </FormControl>

                  {/* Warning for Executive Summary with long notebooks */}
                  {curationType === CurationType.EXECUTIVE_SUMMARY && selectedSessions.size > 0 && (
                    <Alert color="warning" variant="soft" data-testid="executive-summary-warning">
                      <Stack spacing={1}>
                        <Typography level="body-sm" sx={{ fontWeight: 600 }}>
                          ⚠️ Credit Usage Warning
                        </Typography>
                        <Typography level="body-xs">
                          Executive Summary uses AI to analyze your entire conversation. Long notebooks with many
                          messages may consume significantly more credits (500-2000+ tokens depending on length).
                        </Typography>
                        <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                          Consider using &quot;Raw Transcript&quot; for very long conversations to save credits.
                        </Typography>
                      </Stack>
                    </Alert>
                  )}

                  {/* Advanced Settings - Artifact Filtering */}
                  <AccordionGroup>
                    <Accordion>
                      <AccordionSummary>
                        <Typography level="title-sm">Advanced Settings</Typography>
                      </AccordionSummary>
                      <AccordionDetails>
                        <Stack spacing={2}>
                          {/* Artifact Type Selection */}
                          <Stack spacing={1}>
                            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <FormLabel>Include Artifact Types</FormLabel>
                              <Box sx={{ display: 'flex', gap: 1 }}>
                                <Button
                                  size="sm"
                                  variant="plain"
                                  onClick={selectAllArtifacts}
                                  data-testid="select-all-artifacts"
                                >
                                  Select All
                                </Button>
                                <Button
                                  size="sm"
                                  variant="plain"
                                  onClick={deselectAllArtifacts}
                                  data-testid="deselect-all-artifacts"
                                >
                                  Deselect All
                                </Button>
                              </Box>
                            </Box>
                            <Box
                              sx={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(2, 1fr)',
                                gap: 1,
                                mt: 1,
                              }}
                            >
                              {ARTIFACT_TYPES.map(artifactType => (
                                <Box
                                  key={artifactType.value}
                                  sx={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 1,
                                    cursor: 'pointer',
                                    p: 0.5,
                                    borderRadius: 'sm',
                                    '&:hover': {
                                      bgcolor: 'background.level1',
                                    },
                                  }}
                                  onClick={() => toggleArtifactType(artifactType.value)}
                                >
                                  <Checkbox
                                    checked={selectedArtifactTypes.has(artifactType.value)}
                                    onChange={() => toggleArtifactType(artifactType.value)}
                                    data-testid={`artifact-checkbox-${artifactType.value.toLowerCase()}`}
                                    sx={{ pointerEvents: 'none' }}
                                  />
                                  {React.cloneElement(artifactType.icon, {
                                    fontSize: 'small',
                                    sx: { fontSize: '18px' },
                                  })}
                                  <Typography level="body-sm">{artifactType.label}</Typography>
                                </Box>
                              ))}
                            </Box>
                            {selectedArtifactTypes.size === 0 && (
                              <Alert color="warning" size="sm">
                                <Typography level="body-xs">
                                  No artifact types selected. Your notebook will not include any artifacts.
                                </Typography>
                              </Alert>
                            )}
                          </Stack>

                          {/* Export Format Selection */}
                          <FormControl>
                            <FormLabel>Export Format</FormLabel>
                            <Typography level="body-xs" sx={{ mb: 1, color: 'text.tertiary' }}>
                              Choose the format for your downloaded notebook
                            </Typography>
                            <Select
                              value={exportFormat}
                              onChange={(_, value) => value && setExportFormat(value)}
                              data-testid="export-format-select"
                            >
                              <Option value="markdown">
                                <Stack spacing={0.5}>
                                  <Typography level="body-sm" data-testid="curate-export-format-markdown">
                                    Markdown (.md)
                                  </Typography>
                                  <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                                    {' '}
                                    Plain text with formatting, best for GitHub/documentation
                                  </Typography>
                                </Stack>
                              </Option>
                              <Option value="txt">
                                <Stack spacing={0.5}>
                                  <Typography level="body-sm" data-testid="curate-export-format-txt">
                                    Plain Text (.txt)
                                  </Typography>
                                  <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                                    {' '}
                                    Clean text without formatting, compatible with any text editor
                                  </Typography>
                                </Stack>
                              </Option>
                              <Option value="html">
                                <Stack spacing={0.5}>
                                  <Typography level="body-sm" data-testid="curate-export-format-html">
                                    HTML (.html)
                                  </Typography>
                                  <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                                    {' '}
                                    Web page format, viewable in any browser
                                  </Typography>
                                </Stack>
                              </Option>
                            </Select>
                          </FormControl>
                        </Stack>
                      </AccordionDetails>
                    </Accordion>
                  </AccordionGroup>
                </>
              )}

              {batchResult && (
                <Box>
                  <Stack spacing={2}>
                    {/* Batch Progress Summary */}
                    <Alert color="primary" variant="soft">
                      <Stack spacing={1}>
                        <Typography level="body-sm" sx={{ fontWeight: 600 }}>
                          Batch Progress: {batchResult.completedCount + batchResult.failedCount} /{' '}
                          {batchResult.batchTotal}
                        </Typography>
                        <Box sx={{ display: 'flex', gap: 2 }}>
                          <Chip size="sm" color="success" variant="soft">
                            ✓ {batchResult.completedCount} Completed
                          </Chip>
                          {batchResult.failedCount > 0 && (
                            <Chip size="sm" color="danger" variant="soft">
                              ✗ {batchResult.failedCount} Failed
                            </Chip>
                          )}
                          <Chip size="sm" color="neutral" variant="soft">
                            ⏳ {batchResult.batchTotal - batchResult.completedCount - batchResult.failedCount} Pending
                          </Chip>
                        </Box>
                      </Stack>
                    </Alert>

                    {/* Individual Session Progress */}
                    <AccordionGroup>
                      {batchResult.sessions.map((session, index) => (
                        <Accordion key={session.sessionId} defaultExpanded={batchResult.sessions.length <= 3}>
                          <AccordionSummary>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1 }}>
                              {session.status === 'completed' && <CheckCircle color="success" fontSize="small" />}
                              {session.status === 'failed' && <ErrorIcon color="error" fontSize="small" />}
                              {session.status !== 'completed' && session.status !== 'failed' && (
                                <HourglassEmpty color="primary" fontSize="small" />
                              )}
                              <Typography level="body-sm" sx={{ flex: 1 }}>
                                {session.sessionName}
                              </Typography>
                              <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                                {session.percentage}%
                              </Typography>
                            </Box>
                          </AccordionSummary>
                          <AccordionDetails>
                            <Stack spacing={2}>
                              {/* Session Progress Bar */}
                              <Box>
                                <Typography level="body-xs" sx={{ mb: 1 }}>
                                  {session.message || 'Processing...'}
                                </Typography>
                                <LinearProgress
                                  determinate
                                  value={session.percentage || 0}
                                  sx={{
                                    borderRadius: 4,
                                    bgcolor: 'neutral.softBg',
                                  }}
                                  color={
                                    session.status === 'completed'
                                      ? 'success'
                                      : session.status === 'failed'
                                        ? 'danger'
                                        : 'primary'
                                  }
                                />
                              </Box>

                              {/* Stage Progress */}
                              <List size="sm">
                                <ListItem>
                                  <ListItemDecorator>{getStageIcon('loading', session)}</ListItemDecorator>
                                  <Typography level="body-xs">Loading conversation history</Typography>
                                  {session.messagesProcessed && (
                                    <Typography level="body-xs" sx={{ ml: 'auto' }}>
                                      {session.messagesProcessed} messages
                                    </Typography>
                                  )}
                                </ListItem>
                                <ListItem>
                                  <ListItemDecorator>{getStageIcon('extracting', session)}</ListItemDecorator>
                                  <Typography level="body-xs">Extracting code and artifacts</Typography>
                                  {session.artifactsFound !== undefined && (
                                    <Typography level="body-xs" sx={{ ml: 'auto' }}>
                                      {session.artifactsFound} artifacts
                                    </Typography>
                                  )}
                                </ListItem>
                                <ListItem>
                                  <ListItemDecorator>{getStageIcon('generating', session)}</ListItemDecorator>
                                  <Typography level="body-xs">Generating curated document</Typography>
                                </ListItem>
                                <ListItem>
                                  <ListItemDecorator>{getStageIcon('storing', session)}</ListItemDecorator>
                                  <Typography level="body-xs">Saving to your files</Typography>
                                </ListItem>
                              </List>

                              {/* Credits Used */}
                              {session.status === 'completed' && session.tokensDeducted !== undefined && (
                                <Alert
                                  color="success"
                                  size="sm"
                                  variant="soft"
                                  data-testid={`session-credits-used-${session.sessionId}`}
                                >
                                  <Typography level="body-xs">
                                    <strong>Credits Used:</strong> {session.tokensDeducted.toLocaleString()} credits
                                  </Typography>
                                </Alert>
                              )}

                              {/* Error Message */}
                              {session.status === 'failed' && session.errorMessage && (
                                <Alert color="danger" size="sm">
                                  {session.errorMessage}
                                </Alert>
                              )}
                            </Stack>
                          </AccordionDetails>
                        </Accordion>
                      ))}
                    </AccordionGroup>

                    {/* Final Success Alert */}
                    {batchResult.completedCount + batchResult.failedCount === batchResult.batchTotal && (
                      <Alert
                        color={
                          batchResult.failedCount === 0
                            ? 'success'
                            : batchResult.completedCount === 0
                              ? 'danger'
                              : 'warning'
                        }
                        startDecorator={batchResult.failedCount === 0 ? <CheckCircle /> : <ErrorIcon />}
                      >
                        <Stack spacing={1}>
                          <Typography level="body-sm" sx={{ fontWeight: 600 }}>
                            Batch curation complete!
                          </Typography>
                          <Typography level="body-xs">
                            {batchResult.completedCount} successful, {batchResult.failedCount} failed.
                            {batchResult.completedCount > 0 && ' Your curated notebooks are ready to download.'}
                          </Typography>
                          {batchResult.completedCount > 0 && (
                            <Typography level="body-xs" sx={{ mt: 0.5 }} data-testid="batch-total-credits-used">
                              <strong>Total Credits Used:</strong>{' '}
                              {batchResult.sessions
                                .filter(s => s.status === 'completed' && s.tokensDeducted)
                                .reduce((sum, s) => sum + (s.tokensDeducted || 0), 0)
                                .toLocaleString()}{' '}
                              credits
                            </Typography>
                          )}
                        </Stack>
                      </Alert>
                    )}
                  </Stack>
                </Box>
              )}
            </Stack>
          </DialogContent>

          <DialogActions>
            <Button variant="plain" color="neutral" onClick={handleClose}>
              {batchResult && batchResult.completedCount + batchResult.failedCount === batchResult.batchTotal
                ? 'Close'
                : 'Cancel'}
            </Button>

            {batchResult && batchResult.completedCount > 0 && (
              <>
                <Button
                  variant="outlined"
                  color="primary"
                  onClick={() => setShowEmailModal(true)}
                  startDecorator={<EmailIcon />}
                  disabled={sendNotebooksEmail.isPending}
                  data-testid="curate-email-btn"
                >
                  Email ({batchResult.completedCount})
                </Button>
                <Button
                  variant="solid"
                  color="success"
                  onClick={handleDownload}
                  loading={downloadNotebooks.isPending}
                  disabled={downloadNotebooks.isPending}
                  data-testid="curate-download-btn"
                >
                  Download ({batchResult.completedCount})
                </Button>
              </>
            )}

            {!batchResult && (
              <Button
                variant="solid"
                color="primary"
                onClick={handleCurate}
                disabled={selectedSessions.size === 0 || curateNotebooks.isPending || hasInsufficientCredits}
                loading={curateNotebooks.isPending}
                data-testid="start-curation-btn"
              >
                Start Curation {selectedSessions.size > 0 && `(${selectedSessions.size})`}
              </Button>
            )}
          </DialogActions>
        </ModalDialog>
      </Modal>

      {/* Email Modal */}
      <Modal open={showEmailModal} onClose={() => setShowEmailModal(false)}>
        <ModalDialog size="md" sx={{ width: 500, maxWidth: '90vw' }}>
          <DialogTitle>
            <EmailIcon sx={{ mr: 1 }} />
            Send Curated Notebooks via Email
          </DialogTitle>

          <DialogContent sx={{ overflow: 'auto', maxHeight: '70vh' }}>
            <Stack spacing={2}>
              <Alert color="primary" variant="soft" size="sm">
                <Typography level="body-sm">
                  Sending {batchResult?.completedCount} curated notebook
                  {(batchResult?.completedCount ?? 0) > 1 ? 's' : ''} as {exportFormat.toUpperCase()} attachment
                  {(batchResult?.completedCount ?? 0) > 1 ? 's' : ''}.
                </Typography>
              </Alert>

              <FormControl>
                <FormLabel>Recipient Email Addresses</FormLabel>
                <Stack spacing={1}>
                  {emailRecipients.map((email, index) => (
                    <Box key={index} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                      <Input
                        type="email"
                        placeholder="recipient@example.com"
                        value={email}
                        onChange={e => updateEmailRecipient(index, e.target.value)}
                        sx={{ flex: 1 }}
                        autoFocus={index === 0}
                        data-testid={`curate-email-recipient-${index}`}
                      />
                      {emailRecipients.length > 1 && (
                        <Button
                          size="sm"
                          variant="plain"
                          color="danger"
                          onClick={() => removeEmailRecipient(index)}
                          sx={{ minWidth: 'auto', px: 1 }}
                        >
                          <CloseIcon fontSize="small" />
                        </Button>
                      )}
                    </Box>
                  ))}
                  <Button
                    size="sm"
                    variant="outlined"
                    startDecorator={<AddIcon />}
                    onClick={addEmailRecipient}
                    sx={{ alignSelf: 'flex-start' }}
                  >
                    Add Recipient
                  </Button>
                </Stack>
              </FormControl>

              <FormControl>
                <FormLabel>Personal Message (Optional)</FormLabel>
                <Textarea
                  placeholder="Add a personal message to include in the email..."
                  value={emailMessage}
                  onChange={e => setEmailMessage(e.target.value)}
                  minRows={3}
                  maxRows={6}
                />
              </FormControl>

              {batchResult && batchResult.completedCount > 0 && (
                <Box
                  sx={{
                    p: 2,
                    borderRadius: 'sm',
                    bgcolor: 'background.level1',
                  }}
                >
                  <Typography level="body-sm" sx={{ fontWeight: 600, mb: 1 }}>
                    Notebooks to send:
                  </Typography>
                  <List size="sm">
                    {batchResult.sessions
                      .filter(s => s.status === 'completed')
                      .map(session => (
                        <ListItem key={session.sessionId}>
                          <ListItemDecorator>
                            <CheckCircle color="success" fontSize="small" />
                          </ListItemDecorator>
                          <Typography level="body-sm">{session.sessionName}</Typography>
                        </ListItem>
                      ))}
                  </List>
                </Box>
              )}
            </Stack>
          </DialogContent>

          <DialogActions>
            <Button
              variant="plain"
              color="neutral"
              onClick={() => setShowEmailModal(false)}
              disabled={sendNotebooksEmail.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="solid"
              color="primary"
              onClick={handleSendEmail}
              loading={sendNotebooksEmail.isPending}
              disabled={sendNotebooksEmail.isPending}
              startDecorator={<EmailIcon />}
              data-testid="curate-email-send-btn"
            >
              Send Email
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </>
  );
};

export default memo(NotebookCurationModal);
