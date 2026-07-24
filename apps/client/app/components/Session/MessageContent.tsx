import ConfirmActionModal from '@client/app/components/ConfirmActionModal';
import CopyTextButton from '@client/app/components/Session/CopyTextButton';
import DownloadMenu from '../common/DownloadMenu';
import PromptReplies from '@client/app/components/Session/PromptReplies';
import ReasoningDisclosure from '@client/app/components/Session/AgentExecution/ReasoningDisclosure';
import AutoRouteBadge from '@client/app/components/Session/AgentExecution/AutoRouteBadge';
import UserPrompt from '@client/app/components/Session/UserPrompt';
import ResearchModeResponseDisplay from '@client/app/components/Session/ResearchModeResponseDisplay';
import { useSessions, useWorkBenchFiles, useWorkBenchActions } from '@client/app/contexts/SessionsContext';
import { useUser } from '@client/app/contexts/UserContext';
import { IChatHistoryItem, SettingKey } from '@bike4mind/common';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import { Menu, MenuItem, ListItemDecorator } from '@mui/joy';
import Box from '@mui/joy/Box';
import Divider from '@mui/joy/Divider';
import Dropdown from '@mui/joy/Dropdown';
import IconButton from '@mui/joy/IconButton';
import MenuButton from '@mui/joy/MenuButton';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import Chip from '@mui/joy/Chip';
import React, { lazy, memo, useCallback, useEffect, useMemo, useState, Suspense } from 'react';

const TavernArtifactRenderer = lazy(() => import('../tavern/TavernArtifactRenderer'));
import { useForkSession, useSnipSession } from '@client/app/hooks/data/sessions';
import { Refresh } from '@mui/icons-material';
import { useLLM } from '@client/app/contexts/LLMContext';
import CodeIcon from '@mui/icons-material/Code';
import ForkRightIcon from '@mui/icons-material/ForkRight';
import StartIcon from '@mui/icons-material/Start';
import BugReportIcon from '@mui/icons-material/BugReport';
import { useNavigate } from '@tanstack/react-router';
import BugReportModal from '@client/app/components/BugReportModal';
import { useSubscribeChatCompletion } from '@client/app/hooks/useSubscribeChatCompletion';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { useGetFabFilesByQuestId } from '@client/app/hooks/data/fabFiles';
import { Save as SaveIcon, Add as AddIcon } from '@mui/icons-material';
import { DataLakeIcon, DATA_LAKE } from '@client/app/components/datalake/dataLakeBranding';
import { useSendToDataLakeStore } from '@client/app/stores/useSendToDataLakeStore';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import { usePromptMetaInspector } from '@client/app/components/Session/PromptMetaInspector';
import HiveIcon from '@mui/icons-material/Hive';
import ContentPreviewModal from '@client/app/components/ProfileModal/ContentPreviewModal';
import { Article as ArticleIcon } from '@mui/icons-material';
import { useSettingsFromServer } from '@client/app/hooks/data/settings';
import EditIcon from '@mui/icons-material/Edit';
import Bike4MindIcon from '@client/app/components/svgs/icons/Bike4MindIcon';
import { APP_NAME } from '@client/config/general';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import ShareIcon from '@mui/icons-material/Share';
import { usePublishShare } from '@client/app/hooks/usePublishShare';
import { replyPublisher } from '@client/app/utils/publishApi';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import PushPinIcon from '@mui/icons-material/PushPin';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import { useGetQuest, useUpdateQuest } from '@client/app/hooks/data/quests';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { extractReplies } from '@client/app/utils/replyUtils';
import { detectChatContentType } from '@client/app/utils/contentTypes';
import { saveToFileAndWorkbench } from '@client/app/utils/fabFileUtils';
import ToolsUsed from '@client/app/components/Session/ToolsUsed';
import { useMessageEditMode } from '@client/app/hooks/useMessageEditMode';

const ModelChip: React.FC<{ displayName: string }> = ({ displayName }) => (
  <Chip
    className="model-chip-web"
    size="sm"
    variant="soft"
    sx={theme => ({
      bgcolor: theme.palette.fileBrowser.statusChip.backgroundColor,
      color: theme.palette.fileBrowser.statusChip.textColor,
      fontSize: '13px',
      height: '24px',
      border: `1px solid ${theme.palette.fileBrowser.statusChip.borderColor}`,
      px: '8px',
    })}
  >
    {displayName}
  </Chip>
);

const DeleteMessageModal = ({
  onConfirmDelete,
  onCancelDelete,
}: {
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) => {
  const title = 'Delete Message?';
  const description = 'Are you sure you want to delete this message? This action cannot be undone.';

  return (
    <ConfirmActionModal
      title={title}
      description={description}
      onGoBackward={onCancelDelete}
      onGoForward={onConfirmDelete}
      forwardButtonText="Delete"
      backwardButtonText="Cancel"
    />
  );
};

export interface ContentProps {
  sessionId: string;
  messageData: IChatHistoryItem;
  index: number;
  mode?: string;
  onDelete: (messageData: IChatHistoryItem) => void;
  onPinToggle: (messageData: IChatHistoryItem) => void;
  onSendMessage: (
    messageData: Partial<IChatHistoryItem>,
    { isRetry, isImageEdit, isVariation }: { isRetry?: boolean; isImageEdit?: boolean; isVariation?: boolean }
  ) => Promise<void>;
  search?: string;
  isLastMessage: boolean;
  model: string;
  totalMessages: number;
  isExpanded?: boolean;
  chatCompletion?: ReturnType<typeof useSubscribeChatCompletion>['chatCompletion'];
  canUseAdminTools: boolean;
}

// TODO: support mode
const MessageContent: React.FC<ContentProps> = memo(
  ({
    messageData,
    index,
    onDelete,
    onPinToggle,
    onSendMessage,
    isLastMessage,
    search,
    sessionId,
    totalMessages,
    chatCompletion,
    canUseAdminTools,
  }) => {
    const { currentUser } = useUser();
    const queryClient = useQueryClient();
    const { data: modelInfoRepo } = useModelInfo();
    const forkSession = useForkSession();
    const snipSession = useSnipSession();
    const updateQuest = useUpdateQuest(queryClient);
    const { currentSession, setCurrentSession } = useSessions();
    const workBenchFiles = useWorkBenchFiles(sessionId);
    const { setWorkBenchFiles } = useWorkBenchActions();
    const [fetchQuestEnabled, setFetchQuestEnabled] = useState(false);
    const { data: fetchedQuest, isLoading: isFetchingQuest } = useGetQuest(
      sessionId,
      messageData.id!,
      fetchQuestEnabled
    );
    // Fetch message-level files for this quest. The hook itself guards against
    // optimistic placeholder ids, so the caller only needs to gate on whether the
    // message actually has files to fetch.
    const { data: questFiles = [] } = useGetFabFilesByQuestId(messageData.id!, {
      enabled: !!messageData.fabFileIds?.length,
    });
    const researchMode = useLLM(state => state.researchMode);
    const setLLM = useLLM(state => state.setLLM);

    const handleSaveAsFile = useCallback(
      async (messageData: IChatHistoryItem) => {
        if (!messageData.replies?.[0]) return;

        const content = extractReplies(messageData)[0];
        const contentType = detectChatContentType(content);

        try {
          const fileName = `saved_reply_${Date.now()}.${contentType === 'Markdown' ? 'md' : 'txt'}`;
          const newWorkBenchFiles = await saveToFileAndWorkbench(
            contentType,
            fileName,
            content,
            workBenchFiles,
            sessionId,
            currentSession
          );

          setWorkBenchFiles(sessionId, newWorkBenchFiles);

          if (currentSession) {
            const knowledgeIds = newWorkBenchFiles.map(f => f.id);
            const updatedSession = { ...currentSession, knowledgeIds };
            setCurrentSession(updatedSession);
          }

          // Toast is shown by saveToFileAndWorkbench with the renamed filename
        } catch (error) {
          console.error('Error saving file:', error);
          toast.error('Failed to save file');
        }
      },
      [workBenchFiles, setWorkBenchFiles, currentSession, setCurrentSession, sessionId]
    );

    // Opens the app-level Send-to-Data-Lake modal (singleton in ProviderBundle) for one reply.
    const openSendToDataLake = useSendToDataLakeStore(s => s.open);
    const { isFeatureEnabled } = useAdminSettingsCache();

    const handleSendReplyToDataLake = useCallback(
      (messageData: IChatHistoryItem) => {
        const content = extractReplies(messageData)[0];
        if (!content) return;
        const isMd = detectChatContentType(content) === 'Markdown';
        openSendToDataLake({
          content,
          fileName: `reply_${messageData.id ?? 'message'}.${isMd ? 'md' : 'txt'}`,
          mimeType: isMd ? 'text/markdown' : 'text/plain',
          sourceLabel: 'reply',
        });
      },
      [openSendToDataLake]
    );

    const [showSyntaxHighlight, setShowSyntaxHighlight] = useState<boolean>(false);
    const [showDeleteMessageModal, setShowDeleteMessageModal] = useState<boolean>(false);
    const [showForkModal, setShowForkModal] = useState<boolean>(false);
    const [showSnipModal, setShowSnipModal] = useState<boolean>(false);
    const [messageToDelete, setMessageToDelete] = useState<IChatHistoryItem | null>(null);
    const [isMobile, setIsMobile] = useState<boolean>(false);
    const navigate = useNavigate();
    const openPromptMetaInspector = usePromptMetaInspector(state => state.setPromptMeta);
    const triggerEdit = useMessageEditMode(s => s.triggerEdit);

    const [isBugReportModalOpen, setIsBugReportModalOpen] = useState(false);
    const [showBlogPreviewModal, setShowBlogPreviewModal] = useState(false);
    const [blogPreviewContent, setBlogPreviewContent] = useState<string>('');
    const [blogPreviewTitle, setBlogPreviewTitle] = useState<string>('');
    const [blogPreviewSummary, setBlogPreviewSummary] = useState<string>('');
    const [blogPreviewTags, setBlogPreviewTags] = useState<string[]>([]);
    const { data: serverSettings } = useSettingsFromServer();

    const adminSettings = useMemo(
      () =>
        (serverSettings || []).reduce(
          (acc, setting) => {
            acc[setting.settingName] = setting.settingValue;
            return acc;
          },
          {} as Record<SettingKey, string>
        ),
      [serverSettings]
    );

    const handleOpenBugReportModal = useCallback(() => {
      setIsBugReportModalOpen(true);
    }, []);

    const handlePreviewAsBlog = useCallback(
      (message: IChatHistoryItem) => {
        const replyText = message.replies?.[0] || message.reply || '';
        setBlogPreviewContent(replyText);

        // Pre-fill with notebook metadata if available
        if (currentSession) {
          setBlogPreviewTitle(currentSession.name || '');
          setBlogPreviewTags(currentSession.tags?.map(t => t.name) || []);
          const summary = currentSession.summary || '';
          setBlogPreviewSummary(summary.substring(0, 100));
        } else {
          setBlogPreviewTitle('');
          setBlogPreviewTags([]);
          setBlogPreviewSummary('');
        }

        setShowBlogPreviewModal(true);
      },
      [currentSession]
    );

    const handleCloseBugReportModal = useCallback(() => {
      setIsBugReportModalOpen(false);
    }, []);

    useEffect(() => {
      // Check if the device is mobile
      const handleResize = () => {
        setIsMobile(window.innerWidth < 768);
      };
      handleResize(); // Initial check on mount
      window.addEventListener('resize', handleResize);
      return () => {
        window.removeEventListener('resize', handleResize);
      };
    }, []);

    const handleOpenPromptMetaInspector = useCallback(() => {
      // If we don't have promptMeta, trigger fetching the complete quest from the API
      if (!messageData.id || !sessionId) return;

      // Check if we already have the fetched quest data
      if (fetchedQuest?.promptMeta) {
        // Add quest timestamps to existing promptMeta
        const promptMetaWithTimestamps = {
          ...fetchedQuest.promptMeta,
          createdAt: fetchedQuest.createdAt,
          updatedAt: fetchedQuest.updatedAt,
        };
        openPromptMetaInspector(promptMetaWithTimestamps, fetchedQuest.replies || null);
        return;
      }

      // Enable fetching if not already enabled
      if (!fetchQuestEnabled) {
        setFetchQuestEnabled(true);
        return;
      }

      // If we have fetched quest but no promptMeta, create a basic one
      if (fetchedQuest) {
        const questPromptMeta = {
          questId: fetchedQuest.id,
          promptId: fetchedQuest.id,
          prompt: fetchedQuest.prompt,
          timestamp: fetchedQuest.timestamp,
          session: {
            id: sessionId,
            userId: currentSession?.userId || 'unknown',
          },
          type: fetchedQuest.type,
          status: fetchedQuest.status,
          creditsUsed: fetchedQuest.creditsUsed,
          createdAt: fetchedQuest.createdAt,
          updatedAt: fetchedQuest.updatedAt,
        };
        openPromptMetaInspector(questPromptMeta, fetchedQuest.replies || null);
      }
    }, [messageData.id, sessionId, fetchedQuest, fetchQuestEnabled, openPromptMetaInspector, currentSession]);

    // Use files fetched from the quest API instead of getMessageFiles
    const messageFiles = questFiles;

    // Subscribe to the async upload content-moderation scan result so a sent-message
    // image's "Scanning" placeholder flips live to the real image or the blocked
    // message once the scan resolves. Scoped to this message's own quest-files query,
    // and only invalidated when the event actually concerns one of this message's files.
    const { subscribeToAction } = useWebsocket();
    useEffect(() => {
      const unsubscribe = subscribeToAction('image_moderation_status', async msg => {
        if (msg.action !== 'image_moderation_status') return;
        if (!messageData.fabFileIds?.includes(msg.fabFileId)) return;

        queryClient.invalidateQueries({ queryKey: ['fabFiles', 'quest', messageData.id] });
      });

      return () => {
        unsubscribe();
      };
    }, [subscribeToAction, queryClient, messageData.id, messageData.fabFileIds]);

    // Auto-open inspector when quest is fetched
    useEffect(() => {
      if (fetchQuestEnabled && fetchedQuest && !isFetchingQuest) {
        if (fetchedQuest.promptMeta) {
          // Add quest timestamps to existing promptMeta
          const promptMetaWithTimestamps = {
            ...fetchedQuest.promptMeta,
            createdAt: fetchedQuest.createdAt,
            updatedAt: fetchedQuest.updatedAt,
          };
          openPromptMetaInspector(promptMetaWithTimestamps, fetchedQuest.replies || null);
        } else {
          // Create basic promptMeta if none exists
          const questPromptMeta = {
            questId: fetchedQuest.id,
            promptId: fetchedQuest.id,
            prompt: fetchedQuest.prompt,
            timestamp: fetchedQuest.timestamp,
            session: {
              id: sessionId,
              userId: currentSession?.userId || 'unknown',
            },
            type: fetchedQuest.type,
            status: fetchedQuest.status,
            creditsUsed: fetchedQuest.creditsUsed,
            createdAt: fetchedQuest.createdAt,
            updatedAt: fetchedQuest.updatedAt,
          };
          openPromptMetaInspector(questPromptMeta, fetchedQuest.replies || null);
        }
        setFetchQuestEnabled(false); // Reset for next time
      }
    }, [fetchQuestEnabled, fetchedQuest, isFetchingQuest, openPromptMetaInspector, sessionId, currentSession]);

    const toggleSyntaxHighlight = useCallback(() => {
      setShowSyntaxHighlight(prev => !prev);
    }, []);

    const onConfirmDelete = () => {
      if (messageToDelete) {
        onDelete(messageToDelete);
      }
      setShowDeleteMessageModal(false);
    };

    const onCancelDelete = () => {
      setShowDeleteMessageModal(false);
    };

    const handleDelete = useCallback((messageData: IChatHistoryItem) => {
      setShowDeleteMessageModal(true);
      setMessageToDelete(messageData);
    }, []);

    const handleFork = async (messageData: IChatHistoryItem) => {
      if (!messageData.id) return;

      try {
        const data = await forkSession.mutateAsync({ sessionId, messageId: messageData.id });
        navigate({ to: '/notebooks/$id', params: { id: data?.id || '' } });
      } catch (error) {
        console.log(error);
      }
      setShowForkModal(false);
    };

    const handleSnip = async (messageData: IChatHistoryItem) => {
      if (!messageData.id) return;

      try {
        const data = await snipSession.mutateAsync({ sessionId, messageId: messageData.id });
        navigate({ to: '/notebooks/$id', params: { id: data?.id || '' } });
      } catch (e) {
        console.log(e);
      }
      setShowSnipModal(false);
    };

    const isExpandable = !isLastMessage;

    const isProcessingPrompt = !['done', 'stopped'].includes(messageData.status || '');

    const extractedReplies = useMemo(() => extractReplies(messageData), [messageData]);

    // Publish-and-share: snapshot this reply to a public /p/r URL + social bar.
    const { publishAndShare: publishAndShareReply, modal: shareModal } = usePublishShare();
    // Active account-switcher org (null in personal context). Enables the dialog's Team option
    // and org-scoped publishing; the server re-validates membership before trusting it.
    const selectedAccount = useSelectedAccount(s => s.selectedAccount);
    const activeOrg = selectedAccount && !selectedAccount.personal ? selectedAccount : null;
    // Only offer Team for the org the server will accept: checkScopePermission gates org
    // publishing on user.organizationId, so a multi-org member who selected a different (still
    // valid) org would be offered Team but 403 on publish. Gate the option on the match so the
    // UI never invites a rejected action (fails closed either way).
    const teamOrg = activeOrg && String(activeOrg.id) === String(currentUser?.organizationId) ? activeOrg : null;
    const hasShareableReply = !!(extractedReplies[0] || messageData.reply);
    const handleShareReply = useCallback(() => {
      if (!messageData.id || !sessionId) return;
      void publishAndShareReply({
        publish: replyPublisher({ sessionId, messageId: messageData.id, orgId: teamOrg?.id }),
        ...(teamOrg ? { orgOption: { label: 'Team', hint: `Members of ${teamOrg.name}` } } : {}),
        title: messageData.prompt?.slice(0, 80) || (APP_NAME ? `Shared from ${APP_NAME}` : 'Shared reply'),
        markdown: extractedReplies[0] || messageData.reply || undefined,
      });
    }, [
      messageData.id,
      messageData.prompt,
      messageData.reply,
      sessionId,
      extractedReplies,
      teamOrg,
      publishAndShareReply,
    ]);

    // Get friendly model name from modelInfo repository
    const getModelDisplayName = (modelName: string): string => {
      if (!modelInfoRepo) return modelName;
      const modelInfo = modelInfoRepo.find(m => m.id === modelName);
      return modelInfo?.name || modelName;
    };

    return (
      <Stack
        key={index}
        className="message-content-stack"
        sx={{
          gap: 2,
          width: '100%',
          maxWidth: '100%',
          px: isMobile ? '0px' : '20px',
          overflow: 'visible',
        }}
        data-testid={`message-${messageData.id}`}
      >
        {showDeleteMessageModal && (
          <DeleteMessageModal onConfirmDelete={onConfirmDelete} onCancelDelete={onCancelDelete} />
        )}
        {shareModal}
        {showForkModal && (
          <ConfirmActionModal
            className="session-middle-fork-modal"
            title="Fork Notebook from this Message?"
            description="Are you sure you want to fork a new notebook from this message?"
            onGoBackward={() => setShowForkModal(false)}
            onGoForward={() => {
              handleFork(messageData);
            }}
            forwardButtonText="Confirm"
            backwardButtonText="Cancel"
            loading={forkSession.isPending}
          />
        )}
        {showSnipModal && (
          <ConfirmActionModal
            className="session-middle-snip-modal"
            title="Quickstart Notebook from thisMessage?"
            description="Are you sure you want to quickstart a notebook from this message?"
            onGoBackward={() => setShowSnipModal(false)}
            onGoForward={() => {
              handleSnip(messageData);
            }}
            forwardButtonText="Confirm"
            backwardButtonText="Cancel"
            loading={snipSession.isPending}
          />
        )}
        {index !== 0 && (
          <Divider
            className="message-divider"
            sx={{
              mt: 4,
              mb: 2,
              width: '100%',
              opacity: 0.3,
            }}
          />
        )}
        {messageData.prompt && (
          <UserPrompt
            prompt={messageData.prompt}
            messageFiles={messageFiles}
            onEdit={prompt => onSendMessage({ ...messageData, prompt }, { isRetry: true })}
            onSendMessage={onSendMessage}
            search={search}
            messageId={messageData.id}
          />
        )}
        {/* Auto-route notice. Sits above the reply body (not in the footer chip
            row) so the user reads it before internalizing the agent-style answer -
            false-positive remediation via Dismiss is more discoverable that way.
            Covers both the classifier upgrade and the rule-based complexity reroute. */}
        {(messageData.routingSource === 'classifier' || messageData.routingSource === 'complexity') && (
          <AutoRouteBadge source={messageData.routingSource} />
        )}
        {/* Conditional rendering: Research Mode vs Standard Response */}
        {messageData.researchModeResults && messageData.researchModeResults.length > 0 ? (
          <ResearchModeResponseDisplay
            quest={messageData}
            configurations={researchMode?.configurations || []}
            results={messageData.researchModeResults}
            onExport={results => {
              console.log('Research Mode results exported:', results);
            }}
            onDeselectResponse={async () => {
              // Reset the message to show all research results again
              if (messageData.id) {
                try {
                  await updateQuest.mutateAsync({
                    sessionId: sessionId,
                    id: messageData.id,
                    update: {
                      reply: '',
                      replies: [],
                    },
                  });

                  // Re-enable Research Mode so user can make a new selection
                  setLLM({
                    researchMode: {
                      ...researchMode,
                      enabled: true,
                    },
                  });

                  toast.success('Response deselected. Research Mode re-enabled.');

                  queryClient.invalidateQueries({ queryKey: ['quests', 'session', sessionId] });
                } catch (error) {
                  console.error('Failed to deselect response:', error);
                  toast.error('Failed to deselect response');
                }
              }
            }}
            onSelectResponse={async (_configId, response, modelInfo) => {
              // Update the original message to show which response was selected
              if (messageData.id) {
                try {
                  // Update the main reply to be the selected response
                  await updateQuest.mutateAsync({
                    sessionId: sessionId,
                    id: messageData.id,
                    update: {
                      reply: response,
                      replies: [response],
                    },
                  });

                  // Find the selected research configuration to use its settings
                  const selectedConfig = researchMode?.configurations?.find(config => config.model === modelInfo.model);

                  // Disable Research Mode and switch to selected model/parameters
                  setLLM({
                    researchMode: {
                      ...researchMode,
                      enabled: false,
                    },
                    model: modelInfo.model,
                    ...(selectedConfig?.parameters && {
                      temperature: selectedConfig.parameters.temperature,
                      max_tokens: selectedConfig.parameters.maxTokens,
                      top_p: selectedConfig.parameters.topP,
                      ...(selectedConfig.parameters.frequencyPenalty !== undefined && {
                        frequency_penalty: selectedConfig.parameters.frequencyPenalty,
                      }),
                    }),
                  });

                  toast.success(`Selected ${modelInfo.label || modelInfo.model} response. Research Mode disabled.`);

                  queryClient.invalidateQueries({ queryKey: ['quests', 'session', sessionId] });
                } catch (error) {
                  console.error('Failed to update quest with selection:', error);
                  toast.error('Failed to select response');
                }
              }
            }}
            selectedConfigId={(() => {
              // Determine if a response was already selected by checking if the reply matches one of the results
              if (messageData.reply && messageData.researchModeResults) {
                const selectedResult = messageData.researchModeResults.find(
                  result => result.response === messageData.reply
                );
                return selectedResult?.configurationId;
              }
              return undefined;
            })()}
            onUseModel={config => {
              // Apply the Research Mode configuration to the main model settings
              setLLM({
                model: config.model,
                temperature: config.parameters.temperature,
                top_p: config.parameters.topP,
                max_tokens: config.parameters.maxTokens,
                presence_penalty: config.parameters.presencePenalty,
                frequency_penalty: config.parameters.frequencyPenalty,
              });

              // Optionally disable Research Mode after adopting settings
              const disableResearchMode = useLLM.getState().setResearchMode;
              disableResearchMode({ enabled: false });
            }}
          />
        ) : (
          <PromptReplies
            messageData={messageData}
            onSendMessage={onSendMessage}
            showSyntaxHighlight={showSyntaxHighlight}
            search={search}
            isExpandable={isExpandable}
            messageId={messageData.id}
            onEdit={(newReply: string) => {
              if (!messageData.id || !sessionId) return;
              const update = messageData.reply ? { reply: newReply } : { replies: [newReply] };
              updateQuest.mutate({
                sessionId,
                id: messageData.id,
                update,
              });
            }}
          />
        )}
        {/* "Show reasoning" disclosure — only present when this Quest was
            created from a persisted agent_execute run (see `persistRunAsQuest`
            in agentExecutor.ts). Lazy-loads the iteration trace from the
            AgentExecution doc and replays it inline under the reply. */}
        {messageData.agentExecutionId && sessionId ? (
          <ReasoningDisclosure agentExecutionId={messageData.agentExecutionId} sessionId={sessionId} />
        ) : null}
        {messageData.oob &&
          (() => {
            let artifact: {
              type: 'mermaid' | 'recharts' | 'image';
              data: string;
              title?: string;
              description?: string;
            } | null = null;
            try {
              const parsed = JSON.parse(messageData.oob);
              if (parsed.type === 'mermaid' || parsed.type === 'recharts' || parsed.type === 'image') {
                artifact = parsed;
              }
            } catch {
              // not artifact JSON - fall through to plain text
            }
            if (artifact) {
              return (
                <Suspense fallback={null}>
                  <TavernArtifactRenderer artifact={artifact} compact={false} />
                </Suspense>
              );
            }
            return (
              <Box
                className="oob-message"
                sx={{
                  display: 'flex',
                  alignSelf: 'flex-end',
                  marginRight: '1vw',
                  borderRadius: '10px',
                  backgroundColor: 'neutral.100',
                }}
              >
                <Typography variant="plain" level="body-xs" sx={{ color: 'primary.700', marginX: '5px' }}>
                  {messageData.oob}
                </Typography>
              </Box>
            );
          })()}
        <Box
          className="message-footer"
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '10px',
          }}
        >
          <Box className="message-info" sx={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            {adminSettings.enforceCredits &&
            currentUser?.showCreditsUsed &&
            !isProcessingPrompt &&
            messageData.creditsUsed !== undefined ? (
              <Tooltip title={`Credits Used: ${messageData.creditsUsed ?? 0}`}>
                <Chip
                  data-testid="credits-used"
                  size="sm"
                  variant="soft"
                  sx={theme => ({
                    bgcolor: theme.palette.fileBrowser.statusChip.backgroundColor,
                    color: theme.palette.fileBrowser.statusChip.textColor,
                    fontSize: '13px',
                    height: '24px',
                    border: `1px solid ${theme.palette.fileBrowser.statusChip.borderColor}`,
                    gap: '4px',
                    px: '8px',
                    fontWeight: 500,
                  })}
                  startDecorator={<Bike4MindIcon size="12" fill="currentColor" />}
                >
                  {messageData.creditsUsed ?? 0}
                </Chip>
              </Tooltip>
            ) : null}

            {!isProcessingPrompt &&
              messageData.promptMeta?.model?.name &&
              !(messageData.researchModeResults && messageData.researchModeResults.length > 0) && (
                <ModelChip displayName={getModelDisplayName(messageData.promptMeta.model.name)} />
              )}

            {!isProcessingPrompt && messageData.promptMeta?.functionCalls && (
              <ToolsUsed functionCalls={messageData.promptMeta.functionCalls} size="sm" />
            )}
          </Box>

          {!isMobile ? (
            <Stack className="action-buttons-web" direction={'row'} gap="10px" alignItems="center">
              {!isProcessingPrompt && (
                <>
                  {/* Always visible primary action */}
                  <CopyTextButton text={extractedReplies ? extractedReplies[0] : ''} />
                  <DownloadMenu
                    content={extractedReplies ? extractedReplies[0] : ''}
                    fileName={`${messageData.id}.md`}
                  />

                  {/* Advanced actions in menu */}
                  <Dropdown>
                    <Tooltip title="More options">
                      <MenuButton
                        data-testid="message-actions-menu-btn"
                        slots={{ root: IconButton }}
                        slotProps={{ root: { variant: 'outlined', color: 'neutral', size: 'sm' } }}
                        sx={{
                          width: '28px',
                          height: '28px',
                          flexShrink: '0',
                          borderRadius: '6px',
                        }}
                      >
                        <MoreVertIcon />
                      </MenuButton>
                    </Tooltip>
                    <Menu
                      placement="bottom-end"
                      className="menuSurface advanced-menu-web"
                      sx={_theme => ({
                        minWidth: '180px',
                        '--ListItem-minHeight': '32px',
                        borderRadius: '6px',
                      })}
                    >
                      <MenuItem
                        onClick={() => {
                          if (messageData.prompt) {
                            triggerEdit(messageData.id!, 'prompt');
                          } else {
                            triggerEdit(messageData.id!, 'reply');
                          }
                        }}
                      >
                        <ListItemDecorator>
                          <EditIcon />
                        </ListItemDecorator>
                        Edit
                      </MenuItem>
                      <MenuItem onClick={handleOpenPromptMetaInspector}>
                        <ListItemDecorator>
                          <HiveIcon />
                        </ListItemDecorator>
                        Prompt Meta
                      </MenuItem>
                      <MenuItem onClick={() => onPinToggle(messageData)}>
                        <ListItemDecorator>
                          {messageData.pinned ? <PushPinIcon /> : <PushPinOutlinedIcon />}
                        </ListItemDecorator>
                        {messageData.pinned ? 'Unpin' : 'Pin'}
                      </MenuItem>
                      <MenuItem onClick={handleOpenBugReportModal}>
                        <ListItemDecorator>
                          <BugReportIcon />
                        </ListItemDecorator>
                        Report
                      </MenuItem>
                      {canUseAdminTools && (
                        <MenuItem onClick={() => handlePreviewAsBlog(messageData)}>
                          <ListItemDecorator>
                            <ArticleIcon />
                          </ListItemDecorator>
                          Publish
                        </MenuItem>
                      )}
                      <MenuItem onClick={() => setShowForkModal(true)}>
                        <ListItemDecorator>
                          <ForkRightIcon />
                        </ListItemDecorator>
                        Fork Notebook
                      </MenuItem>
                      <MenuItem onClick={() => setShowSnipModal(true)}>
                        <ListItemDecorator>
                          <StartIcon />
                        </ListItemDecorator>
                        Quickstart
                      </MenuItem>
                      <MenuItem onClick={() => onSendMessage(messageData, { isRetry: true })}>
                        <ListItemDecorator>
                          <Refresh />
                        </ListItemDecorator>
                        Try Again
                      </MenuItem>
                      <MenuItem onClick={() => onSendMessage(messageData, { isVariation: true })}>
                        <ListItemDecorator>
                          <AddIcon />
                        </ListItemDecorator>
                        Re-prompt
                      </MenuItem>
                      <MenuItem onClick={toggleSyntaxHighlight}>
                        <ListItemDecorator>
                          <CodeIcon />
                        </ListItemDecorator>
                        Toggle Code View
                      </MenuItem>
                      <MenuItem onClick={() => handleSaveAsFile(messageData)}>
                        <ListItemDecorator>
                          <SaveIcon />
                        </ListItemDecorator>
                        Save as {detectChatContentType(messageData.replies?.[0] || '')}
                      </MenuItem>
                      {isFeatureEnabled('EnableDataLakes') && (
                        <MenuItem
                          onClick={() => handleSendReplyToDataLake(messageData)}
                          data-testid="message-send-to-datalake"
                        >
                          <ListItemDecorator>
                            <DataLakeIcon />
                          </ListItemDecorator>
                          Send to {DATA_LAKE}
                        </MenuItem>
                      )}
                      {hasShareableReply && (
                        <MenuItem onClick={handleShareReply} data-testid="message-share-reply">
                          <ListItemDecorator>
                            <ShareIcon />
                          </ListItemDecorator>
                          Share
                        </MenuItem>
                      )}
                      <MenuItem onClick={() => handleDelete(messageData)} color="danger">
                        <ListItemDecorator sx={{ color: 'inherit' }}>
                          <DeleteOutline />
                        </ListItemDecorator>
                        Delete
                      </MenuItem>
                    </Menu>
                  </Dropdown>

                  {/* Keep the modals */}
                  <BugReportModal
                    className="session-middle-bug-report-modal"
                    open={isBugReportModalOpen}
                    onClose={handleCloseBugReportModal}
                    promptMeta={messageData.promptMeta || null}
                  />
                  <ContentPreviewModal
                    open={showBlogPreviewModal}
                    onClose={() => setShowBlogPreviewModal(false)}
                    initialTitle={blogPreviewTitle}
                    initialContent={blogPreviewContent}
                    initialSummary={blogPreviewSummary}
                    initialTags={blogPreviewTags}
                  />
                </>
              )}
            </Stack>
          ) : (
            <Stack className="action-buttons-mobile" direction={'row'} gap="10px" alignItems="center">
              {!isProcessingPrompt && (
                <>
                  {/* Always visible primary action */}
                  <CopyTextButton text={extractedReplies ? extractedReplies[0] : ''} />
                  <DownloadMenu
                    content={extractedReplies ? extractedReplies[0] : ''}
                    fileName={`${messageData.id}.md`}
                  />

                  {/* Advanced actions in menu */}
                  <Dropdown>
                    <Tooltip title="More options">
                      <MenuButton
                        data-testid="message-actions-menu-btn"
                        slots={{ root: IconButton }}
                        slotProps={{ root: { variant: 'outlined', color: 'neutral', size: 'sm' } }}
                        sx={{
                          width: '28px',
                          height: '28px',
                          flexShrink: '0',
                          borderRadius: '6px',
                        }}
                      >
                        <MoreVertIcon />
                      </MenuButton>
                    </Tooltip>
                    <Menu
                      placement="bottom-end"
                      className="menuSurface advanced-menu-mobile"
                      sx={_theme => ({
                        minWidth: '180px',
                        '--ListItem-minHeight': '32px',
                        borderRadius: '6px',
                      })}
                    >
                      <MenuItem
                        onClick={() => {
                          if (messageData.prompt) {
                            triggerEdit(messageData.id!, 'prompt');
                          } else {
                            triggerEdit(messageData.id!, 'reply');
                          }
                        }}
                      >
                        <ListItemDecorator>
                          <EditIcon />
                        </ListItemDecorator>
                        Edit
                      </MenuItem>
                      <MenuItem onClick={handleOpenPromptMetaInspector}>
                        <ListItemDecorator>
                          <HiveIcon />
                        </ListItemDecorator>
                        Prompt Meta
                      </MenuItem>
                      <MenuItem onClick={() => onPinToggle(messageData)}>
                        <ListItemDecorator>
                          {messageData.pinned ? <PushPinIcon /> : <PushPinOutlinedIcon />}
                        </ListItemDecorator>
                        {messageData.pinned ? 'Unpin' : 'Pin'}
                      </MenuItem>
                      <MenuItem onClick={handleOpenBugReportModal}>
                        <ListItemDecorator>
                          <BugReportIcon />
                        </ListItemDecorator>
                        Report
                      </MenuItem>
                      {canUseAdminTools && (
                        <MenuItem onClick={() => handlePreviewAsBlog(messageData)}>
                          <ListItemDecorator>
                            <ArticleIcon />
                          </ListItemDecorator>
                          Publish
                        </MenuItem>
                      )}
                      <MenuItem onClick={() => setShowForkModal(true)}>
                        <ListItemDecorator>
                          <ForkRightIcon />
                        </ListItemDecorator>
                        Fork Notebook
                      </MenuItem>
                      <MenuItem onClick={() => setShowSnipModal(true)}>
                        <ListItemDecorator>
                          <StartIcon />
                        </ListItemDecorator>
                        Quickstart
                      </MenuItem>
                      <MenuItem onClick={() => onSendMessage(messageData, { isRetry: true })}>
                        <ListItemDecorator>
                          <Refresh />
                        </ListItemDecorator>
                        Try Again
                      </MenuItem>
                      <MenuItem onClick={() => onSendMessage(messageData, { isVariation: true })}>
                        <ListItemDecorator>
                          <AddIcon />
                        </ListItemDecorator>
                        Re-prompt
                      </MenuItem>
                      <MenuItem onClick={toggleSyntaxHighlight}>
                        <ListItemDecorator>
                          <CodeIcon />
                        </ListItemDecorator>
                        Toggle Code View
                      </MenuItem>
                      <MenuItem onClick={() => handleSaveAsFile(messageData)}>
                        <ListItemDecorator>
                          <SaveIcon />
                        </ListItemDecorator>
                        Save as {detectChatContentType(messageData.replies?.[0] || '')}
                      </MenuItem>
                      {isFeatureEnabled('EnableDataLakes') && (
                        <MenuItem
                          onClick={() => handleSendReplyToDataLake(messageData)}
                          data-testid="message-send-to-datalake"
                        >
                          <ListItemDecorator>
                            <DataLakeIcon />
                          </ListItemDecorator>
                          Send to {DATA_LAKE}
                        </MenuItem>
                      )}
                      {hasShareableReply && (
                        <MenuItem onClick={handleShareReply} data-testid="message-share-reply">
                          <ListItemDecorator>
                            <ShareIcon />
                          </ListItemDecorator>
                          Share
                        </MenuItem>
                      )}
                      <MenuItem onClick={() => handleDelete(messageData)} color="danger">
                        <ListItemDecorator sx={{ color: 'inherit' }}>
                          <DeleteOutline />
                        </ListItemDecorator>
                        Delete
                      </MenuItem>
                    </Menu>
                  </Dropdown>

                  {/* Keep the modals */}
                  <BugReportModal
                    className="session-middle-bug-report-modal"
                    open={isBugReportModalOpen}
                    onClose={handleCloseBugReportModal}
                    promptMeta={messageData.promptMeta || null}
                  />
                  <ContentPreviewModal
                    open={showBlogPreviewModal}
                    onClose={() => setShowBlogPreviewModal(false)}
                    initialTitle={blogPreviewTitle}
                    initialContent={blogPreviewContent}
                    initialSummary={blogPreviewSummary}
                    initialTags={blogPreviewTags}
                  />
                </>
              )}
            </Stack>
          )}
        </Box>
      </Stack>
    );
  }
);

MessageContent.displayName = 'MessageContent';

export default MessageContent;
