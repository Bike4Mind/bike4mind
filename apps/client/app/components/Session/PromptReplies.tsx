import ImageContainer from '@client/app/components/Session/ImageContainer';
import VideoContainer from '@client/app/components/Session/VideoContainer';
import { Box, Stack, Chip, Avatar, Tooltip, Button, Alert } from '@mui/joy';
import Typography from '@mui/joy/Typography';
import React, {
  FC,
  useCallback,
  useState,
  useRef,
  useEffect,
  HTMLAttributes,
  DetailedHTMLProps,
  FunctionComponent,
  ReactNode,
  useMemo,
  ComponentProps,
} from 'react';
import ReactMarkdown, { ExtraProps } from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter/dist/cjs';
import { oneDark } from 'react-syntax-highlighter/dist/cjs/styles/prism';
import { useMessageEditMode } from '@client/app/hooks/useMessageEditMode';
import ErrorBoundary from '@client/app/components/common/ErrorBoundary';
import { highlightTextSearch } from '@client/app/components/GenAI/highlight';
import QuestMasterPreviewCard from '@client/app/components/GenAI/QuestMasterPreviewCard';
import { useUserSettings } from '@client/app/contexts/UserSettingsContext';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useContentTruncation } from '@client/app/hooks/useContentTruncation';
import QuoteActions from './QuoteActions';
import { link } from './MarkdownLink';
import { PromptReplyProps, ReplyContainerProps } from './types/UserPromptTypes';
import { CopyCodeButton } from './CopyCodeButton';
import ThoughtBubbles from './ThoughtBubbles';
import CodeArtifactPreviewCard from '../GenAI/CodeArtifactPreviewCard';
import ContentTransformPreviewCard from '../GenAI/ContentTransformPreviewCard';
import { AccountTree as MermaidIcon, InsertDriveFileOutlined } from '@mui/icons-material';
import ImageDisplay from './ImageDisplay';
import MementoIndicator from './MementoIndicator';
import { agentAvatarFallbackSx } from '@client/app/components/Agent/AgentAvatar';
import { remarkGfmNoSingleTilde } from '@client/app/utils/remarkPlugins';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import type { ChessArtifact, MermaidArtifact } from '@bike4mind/common';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import EditModeContent from './EditModeContent';
import { ExpandCollapseButton } from './ExpandCollapseButton';
import { IAgent } from '@bike4mind/common';
import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { isAxiosError } from 'axios';
import { useConfig } from '@client/app/hooks/data/settings';
import { parseArtifacts, convertCodeBlocksToArtifacts, validateMermaidSyntax } from '@client/app/utils/artifactParser';
import RechartsRenderer from '../Charts/RechartsRenderer';
import ChessBoard from '../Chess/ChessBoard';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { extractReplies } from '@client/app/utils/replyUtils';
import DeepResearchProgress from '../GenAI/DeepResearchProgress';
import PromptEnhancementBanner from './PromptEnhancementBanner';
import { extractCodeBlockTitle } from '@client/app/utils/codeBlockTitleExtractor';
import CitableSources from './CitableSources';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { parseChartJSON, ChartParseError, getChartErrorMessage } from '@client/app/utils/chartJsonParser';
import NavigationButtons from './NavigationButtons';
import { NotebookExecutionButtons } from './NotebookExecutionButtons';
import type { UiSideEffect } from '@bike4mind/common';
import { dispatchUiSideEffects } from '@client/app/utils/uiSideEffectDispatcher';

// Artifact system (extracted modules)
import ArtifactRenderer from './artifacts/ArtifactRenderer';
import {
  extractChessJson,
  validateChessFen,
  trackChessState,
  pushChessToSidePanel,
  openChessInSidePanel,
  latestChessStateMap,
  InlineChessBoard,
  type ChessFenResult,
  type LatestChessState,
} from './artifacts/handlers/chess';

// Code block registry: stable IDs for code blocks during streaming

const codeBlockRegistry = new Map<string, Set<string>>();

// Provider stop reasons that indicate the model finished its turn normally (vs being
// cut off at the output-token ceiling). Used to tell a genuinely truncated artifact
// apart from a completed reply that merely mentions `<artifact` in prose.
const CLEAN_FINISH_REASONS = new Set(['end_turn', 'stop', 'tool_use', 'stop_sequence']);

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36).slice(0, 8);
}

// Markdown `code` component: handles inline artifacts in code blocks

const code = ({ node, className, children, ref, ...props }: ComponentProps<'code'> & ExtraProps) => {
  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : 'text';
  const codeContent = String(children).replace(/\n$/, '');
  const lineCount = codeContent.split('\n').length;
  const inline =
    node?.position?.start.line === node?.position?.end.line &&
    node?.position?.start.column !== node?.position?.end.column;

  // Generate a stable yet unique ID for this code block
  const position = node?.position?.start.line || '';
  const firstChars = codeContent.slice(0, 100).replace(/\s/g, '');
  const baseId = `code-${language}-${position}-${firstChars}`;
  const contentHash = simpleHash(codeContent);

  let artifactId: string;
  if (!codeBlockRegistry.has(baseId)) {
    codeBlockRegistry.set(baseId, new Set([contentHash]));
    artifactId = baseId;
  } else {
    const hashSet = codeBlockRegistry.get(baseId)!;
    if (!hashSet.has(contentHash)) {
      hashSet.add(contentHash);
    }
    artifactId = `${baseId}-${contentHash}`;
  }

  // Legacy blog-draft JSON detection - fallback for drafts persisted before the
  // <artifact> path; the artifact handler is now the primary route. Kept for
  // backward compatibility; silently no-ops on non-matching JSON.
  if (language === 'json') {
    try {
      const parsed = JSON.parse(codeContent);
      if (
        parsed.title &&
        parsed.content &&
        typeof parsed.title === 'string' &&
        typeof parsed.content === 'string' &&
        parsed.suggestedTags &&
        Array.isArray(parsed.suggestedTags)
      ) {
        return (
          <Box sx={{ my: 2 }}>
            <ContentTransformPreviewCard
              data={{
                title: parsed.title,
                content: parsed.content,
                summary: parsed.summary || '',
                suggestedTags: parsed.suggestedTags,
              }}
            />
          </Box>
        );
      }
    } catch {
      // Not a blog-draft JSON block - fall through to normal code rendering.
    }
  }

  // Recharts inline rendering
  if (language === 'recharts') {
    try {
      const rechartsConfig = parseChartJSON(codeContent);
      return (
        <RechartsRenderer
          config={rechartsConfig}
          title={rechartsConfig.title}
          description={rechartsConfig.description}
          forceMode="inline"
        />
      );
    } catch (error) {
      const errorMessage =
        error instanceof ChartParseError ? getChartErrorMessage(error) : 'Invalid chart configuration';
      return (
        <Box sx={{ my: 2, p: 2, border: '1px solid', borderColor: 'danger.300', borderRadius: 'sm' }}>
          <Typography level="body-sm" color="danger">
            Error rendering chart: {errorMessage}
          </Typography>
          <Box
            component="pre"
            sx={{
              mt: 1,
              p: 1,
              bgcolor: 'background.level1',
              borderRadius: 'sm',
              fontSize: '0.875rem',
              fontFamily: 'monospace',
              overflow: 'auto',
              maxHeight: '200px',
            }}
          >
            {codeContent}
          </Box>
        </Box>
      );
    }
  }

  // Chess inline rendering
  if (language === 'chess') {
    try {
      const jsonStr = extractChessJson(codeContent);
      if (!jsonStr) throw new Error('No JSON in chess data');
      const chessData = JSON.parse(jsonStr);
      const fen = chessData.fen || chessData.resultingFen;
      if (!fen) throw new Error('No FEN in chess data');

      const turnLabel = chessData.turn === 'w' ? 'White' : 'Black';
      let statusText = `${turnLabel} to move`;
      if (chessData.isCheckmate) statusText = `Checkmate! ${chessData.turn === 'w' ? 'Black' : 'White'} wins`;
      else if (chessData.isStalemate) statusText = 'Stalemate — draw';
      else if (chessData.isDraw) statusText = 'Draw';
      else if (chessData.isCheck) statusText = `${turnLabel} to move — Check!`;

      const openChessInSidePanelFromCode = () => {
        const urlSessionId =
          typeof window !== 'undefined' ? window.location.pathname.match(/\/notebooks\/([^/]+)/)?.[1] : undefined;
        let latest: LatestChessState | undefined;
        if (urlSessionId) {
          latest = latestChessStateMap.get(urlSessionId);
        }
        if (!latest) {
          for (const entry of latestChessStateMap.values()) {
            if (!latest || (entry.moveNumber ?? 0) >= (latest.moveNumber ?? 0)) {
              latest = entry;
            }
          }
        }
        const useFen = latest?.fen || fen;
        const useJsonStr = latest?.jsonStr || jsonStr;
        const useData = latest || chessData;
        const now = new Date();
        const chessArtifact: ChessArtifact = {
          id: `chess-${useFen.replace(/\s+/g, '-').slice(0, 20)}-${Date.now()}`,
          type: 'chess',
          title: 'Chess Game',
          content: useJsonStr,
          createdAt: now,
          updatedAt: now,
          metadata: {
            fen: useFen,
            turn: useData.turn as 'w' | 'b' | undefined,
            lastMove: useData.move ? { from: useData.move.from, to: useData.move.to } : undefined,
            isCheck: useData.isCheck,
            isCheckmate: useData.isCheckmate,
            isDraw: useData.isDraw,
            isGameOver: useData.isGameOver,
            moveNumber: useData.moveNumber,
          },
        };
        setSessionLayout({
          layout: 'vertical',
          artifactData: {
            type: 'chess',
            content: chessArtifact,
            mimeType: 'application/vnd.ant.chess',
            id: chessArtifact.id,
          },
        });
      };

      return (
        <Box
          onClick={openChessInSidePanelFromCode}
          sx={{
            my: 2,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 1,
            cursor: 'pointer',
            '&:hover': { opacity: 0.85 },
          }}
        >
          <ChessBoard
            fen={fen}
            lastMove={chessData.move ? { from: chessData.move.from, to: chessData.move.to } : undefined}
          />
          <Typography level="body-sm" sx={{ fontWeight: 500 }}>
            {statusText}
            {chessData.moveNumber ? ` — Move ${chessData.moveNumber}` : ''}
          </Typography>
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
            Click to open interactive board
          </Typography>
        </Box>
      );
    } catch (err) {
      console.warn('[Chess] Failed to parse chess data:', err, 'Content:', codeContent.slice(0, 200));
      return (
        <Box sx={{ my: 2, p: 2, border: '1px solid', borderColor: 'danger.300', borderRadius: 'sm' }}>
          <Typography level="body-sm" color="danger">
            Error rendering chess board: {err instanceof Error ? err.message : 'Invalid data'}
          </Typography>
          <Box
            component="pre"
            sx={{
              mt: 1,
              p: 1,
              bgcolor: 'background.level1',
              borderRadius: 'sm',
              fontSize: '0.875rem',
              fontFamily: 'monospace',
              overflow: 'auto',
              maxHeight: '200px',
            }}
          >
            {codeContent}
          </Box>
        </Box>
      );
    }
  }

  // Mermaid preview
  if (language === 'mermaid') {
    const validation = validateMermaidSyntax(codeContent);
    const displayContent = validation.cleanedContent || codeContent;

    return (
      <Box
        sx={{
          my: 2,
          cursor: 'pointer',
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: 'sm',
          p: 2,
          '&:hover': {
            bgcolor: 'background.level1',
          },
        }}
        onClick={() => {
          const mermaidArtifact: MermaidArtifact = {
            id: `mermaid-${Math.random().toString(36).substring(2, 11)}`,
            type: 'mermaid',
            title: 'Mermaid Diagram',
            content: displayContent,
            metadata: {
              chartType: 'flowchart',
              description: 'Generated Mermaid diagram',
            },
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          setSessionLayout({
            layout: 'vertical',
            artifactData: {
              type: 'mermaid',
              content: mermaidArtifact,
              mimeType: 'text/plain',
              id: mermaidArtifact.id,
            },
          });
        }}
      >
        <Stack direction="row" spacing={1} alignItems="center" mb={1}>
          <MermaidIcon sx={{ color: 'neutral.300', fontSize: '1.25rem' }} />
          <Typography level="body-sm">Click to view Mermaid diagram</Typography>
        </Stack>
        <Box
          component="pre"
          sx={{
            p: 2,
            borderRadius: 'sm',
            bgcolor: 'background.level1',
            overflow: 'auto',
            fontSize: '0.875rem',
            fontFamily: 'monospace',
            whiteSpace: 'pre-wrap',
            maxHeight: '100px',
          }}
        >
          {displayContent}
        </Box>
      </Box>
    );
  }

  // Inline code or short snippet
  if (inline || lineCount <= 10) {
    return !inline ? (
      <Box sx={{ position: 'relative' }}>
        <CopyCodeButton code={codeContent} language={language} />
        <SyntaxHighlighter
          // @ts-ignore - ignoring style prop type issue
          style={oneDark}
          customStyle={{ paddingTop: '32px' }}
          language={language}
          PreTag="div"
          {...props}
        >
          {codeContent}
        </SyntaxHighlighter>
      </Box>
    ) : (
      <Box
        component="code"
        sx={{
          padding: '3px 6px',
          backgroundColor: 'neutral.700',
          borderRadius: '.235rem',
          color: 'neutral.50',
          textWrap: 'balance',
        }}
        {...props}
      >
        {children}
      </Box>
    );
  }

  // Longer code blocks -> CodeArtifact preview card
  const extractedTitle = extractCodeBlockTitle(codeContent, language);

  const codeArtifact = {
    title: extractedTitle,
    description: codeContent.split('\n').slice(0, 2).join('\n') + '...',
    language,
    code: codeContent,
    lineCount,
  };

  return (
    <Box sx={{ my: 2 }}>
      <CodeArtifactPreviewCard data={codeArtifact} artifactId={artifactId} />
    </Box>
  );
};

// Other markdown components

function omitBetweenTags(input: string, openTag: string, closeTag: string): string {
  let result = input;
  let openIndex = result.indexOf(openTag);

  while (openIndex !== -1) {
    const closeIndex = result.indexOf(closeTag, openIndex + openTag.length);

    if (closeIndex === -1) {
      result = result.substring(0, openIndex);
      break;
    } else {
      result = result.substring(0, openIndex) + result.substring(closeIndex + closeTag.length);
    }

    openIndex = result.indexOf(openTag);
  }

  return result;
}

// PromptReplies: top-level component (public API unchanged)

const PromptReplies: FC<PromptReplyProps> = ({
  messageData,
  onSendMessage,
  showSyntaxHighlight,
  search,
  isExpandable,
  onEdit,
}) => {
  const { data: config } = useConfig();
  const cdnUrl = config?.cdnUrl || process.env.NEXT_PUBLIC_CDN_URL || '';

  const replies = useMemo(() => extractReplies(messageData), [messageData]);

  const thoughts = useMemo(() => {
    return (messageData.replies || []).filter(Boolean).filter(r => r.startsWith('<think>'));
  }, [messageData.replies]);

  const generatedImagesUrl = `${cdnUrl}/generated`;
  // quest.images carries every file a tool generated this turn, but not all of them are
  // images - e.g. excel_generation drops an .xlsx in here. Only actual images belong in the
  // inline image grid; anything else would render as a broken <img>. Split by extension and
  // surface non-image files as download chips instead (they also appear in the Knowledge Base).
  const images = useMemo(
    () =>
      generatedImagesUrl
        ? (messageData.images ?? [])
            .filter(image => /\.(png|jpe?g|webp|gif|svg|bmp|avif)$/i.test(image))
            .map(image => `${generatedImagesUrl}/${image}`)
            .filter(Boolean)
        : [],
    [messageData.images, generatedImagesUrl]
  );
  const generatedFiles = useMemo(
    () =>
      generatedImagesUrl
        ? (messageData.images ?? [])
            .filter(image => !/\.(png|jpe?g|webp|gif|svg|bmp|avif)$/i.test(image))
            .map(image => ({ name: image, url: `${generatedImagesUrl}/${image}` }))
        : [],
    [messageData.images, generatedImagesUrl]
  );
  const videos = useMemo(
    () =>
      generatedImagesUrl ? messageData.videos?.map(video => `${generatedImagesUrl}/${video}`).filter(Boolean) : [],
    [messageData.videos, generatedImagesUrl]
  );

  // Extract notebook content from tool results
  const notebookContent = useMemo(() => {
    const { toolResults } = messageData;
    if (toolResults) {
      for (const result of toolResults) {
        try {
          const parsed = JSON.parse(result.content);
          if (
            typeof parsed.nbformat === 'number' &&
            parsed.nbformat >= 1 &&
            parsed.nbformat_minor !== undefined &&
            Array.isArray(parsed.cells) &&
            parsed.cells.length > 0 &&
            parsed.cells.every(
              (cell: { cell_type?: string }) =>
                cell.cell_type === 'code' || cell.cell_type === 'markdown' || cell.cell_type === 'raw'
            )
          ) {
            return result.content;
          }
        } catch {
          // Not valid JSON, skip
        }
      }
    }
    return undefined;
  }, [messageData]);

  return (
    <>
      <ReplyContainer
        completed={messageData.status === 'done'}
        showSyntaxHighlight={showSyntaxHighlight}
        reply={messageData.questMasterReply || replies[0]}
        thought={thoughts[0]}
        images={images}
        generatedFiles={generatedFiles}
        videos={videos}
        search={search}
        isExpandable={isExpandable}
        promptMeta={messageData.promptMeta}
        onSendMessage={onSendMessage}
        messageId={messageData.id}
        onEdit={onEdit}
        questMasterPlanId={messageData.questMasterPlanId}
        agentIds={messageData.agentIds}
        originalPrompt={messageData.promptEnhancement?.originalPrompt}
        enhancedPrompt={messageData.promptEnhancement?.enhancedPrompt}
        promptWasEnhanced={messageData.promptEnhancement?.promptWasEnhanced}
        promptIntent={messageData.promptEnhancement?.intent}
        deepResearchState={messageData.deepResearchState}
        pendingAction={messageData.pendingAction}
        attachmentList={messageData.attachmentList}
        navigationIntents={messageData.navigationIntents}
        uiSideEffects={messageData.uiSideEffects}
        jupyterNotebook={messageData.jupyterNotebook}
        notebookContent={notebookContent}
      />
    </>
  );
};

export default PromptReplies;

// AgentAttribution

const AgentAttribution: FC<{ agentIds: string[] }> = ({ agentIds }) => {
  const { data: agents } = useQuery({
    queryKey: ['agents', agentIds],
    queryFn: async () => {
      if (!agentIds || agentIds.length === 0) return [];

      const agentPromises = agentIds.map(async agentId => {
        try {
          const response = await api.get<IAgent>(`/api/agents/${agentId}`);
          return response.data;
        } catch (error) {
          console.warn(`Failed to fetch agent ${agentId}:`, error);
          return null;
        }
      });

      const results = await Promise.all(agentPromises);
      return results.filter((agent): agent is IAgent => agent !== null);
    },
    enabled: agentIds && agentIds.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  if (!agents || agents.length === 0) {
    return null;
  }

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        mb: 1,
        p: 1,
        borderRadius: 'sm',
        bgcolor: 'background.level1',
        border: '1px solid',
        borderColor: 'divider',
      }}
    >
      <Typography level="body-xs" sx={{ color: 'text.tertiary', fontWeight: 'medium' }}>
        {agents.length === 1 ? 'Agent Response:' : 'Collaborative Response:'}
      </Typography>

      <Stack direction="row" spacing={0.5}>
        {agents.map(agent => (
          <Tooltip key={agent.id} title={agent.description || agent.name} placement="top">
            <Chip
              variant="soft"
              color="primary"
              size="sm"
              startDecorator={
                <Avatar
                  size="sm"
                  src={agent.visual?.portraitUrl || ''}
                  sx={{
                    width: 16,
                    height: 16,
                    fontSize: '10px',
                    fontWeight: 600,
                    ...agentAvatarFallbackSx(agent.name),
                  }}
                >
                  {agent.name.charAt(0).toUpperCase()}
                </Avatar>
              }
              sx={{
                maxWidth: '120px',
                '& .MuiChip-label': {
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: '11px',
                },
              }}
            >
              {agent.name}
            </Chip>
          </Tooltip>
        ))}
      </Stack>

      {agents.length > 1 && (
        <Typography level="body-xs" sx={{ color: 'text.tertiary', ml: 'auto' }}>
          {agents.length} agents
        </Typography>
      )}
    </Box>
  );
};

// PendingActionButtons

interface PendingActionButtonsProps {
  pendingAction: NonNullable<ReplyContainerProps['pendingAction']>;
  messageId?: string;
  sessionId?: string;
}

const PendingActionButtons: FC<PendingActionButtonsProps> = ({ pendingAction, messageId, sessionId }) => {
  const storageKey = messageId ? `mcp-confirm-${messageId}` : null;
  const storedData = storageKey && typeof window !== 'undefined' ? sessionStorage.getItem(storageKey) : null;
  const parsedData = storedData ? JSON.parse(storedData) : null;

  const [isLoading, setIsLoading] = useState(false);
  const [isConfirmed, setIsConfirmed] = useState(() => parsedData?.status === 'confirmed');
  const [isCancelled, setIsCancelled] = useState(() => parsedData?.status === 'cancelled');
  const [result, setResult] = useState<{ success: boolean; message: string; url?: string } | null>(
    () => parsedData?.result || null
  );

  if (!messageId || !sessionId) {
    return null;
  }

  // eslint-disable-next-line react-hooks/purity -- pre-existing: time-based expiry check; render-time Date.now is acceptable here since the parent re-renders on quest updates
  const isExpired = pendingAction.ts && Date.now() - pendingAction.ts > 15 * 60 * 1000;

  const handleConfirm = async () => {
    if (!messageId || !sessionId) return;
    setIsLoading(true);
    try {
      const response = await api.post('/api/mcp/confirm', {
        questId: messageId,
        sessionId,
        confirmed: true,
      });
      setIsConfirmed(true);
      setResult(response.data);
      if (storageKey) {
        const dataToStore = { status: 'confirmed', result: response.data };
        sessionStorage.setItem(storageKey, JSON.stringify(dataToStore));
      }
    } catch (error: unknown) {
      const message = isAxiosError(error)
        ? error.response?.data?.error || error.message
        : error instanceof Error
          ? error.message
          : 'Failed to execute action';
      setResult({
        success: false,
        message,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!messageId || !sessionId) return;
    setIsLoading(true);
    try {
      await api.post('/api/mcp/confirm', {
        questId: messageId,
        sessionId,
        confirmed: false,
      });
      setIsCancelled(true);
      const cancelResult = { success: true, message: 'Action cancelled' };
      setResult(cancelResult);
      if (storageKey) {
        const dataToStore = { status: 'cancelled', result: cancelResult };
        sessionStorage.setItem(storageKey, JSON.stringify(dataToStore));
      }
    } catch (error: unknown) {
      const message = isAxiosError(error)
        ? error.response?.data?.error || error.message
        : error instanceof Error
          ? error.message
          : 'Failed to cancel action';
      setResult({
        success: false,
        message,
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (isConfirmed || isCancelled) {
    return (
      <Box sx={{ mt: 2, p: 1.5, borderRadius: 'sm', bgcolor: 'background.level1' }}>
        <Typography level="body-sm" sx={{ color: result?.success ? 'success.main' : 'danger.main' }}>
          {result?.message || (isConfirmed ? 'Action completed' : 'Action cancelled')}
        </Typography>
        {result?.url && (
          <Typography level="body-sm" sx={{ mt: 0.5 }}>
            <a href={result.url} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>
              {result.url}
            </a>
          </Typography>
        )}
      </Box>
    );
  }

  if (isExpired) {
    return (
      <Box sx={{ mt: 2, p: 1.5, borderRadius: 'sm', bgcolor: 'warning.softBg' }}>
        <Typography level="body-sm" sx={{ color: 'warning.main' }}>
          This confirmation has expired. Please request the action again.
        </Typography>
      </Box>
    );
  }

  const toolDisplayName = pendingAction.tool.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

  return (
    <Box
      sx={{
        mt: 2,
        p: 1.5,
        borderRadius: 'sm',
        bgcolor: 'background.level1',
        border: '1px solid',
        borderColor: 'primary.outlinedBorder',
      }}
    >
      <Typography level="body-sm" sx={{ mb: 1.5, fontWeight: 'md' }}>
        Ready to execute: {toolDisplayName}
      </Typography>
      <Stack direction="row" spacing={1}>
        <Button
          size="sm"
          color="success"
          variant="solid"
          onClick={handleConfirm}
          loading={isLoading}
          startDecorator="✅"
          data-testid="mcp-confirm-btn"
        >
          Confirm
        </Button>
        <Button
          size="sm"
          color="danger"
          variant="soft"
          onClick={handleCancel}
          loading={isLoading}
          startDecorator="❌"
          data-testid="mcp-cancel-btn"
        >
          Cancel
        </Button>
      </Stack>
    </Box>
  );
};

// AttachmentDownloadButtons

interface AttachmentDownloadButtonsProps {
  attachmentList: NonNullable<ReplyContainerProps['attachmentList']>;
  sessionId?: string;
}

const AttachmentDownloadButtons: FC<AttachmentDownloadButtonsProps> = ({ attachmentList, sessionId }) => {
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set());
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleDownload = async (attachment: (typeof attachmentList.attachments)[0]) => {
    if (!sessionId) {
      setErrors(prev => ({ ...prev, [attachment.id]: 'Session not found. Please refresh the page.' }));
      return;
    }

    setDownloadingIds(prev => new Set(prev).add(attachment.id));
    setErrors(prev => {
      const next = { ...prev };
      delete next[attachment.id];
      return next;
    });

    try {
      const response = await api.post(
        '/api/mcp/download-attachment',
        {
          sessionId,
          source: attachmentList.source,
          attachmentId: attachment.id,
          filename: attachment.filename,
        },
        {
          responseType: 'blob',
        }
      );

      const contentType = String(response.headers['content-type'] ?? '');
      if (contentType.includes('application/json')) {
        const errorText = await response.data.text();
        const errorData = JSON.parse(errorText);
        setErrors(prev => ({ ...prev, [attachment.id]: errorData.error || 'Download failed' }));
        return;
      }

      const blob = new Blob([response.data], { type: contentType || 'application/octet-stream' });
      const url = window.URL.createObjectURL(blob);
      const linkEl = document.createElement('a');
      linkEl.href = url;
      linkEl.download = attachment.filename;
      document.body.appendChild(linkEl);
      linkEl.click();
      document.body.removeChild(linkEl);
      window.URL.revokeObjectURL(url);

      setDownloadedIds(prev => new Set(prev).add(attachment.id));
    } catch (error: unknown) {
      const axiosError = error as { response?: { data?: Blob | { error?: string } }; message?: string };
      let errorMessage = 'Download failed';
      if (axiosError.response?.data instanceof Blob) {
        try {
          const errorText = await axiosError.response.data.text();
          const errorData = JSON.parse(errorText);
          errorMessage = errorData.error || errorMessage;
        } catch {
          // Ignore parse error
        }
      } else if (
        axiosError.response?.data &&
        typeof axiosError.response.data === 'object' &&
        'error' in axiosError.response.data
      ) {
        errorMessage = (axiosError.response.data as { error?: string }).error || errorMessage;
      } else if (axiosError.message) {
        errorMessage = axiosError.message;
      }
      setErrors(prev => ({ ...prev, [attachment.id]: errorMessage }));
    } finally {
      setDownloadingIds(prev => {
        const next = new Set(prev);
        next.delete(attachment.id);
        return next;
      });
    }
  };

  const handleDelete = async (attachment: (typeof attachmentList.attachments)[0]) => {
    if (!sessionId) {
      setErrors(prev => ({ ...prev, [attachment.id]: 'Session not found. Please refresh the page.' }));
      return;
    }

    const confluenceLabel = attachmentList.pageTitle
      ? `Confluence page "${attachmentList.pageTitle}"`
      : `Confluence page ${attachmentList.pageId || ''}`;
    const sourceContext =
      attachmentList.source === 'jira' ? `Jira ticket ${attachmentList.issueKey || ''}` : confluenceLabel;
    if (!window.confirm(`Delete "${attachment.filename}" from ${sourceContext}?\n\nThis action cannot be undone.`)) {
      return;
    }

    setDeletingIds(prev => new Set(prev).add(attachment.id));
    setErrors(prev => {
      const next = { ...prev };
      delete next[attachment.id];
      return next;
    });

    try {
      const response = await api.post('/api/mcp/delete-attachment', {
        sessionId,
        source: attachmentList.source,
        attachmentId: attachment.id,
        filename: attachment.filename,
        ...(attachmentList.pageId && { pageId: attachmentList.pageId }),
      });

      if (response.data?.success) {
        setDeletedIds(prev => new Set(prev).add(attachment.id));
      } else {
        setErrors(prev => ({ ...prev, [attachment.id]: response.data?.error || 'Deletion failed' }));
      }
    } catch (error: unknown) {
      const axiosError = error as { response?: { data?: { error?: string } }; message?: string };
      const errorMessage = axiosError.response?.data?.error || axiosError.message || 'Deletion failed';
      setErrors(prev => ({ ...prev, [attachment.id]: errorMessage }));
    } finally {
      setDeletingIds(prev => {
        const next = new Set(prev);
        next.delete(attachment.id);
        return next;
      });
    }
  };

  if (!attachmentList.attachments?.length) {
    return null;
  }

  const sourceLabel = attachmentList.source === 'jira' ? 'Jira' : 'Confluence';

  return (
    <Box
      data-testid="attachment-download-list"
      sx={{
        mt: 2,
        p: 1.5,
        borderRadius: 'sm',
        bgcolor: 'background.level1',
        border: '1px solid',
        borderColor: 'neutral.outlinedBorder',
      }}
    >
      <Typography level="body-sm" sx={{ mb: 1.5, fontWeight: 'md' }}>
        📎 {attachmentList.attachments.length} attachment{attachmentList.attachments.length !== 1 ? 's' : ''} from{' '}
        {sourceLabel}
      </Typography>
      <Stack spacing={1}>
        {attachmentList.attachments.map(att => {
          const isDeleted = deletedIds.has(att.id);
          const isDeleting = deletingIds.has(att.id);
          const isBusy = downloadingIds.has(att.id) || isDeleting;

          return (
            <Box
              key={att.id}
              data-testid={`attachment-item-${att.id}`}
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                p: 1,
                borderRadius: 'sm',
                bgcolor: 'background.surface',
                border: '1px solid',
                borderColor: 'divider',
                opacity: isDeleted ? 0.5 : 1,
              }}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography
                  level="body-sm"
                  sx={{ fontWeight: 'md', textDecoration: isDeleted ? 'line-through' : 'none' }}
                >
                  {att.emoji} {att.filename}
                </Typography>
                <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                  {isDeleted ? 'Deleted' : att.sizeFormatted}
                  {!isDeleted && att.author && ` • by ${att.author}`}
                </Typography>
                {errors[att.id] && (
                  <Typography level="body-xs" sx={{ color: 'danger.main' }}>
                    {errors[att.id]}
                  </Typography>
                )}
              </Box>
              {!isDeleted && (
                <Stack direction="row" spacing={0.5} sx={{ ml: 1, flexShrink: 0 }}>
                  <Button
                    data-testid={`attachment-download-btn-${att.id}`}
                    size="sm"
                    variant={downloadedIds.has(att.id) ? 'soft' : 'outlined'}
                    color={downloadedIds.has(att.id) ? 'success' : 'neutral'}
                    onClick={() => handleDownload(att)}
                    loading={downloadingIds.has(att.id)}
                    disabled={isBusy}
                    startDecorator={downloadedIds.has(att.id) ? '✅' : '⬇️'}
                  >
                    {downloadedIds.has(att.id) ? 'Downloaded' : 'Download'}
                  </Button>
                  <Button
                    data-testid={`attachment-delete-btn-${att.id}`}
                    size="sm"
                    variant="outlined"
                    color="danger"
                    onClick={() => handleDelete(att)}
                    loading={isDeleting}
                    disabled={isBusy}
                    startDecorator={'🗑️'}
                  >
                    Delete
                  </Button>
                </Stack>
              )}
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
};

// UiSideEffectDispatcher

const UiSideEffectDispatcher: FC<{ effects: UiSideEffect[]; completed: boolean; dedupeKey?: string }> = ({
  effects,
  completed,
  dedupeKey,
}) => {
  const hasDispatched = useRef(false);

  useEffect(() => {
    if (!completed || hasDispatched.current) return;
    hasDispatched.current = true;
    // Live arrival from a just-completed reply - auto-apply the brief and follow
    // the AI to its console. dedupeKey ensures the streaming path and this render
    // path apply the same quest only once (the later one is a no-op).
    dispatchUiSideEffects(effects, { live: true, dedupeKey });
  }, [completed, effects, dedupeKey]);

  return null;
};

// ReplyContainer: the main rendering workhorse

const ReplyContainer: FC<ReplyContainerProps> = ({
  showSyntaxHighlight,
  reply,
  thought,
  images = [],
  generatedFiles = [],
  videos = [],
  search,
  isExpandable = false,
  completed = false,
  questMasterPlanId,
  onSendMessage,
  messageId,
  onEdit,
  agentIds,
  deepResearchState,
  originalPrompt,
  enhancedPrompt,
  promptWasEnhanced,
  promptIntent,
  promptMeta,
  pendingAction,
  attachmentList,
  navigationIntents,
  uiSideEffects,
  jupyterNotebook,
  notebookContent,
}) => {
  const { currentSessionId } = useSessions();
  const isMobile = useIsMobile();
  const [isEditMode, setIsEditMode] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // STREAMING AUTO-SCROLL
  const lastContentLengthRef = useRef(0);
  const userScrolledUpRef = useRef(false);
  const autoScrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!contentRef.current || !reply) return;

    const currentContentLength = reply.length;
    const contentElement = contentRef.current;

    if (currentContentLength > lastContentLengthRef.current && !completed) {
      const isNearBottom = contentElement.scrollTop + contentElement.clientHeight >= contentElement.scrollHeight - 100;

      if (isNearBottom && !userScrolledUpRef.current) {
        if (autoScrollTimeoutRef.current) {
          clearTimeout(autoScrollTimeoutRef.current);
        }

        autoScrollTimeoutRef.current = setTimeout(() => {
          if (contentElement && !completed) {
            contentElement.scrollTo({
              top: contentElement.scrollHeight,
              behavior: 'smooth',
            });
          }
        }, 50);
      }
    }

    lastContentLengthRef.current = currentContentLength;
  }, [reply, completed]);

  useEffect(() => {
    const contentElement = contentRef.current;
    if (!contentElement) return;

    const handleScroll = () => {
      if (!contentElement) return;
      const isAtBottom = contentElement.scrollTop + contentElement.clientHeight >= contentElement.scrollHeight - 50;
      userScrolledUpRef.current = !isAtBottom;
      if (completed) {
        userScrolledUpRef.current = false;
      }
    };

    contentElement.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      contentElement.removeEventListener('scroll', handleScroll);
      if (autoScrollTimeoutRef.current) {
        clearTimeout(autoScrollTimeoutRef.current);
      }
    };
  }, [completed]);

  useEffect(() => {
    if (completed) {
      userScrolledUpRef.current = false;
      lastContentLengthRef.current = reply?.length || 0;
    }
  }, [completed, reply?.length]);

  // Edit mode store subscription
  const editingMessageId = useMessageEditMode(s => s.editingMessageId);
  const editTarget = useMessageEditMode(s => s.editTarget);
  const clearEdit = useMessageEditMode(s => s.clearEdit);

  useEffect(() => {
    if (editingMessageId === messageId && editTarget === 'reply') {
      setIsEditMode(true);
      clearEdit();
    }
  }, [editingMessageId, editTarget, messageId, clearEdit]);

  const highlightText = useCallback(
    (node: ReactNode[] | string) => {
      return highlightTextSearch(node, search);
    },
    [search]
  );

  const p: FunctionComponent<
    Omit<DetailedHTMLProps<HTMLAttributes<HTMLParagraphElement>, HTMLParagraphElement>, 'ref'> & ExtraProps
  > = useCallback(
    ({ node, children, color, ...props }) => {
      const nodeWithParent = node as typeof node & { parent?: { children?: unknown[] } };
      const isLast =
        node &&
        nodeWithParent.parent &&
        Array.isArray(nodeWithParent.parent.children) &&
        nodeWithParent.parent.children[nodeWithParent.parent.children.length - 1] === node;

      const childArray = React.Children.toArray(children);
      const hasOnlyImage =
        childArray.length === 1 &&
        React.isValidElement(childArray[0]) &&
        (childArray[0].type === ImageContainer ||
          (typeof childArray[0].type === 'function' && childArray[0].type.name === 'img'));

      if (hasOnlyImage) {
        return <Box sx={{ mb: isLast ? '0 !important' : '8px !important' }}>{children}</Box>;
      }

      const processedChildren = React.Children.map(children, child => {
        if (typeof child === 'string') {
          return highlightText(child);
        }
        return child;
      });

      return (
        <Typography
          level={isMobile ? 'body-sm' : 'body-md'}
          component="p"
          gutterBottom={false}
          sx={{ display: 'block', color: 'text.primary', mb: isLast ? '0 !important' : '8px !important' }}
          {...props}
          data-testid="ai-response"
        >
          {processedChildren}
        </Typography>
      );
    },
    [highlightText, isMobile]
  );

  const tableComponents = {
    table: ({ node, children, ref, ...props }: ComponentProps<'table'> & ExtraProps) => (
      <Box
        component="table"
        sx={{
          width: '100%',
          borderCollapse: 'collapse',
          margin: '1rem 0',
          border: '1px solid',
          borderColor: 'neutral.300',
          borderRadius: '8px',
          overflow: 'hidden',
          color: 'text.primary',
          '& th, & td': {
            padding: '0.75rem',
            border: '1px solid',
            borderColor: 'divider',
            color: 'text.primary',
          },
          '& th': {
            backgroundColor: 'background.level1',
            fontWeight: 'bold',
            borderBottom: '2px solid',
            borderBottomColor: 'divider',
            color: 'text.primary',
          },
          '& tr:nth-of-type(even)': {
            backgroundColor: 'background.level1',
            color: 'text.primary',
          },
        }}
        {...props}
      >
        {children}
      </Box>
    ),
    thead: ({ node, children, ref, ...props }: ComponentProps<'thead'> & ExtraProps) => (
      <Box component="thead" {...props}>
        {children}
      </Box>
    ),
    tbody: ({ node, children, ref, ...props }: ComponentProps<'tbody'> & ExtraProps) => (
      <Box component="tbody" {...props}>
        {children}
      </Box>
    ),
    tr: ({ children }: ComponentProps<'tr'> & ExtraProps) => <Box component="tr">{children}</Box>,
    th: ({ children }: ComponentProps<'th'> & ExtraProps) => {
      const processedChildren = React.Children.map(children, child => {
        if (typeof child === 'string') {
          return highlightText(child);
        }
        return child;
      });

      return (
        <Box component="th" sx={{ color: 'text.primary' }}>
          {processedChildren}
        </Box>
      );
    },
    td: ({ children }: ComponentProps<'td'> & ExtraProps) => {
      const processedChildren = React.Children.map(children, child => {
        if (typeof child === 'string') {
          return highlightText(child);
        }
        return child;
      });

      return (
        <Box component="td" sx={{ color: 'text.primary' }}>
          {processedChildren}
        </Box>
      );
    },
  };

  const cleanReply = useMemo(() => {
    return omitBetweenTags(reply || '', '<think>', '</think>');
  }, [reply]);

  const { settings: userSettings } = useUserSettings();
  const { isFeatureEnabled } = useFeatureEnabled();
  const rechartsDisplayMode = isFeatureEnabled('enableArtifacts')
    ? userSettings.rechartsDisplayMode || 'inline'
    : 'inline';

  // An <artifact> tag that opened but never closed. This happens in two states:
  //  - still streaming: we hide the partial to avoid flicker, OR
  //  - COMPLETED while truncated: the model hit the output-token limit mid-artifact
  //    (e.g. cut off inside a <script>), so the closing </artifact> never arrived.
  // In the completed case the raw partial must NOT fall through to the markdown
  // renderer, where it shows as broken/escaped HTML in the chat bubble.
  const hasUnclosedArtifact = useMemo(() => {
    if (!cleanReply) return false;
    // Compare open/close tag counts rather than a bare substring check so a reply that
    // emits one CLOSED artifact followed by a second UNCLOSED one is still detected
    // (a substring check would see the lone </artifact> and miss the dangling tag).
    const opens = (cleanReply.match(/<artifact\b/gi) || []).length;
    const closes = (cleanReply.match(/<\/artifact>/gi) || []).length;
    return opens > closes;
  }, [cleanReply]);

  const isStreamingArtifact = hasUnclosedArtifact && !completed;

  // Distinguish a genuinely truncated artifact from a completed reply that merely
  // *mentions* `<artifact` in prose or inline code (the artifact system prompt makes
  // such mentions more likely). The server records the provider stop reason on
  // promptMeta.finishReason: a clean finish (end_turn / stop / tool_use /
  // stop_sequence) means the unclosed `<artifact` is a mention, not truncation - so we
  // must NOT mangle it into a card. When the stop reason is 'max_tokens' (or absent -
  // older quests / backends that don't report one) we fall back to containment so raw
  // HTML can never leak.
  const finishedCleanly = !!promptMeta?.finishReason && CLEAN_FINISH_REASONS.has(promptMeta.finishReason);
  const isTruncatedArtifact = hasUnclosedArtifact && !!completed && !finishedCleanly;

  const { artifacts, processedContent } = useMemo(() => {
    if (!cleanReply) return { artifacts: [], processedContent: '' };

    let preprocessedContent = cleanReply;
    if (isStreamingArtifact) {
      const artifactIndex = preprocessedContent.indexOf('<artifact');
      if (artifactIndex !== -1) {
        preprocessedContent = preprocessedContent.substring(0, artifactIndex).trim();
      }
    } else if (isTruncatedArtifact) {
      // Completed but truncated mid-artifact. Target the LAST opening tag - that's the
      // dangling one; any earlier artifacts are already closed and must be left intact.
      // If that opening tag is complete (has a closing `>`), best-effort close the
      // artifact so the partial parses into a previewable/downloadable card (a truncation
      // banner is rendered above it). If the opening tag itself was cut off mid-attribute,
      // drop the partial from that tag onward so no raw HTML leaks into the bubble.
      const artifactIndex = preprocessedContent.lastIndexOf('<artifact');
      const tail = artifactIndex !== -1 ? preprocessedContent.substring(artifactIndex) : '';
      if (/^<artifact\s+[^>]*>/.test(tail)) {
        preprocessedContent = `${preprocessedContent.trimEnd()}\n</artifact>`;
      } else {
        // Opening tag truncated mid-attribute - nothing renderable. Log the dropped
        // length so mid-attribute truncations are observable if they occur in prod.
        console.warn(
          `[Artifacts] Dropping truncated artifact with incomplete opening tag (${tail.length} chars) (#9259)`
        );
        preprocessedContent =
          artifactIndex === -1 ? preprocessedContent : preprocessedContent.substring(0, artifactIndex).trim();
      }
    }

    let parseResult = parseArtifacts(preprocessedContent, { rechartsDisplayMode });

    if (parseResult.artifacts.length === 0) {
      const contentForConversion = parseResult.cleanedContent || preprocessedContent;
      const convertedContent = convertCodeBlocksToArtifacts(contentForConversion);
      if (convertedContent !== contentForConversion) {
        parseResult = parseArtifacts(convertedContent, { rechartsDisplayMode });
      }
    }

    return {
      artifacts: parseResult.artifacts,
      processedContent: parseResult.cleanedContent,
    };
  }, [cleanReply, rechartsDisplayMode, isStreamingArtifact, isTruncatedArtifact]);

  const chessArtifacts = useMemo(() => artifacts.filter(a => a.type === 'chess'), [artifacts]);
  const nonChessArtifacts = useMemo(() => artifacts.filter(a => a.type !== 'chess'), [artifacts]);

  // Track latest chess state per session AND auto-update side panel
  useEffect(() => {
    if (chessArtifacts.length === 0 || !currentSessionId) return;
    const artifact = chessArtifacts[chessArtifacts.length - 1];
    try {
      const toolChessArtifact = promptMeta?.artifacts?.find(
        (a: { metadata?: Record<string, unknown> }) =>
          a.metadata?.source === 'tool_result' && a.metadata?.artifactType === 'application/vnd.ant.chess'
      );

      const jsonStr = toolChessArtifact ? toolChessArtifact.content : extractChessJson(artifact.content);
      if (!jsonStr) return;
      const chessData = JSON.parse(jsonStr);
      const rawFen = chessData.fen || chessData.resultingFen;
      if (!rawFen) return;

      let fen: string;
      if (toolChessArtifact) {
        fen = rawFen;
      } else {
        const fenResult = validateChessFen(currentSessionId, rawFen, chessData);
        fen = fenResult.fen;
      }

      trackChessState(currentSessionId, chessData, fen, jsonStr);

      if (completed) {
        pushChessToSidePanel(currentSessionId, fen, jsonStr, chessData);
      }
    } catch (err) {
      console.error('[Chess auto-update] Error:', err);
    }
  }, [chessArtifacts, completed, currentSessionId, promptMeta?.artifacts]);

  const { needsTruncation, isExpanded, toggleExpanded, displayContent } = useContentTruncation({
    content: processedContent,
    isEnabled: isExpandable,
  });

  if (questMasterPlanId) {
    return <QuestMasterPreviewCard questMasterPlanId={questMasterPlanId} />;
  }

  return (
    <Box
      data-testid="ai-response-root-container"
      sx={{
        display: 'flex',
        justifyContent: 'center',
        width: '100%',
        backgroundColor: 'lighten.500',
        flexDirection: 'column',
      }}
    >
      <QuoteActions containerRef={contentRef} />

      {/* Truncated-artifact recovery banner: the response hit the output-token
          limit before the artifact closed. The partial is best-effort recovered into a
          card above; never leak the raw HTML into the bubble. */}
      {isTruncatedArtifact && (
        <Alert
          data-testid="artifact-truncated-warning"
          color="warning"
          variant="soft"
          sx={{ my: 1, flexDirection: 'column', alignItems: 'flex-start', gap: 0.5 }}
        >
          <Typography level="title-sm">⚠️ Artifact was truncated</Typography>
          <Typography level="body-sm">
            This response reached the output length limit before the artifact finished generating. The preview below may
            be incomplete — ask me to regenerate it (or to continue or shorten it) for a complete version.
          </Typography>
        </Alert>
      )}

      {/* Chess board — rendered directly, bypasses artifact registry */}
      {chessArtifacts.length > 0 &&
        (() => {
          const artifact = chessArtifacts[chessArtifacts.length - 1];
          try {
            const toolChessArtifact = promptMeta?.artifacts?.find(
              (a: { metadata?: Record<string, unknown> }) =>
                a.metadata?.source === 'tool_result' && a.metadata?.artifactType === 'application/vnd.ant.chess'
            );

            const jsonStr = toolChessArtifact ? toolChessArtifact.content : extractChessJson(artifact.content);
            if (!jsonStr) return null;
            const chessData = JSON.parse(jsonStr);
            const rawFen = chessData.fen || chessData.resultingFen;
            if (!rawFen) return null;

            let fenResult: ChessFenResult;
            if (toolChessArtifact) {
              fenResult = { fen: rawFen };
            } else if (currentSessionId) {
              fenResult = validateChessFen(currentSessionId, rawFen, chessData);
            } else {
              fenResult = { fen: rawFen };
            }

            return (
              <InlineChessBoard
                fen={fenResult.fen}
                chessData={chessData}
                fenResult={fenResult}
                onOpenPanel={() =>
                  openChessInSidePanel(fenResult.fen, jsonStr, chessData, currentSessionId ?? undefined)
                }
              />
            );
          } catch {
            return null;
          }
        })()}

      {/* Other artifacts — rendered via registry */}
      {nonChessArtifacts.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <Stack spacing={2}>
            {nonChessArtifacts.map((artifact, index) => (
              <ArtifactRenderer
                key={`${artifact.type}_${artifact.identifier}_${index}`}
                artifact={artifact}
                index={index}
                messageId={messageId ?? 'unknown'}
                sessionId={currentSessionId ?? undefined}
              />
            ))}
          </Stack>
        </Box>
      )}

      {showSyntaxHighlight ? (
        <SyntaxHighlighter style={oneDark}>{processedContent || cleanReply}</SyntaxHighlighter>
      ) : (
        <>
          <ThoughtBubbles content={thought || ''} isStreaming={!completed} defaultFolded={isExpandable} />
          {deepResearchState && (
            <DeepResearchProgress
              activities={deepResearchState.activities}
              sources={deepResearchState.sources}
              completedSteps={deepResearchState.completedSteps}
              totalExpectedSteps={deepResearchState.totalExpectedSteps}
            />
          )}
          {agentIds && agentIds.length > 0 && <AgentAttribution agentIds={agentIds} />}
          {promptMeta?.context?.mementoIds && promptMeta.context.mementoIds.length > 0 && (
            <Box sx={{ mb: 1 }}>
              <MementoIndicator mementoIds={promptMeta.context.mementoIds} />
            </Box>
          )}
          {promptMeta?.citables && promptMeta.citables.length > 0 && <CitableSources citables={promptMeta.citables} />}
          {isEditMode && onEdit ? (
            <EditModeContent
              content={processedContent || cleanReply}
              onCancel={() => setIsEditMode(false)}
              onEdit={(newReply: string) => {
                if (onEdit) {
                  setIsEditMode(false);
                  onEdit(newReply);
                }
              }}
            />
          ) : (
            <>
              {(cleanReply || images.length > 0 || generatedFiles.length > 0 || videos.length > 0) && (
                <Box
                  sx={{
                    position: 'relative',
                  }}
                >
                  <Typography
                    variant="soft"
                    level={isMobile ? 'body-sm' : 'body-md'}
                    component="div"
                    sx={{
                      margin: 0,
                      padding: 2,
                      backgroundColor: 'chatbox.replyBg',
                      borderRadius: '8px',
                      color: 'text.primary',
                      overflowX: 'auto',
                      position: 'relative',
                      scrollBehavior: 'smooth',
                      '& p:last-child': { mb: '0 !important' },
                    }}
                    ref={contentRef}
                  >
                    {originalPrompt && enhancedPrompt && promptWasEnhanced && (
                      <PromptEnhancementBanner
                        originalPrompt={originalPrompt}
                        enhancedPrompt={enhancedPrompt}
                        promptWasEnhanced={promptWasEnhanced}
                        intent={promptIntent}
                      />
                    )}

                    {reply?.includes('BFL image generation') ? (
                      <ImageDisplay
                        error={new Error(reply)}
                        onRetrySuccess={newImageUrl => {
                          images.push(newImageUrl);
                        }}
                      />
                    ) : (
                      <>
                        {images?.length > 0 && (
                          <Box
                            sx={{
                              display: 'grid',
                              gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
                              gap: '1rem',
                              width: '100%',
                            }}
                          >
                            <ErrorBoundary fallback={<p>Image failed to load.</p>}>
                              {images.map((image, index) => (
                                <ImageContainer
                                  key={index}
                                  src={image}
                                  index={index}
                                  totalImages={images.length}
                                  images={images}
                                  onSendMessage={onSendMessage}
                                  variant="full"
                                  onNavigate={() => {}}
                                />
                              ))}
                            </ErrorBoundary>
                          </Box>
                        )}

                        {generatedFiles.length > 0 && (
                          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, width: '100%', mt: 1 }}>
                            {generatedFiles.map((file, index) => (
                              <Button
                                key={index}
                                component="a"
                                href={file.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                size="sm"
                                variant="outlined"
                                color="neutral"
                                startDecorator={<InsertDriveFileOutlined sx={{ fontSize: 18 }} />}
                                data-testid="generated-file-download"
                              >
                                {file.name}
                              </Button>
                            ))}
                          </Box>
                        )}

                        {videos?.length > 0 && (
                          <Box
                            sx={{
                              display: 'grid',
                              gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
                              gap: '1rem',
                              width: '100%',
                              mt: images?.length > 0 ? 2 : 0,
                            }}
                          >
                            <ErrorBoundary fallback={<p>Video failed to load.</p>}>
                              {videos.map((video, index) => (
                                <VideoContainer
                                  key={index}
                                  src={video}
                                  index={index}
                                  totalVideos={videos.length}
                                  videos={videos}
                                  variant="full"
                                  onNavigate={() => {}}
                                />
                              ))}
                            </ErrorBoundary>
                          </Box>
                        )}

                        {isStreamingArtifact && (
                          <Box
                            sx={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 1,
                              p: 2,
                              my: 1,
                              backgroundColor: 'primary.50',
                              borderRadius: 'sm',
                              border: '1px dashed',
                              borderColor: 'primary.200',
                            }}
                          >
                            <Box
                              sx={{
                                width: 16,
                                height: 16,
                                borderRadius: '50%',
                                border: '2px solid',
                                borderColor: 'primary.200',
                                borderTopColor: 'primary.500',
                                animation: 'spin 1s linear infinite',
                                '@keyframes spin': {
                                  '0%': { transform: 'rotate(0deg)' },
                                  '100%': { transform: 'rotate(360deg)' },
                                },
                              }}
                            />
                            <Typography level="body-sm" sx={{ color: 'primary.700' }}>
                              Generating artifact...
                            </Typography>
                          </Box>
                        )}

                        {displayContent && (
                          <ReactMarkdown
                            components={{
                              p,
                              code,
                              h1: ({ children }) => (
                                <Typography
                                  level="h3"
                                  component="h1"
                                  sx={{ color: 'text.primary', mb: 2, mt: 2, display: 'block', width: '100%' }}
                                >
                                  {children}
                                </Typography>
                              ),
                              h2: ({ children }) => (
                                <Typography
                                  level="h4"
                                  component="h2"
                                  sx={{ color: 'text.primary', mb: 1.5, mt: 1.5, display: 'block', width: '100%' }}
                                >
                                  {children}
                                </Typography>
                              ),
                              img: ({ alt, src, title }) => {
                                if (!src) {
                                  return null;
                                }

                                const srcStr = typeof src === 'string' ? src : '';
                                if (
                                  srcStr.startsWith('/mnt/') ||
                                  srcStr.startsWith('/tmp/') ||
                                  srcStr.startsWith('file://') ||
                                  srcStr.startsWith('sandbox:') ||
                                  srcStr.includes('/mnt/data/')
                                ) {
                                  return null;
                                }

                                return (
                                  <ImageContainer
                                    src={srcStr}
                                    index={0}
                                    totalImages={1}
                                    images={[srcStr]}
                                    onSendMessage={onSendMessage}
                                  />
                                );
                              },
                              a: link,
                              ...tableComponents,
                            }}
                            remarkPlugins={[remarkGfmNoSingleTilde, [remarkMath, { singleDollarTextMath: false }]]}
                            rehypePlugins={[rehypeKatex]}
                            remarkRehypeOptions={{ clobberPrefix: `fn-${messageId ?? 'reply'}-` }}
                          >
                            {displayContent}
                          </ReactMarkdown>
                        )}
                      </>
                    )}
                  </Typography>
                </Box>
              )}
            </>
          )}
        </>
      )}

      <ExpandCollapseButton needsTruncation={needsTruncation} isExpanded={isExpanded} onToggle={toggleExpanded} />

      {pendingAction && completed && (
        <PendingActionButtons
          pendingAction={pendingAction}
          messageId={messageId}
          sessionId={currentSessionId || undefined}
        />
      )}

      {attachmentList && completed && (
        <AttachmentDownloadButtons attachmentList={attachmentList} sessionId={currentSessionId || undefined} />
      )}

      {navigationIntents && navigationIntents.length > 0 && completed && (
        <NavigationButtons navigationIntents={navigationIntents} />
      )}

      {uiSideEffects && uiSideEffects.length > 0 && completed && (
        <UiSideEffectDispatcher effects={uiSideEffects} completed={completed} dedupeKey={messageId} />
      )}

      {notebookContent && completed && (
        <NotebookExecutionButtons
          jupyterNotebook={jupyterNotebook}
          notebookContent={notebookContent}
          sessionId={currentSessionId || undefined}
          messageId={messageId}
        />
      )}
    </Box>
  );
};
