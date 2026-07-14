/*
Renders knowledge items by type: files (PDF, markdown, DOCX, CSV/JSON, text, code)
and AI-reply artifacts (QuestMaster quest chains, Mermaid, Recharts, React/HTML/SVG,
chess, lattice, Python). Each type has a dedicated viewer.
*/

import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { downloadData } from '@client/app/utils/download';
import {
  useSessions,
  useWorkBenchFiles,
  useSystemPromptFiles,
  useWorkBenchActions,
} from '@client/app/contexts/SessionsContext';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import { useLLM } from '@client/app/contexts/LLMContext';
import {
  Box,
  Stack,
  Typography,
  Tabs,
  Tooltip,
  CircularProgress,
  TabPanel,
  IconButton,
  ButtonGroup,
  Grid,
  AspectRatio,
  Select,
  Option,
} from '@mui/joy';
import dynamic from 'next/dynamic';
import { IFabFileDocument, ISessionDocument } from '@bike4mind/common';
import TextViewer from './TextViewer';
import MarkdownViewer from './MarkdownViewer';
import DocxViewer from './DOCXViewer';
import CSVViewer from './CSVViewer';
import QuestMasterReply from '../GenAI/QuestMasterReply';
import { QuestMasterData } from '@bike4mind/common';
import PictureInPictureIcon from '@mui/icons-material/PictureInPicture';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import CheckIcon from '@mui/icons-material/Check';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import SendIcon from '@mui/icons-material/Send';
import { ExpandMore, ExtensionOff, Splitscreen, FormatListNumbered } from '@mui/icons-material';
import { create } from 'zustand';
import { setSessionLayout, clearRecentArtifacts } from '@client/app/hooks/useSessionLayout';
import { getContentFromFabfile } from '@client/app/utils/fabFileUtils';
import useSessionLayout from '@client/app/hooks/useSessionLayout';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { CodeArtifactData } from '@client/app/hooks/useSessionLayout';
import { SupportedFabFileMimeTypes } from '@bike4mind/common';
import EditFileDialog, { EditOptions } from './EditFileDialog';
import DiffPreview from './DiffPreview';
import { Theme } from '@mui/joy/styles';
import MermaidChart from '../Charts/MermaidChart';
import RechartsRenderer from '../Charts/RechartsRenderer';
import {
  type MermaidArtifact,
  type ReactArtifact,
  type HtmlArtifact,
  type SvgArtifact,
  type RechartsArtifact,
  type ChessArtifact,
  type LatticeArtifact,
  type PythonArtifact,
} from '@bike4mind/common';
import ChessBoard from '../Chess/ChessBoard';
import InteractiveChessBoard from '../Chess/InteractiveChessBoard';
import { getFabFileByIdFromServer } from '@client/app/utils/filesAPICalls';
import { StreamedChatCompletionAction, type IMessageDataToClient } from '@bike4mind/common';
import { z } from 'zod';
import XLSXViewer from './XLSXViewer';
import { toast } from 'react-hot-toast';
import DownloadMenu, { downloadFile, copyToClipboard } from '../common/DownloadMenu';
import ShareIcon from '@mui/icons-material/Share';
import { useUser } from '@client/app/contexts/UserContext';
import { usePublishShare } from '@client/app/hooks/usePublishShare';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import { buildArtifactPublishWiring } from '@client/app/utils/publishApi';
import JSONViewer from './JSONViewer';
import { api } from '@client/app/contexts/ApiContext';
import { useQueryClient } from '@tanstack/react-query';
import { useArtifact } from '@client/app/hooks/data/artifacts';
import { useArtifactPersistence } from '@client/app/hooks/useArtifactPersistence';
import ContentPreviewModal from '@client/app/components/ProfileModal/ContentPreviewModal';
import { useAdminTools } from '@client/app/hooks/useAdminTools';
import { useMessageFiles } from '@client/app/hooks/useMessageFiles';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { useQuestExport } from '@client/app/hooks/data/useQuestExport';
import ErrorBoundary from '@client/app/components/common/ErrorBoundary';

// Dynamic imports for artifact viewers
const ReactArtifactViewer = dynamic(() => import('./ReactArtifactViewer'), {
  ssr: false,
  loading: () => (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
      <CircularProgress />
    </Box>
  ),
});

const HtmlArtifactViewer = dynamic(() => import('./HtmlArtifactViewer'), {
  ssr: false,
  loading: () => (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
      <CircularProgress />
    </Box>
  ),
});

const SvgArtifactViewer = dynamic(() => import('./SvgArtifactViewer'), {
  ssr: false,
  loading: () => (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
      <CircularProgress />
    </Box>
  ),
});

const LatticeViewer = dynamic(() => import('./LatticeViewer'), {
  ssr: false,
  loading: () => (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
      <CircularProgress />
    </Box>
  ),
});

const PythonArtifactViewer = dynamic(() => import('./PythonArtifactViewer'), {
  ssr: false,
  loading: () => (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
      <CircularProgress />
    </Box>
  ),
});

// Helper function to get language for syntax highlighting
const getLanguageFromFileName = (fileName: string): string => {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const languageMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    java: 'java',
    cpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    rb: 'ruby',
    go: 'go',
    swift: 'swift',
    kt: 'kotlin',
    rs: 'rust',
    css: 'css',
    less: 'less',
    sass: 'sass',
    scss: 'scss',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    sh: 'bash',
    bash: 'bash',
    json: 'json',
    md: 'markdown',
    html: 'html',
    xml: 'xml',
  };
  return languageMap[ext] || 'typescript'; // Default to typescript if extension not found
};

const PdfViewer = dynamic(() => import('@client/app/components/PdfViewer'), {
  ssr: false,
  loading: () => (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
      <CircularProgress />
    </Box>
  ),
});

interface IBaseKnowledgeItem {
  id: string;
  title: string;
  timestamp?: number; // For ordering items
}

interface IFileKnowledgeItem extends IBaseKnowledgeItem {
  type: 'file';
  content: IFabFileDocument;
}
interface IQuestMasterKnowledgeItem extends IBaseKnowledgeItem {
  type: 'questmaster';
  content: string;
}
interface ICodeKnowledgeItem extends IBaseKnowledgeItem {
  type: 'code';
  content: CodeArtifactData;
}
interface IMermaidKnowledgeItem extends IBaseKnowledgeItem {
  type: 'mermaid';
  content: MermaidArtifact;
}

interface IRechartsKnowledgeItem extends IBaseKnowledgeItem {
  type: 'recharts';
  content: RechartsArtifact;
}

interface IChessKnowledgeItem extends IBaseKnowledgeItem {
  type: 'chess';
  content: ChessArtifact;
}

interface IReactKnowledgeItem extends IBaseKnowledgeItem {
  type: 'react';
  content: ReactArtifact;
}

interface IHtmlKnowledgeItem extends IBaseKnowledgeItem {
  type: 'html';
  content: HtmlArtifact;
}

interface ISvgKnowledgeItem extends IBaseKnowledgeItem {
  type: 'svg';
  content: SvgArtifact;
}

interface ILatticeKnowledgeItem extends IBaseKnowledgeItem {
  type: 'lattice';
  content: LatticeArtifact;
}

interface IPythonKnowledgeItem extends IBaseKnowledgeItem {
  type: 'python';
  content: PythonArtifact;
}

type KnowledgeItem =
  | IFileKnowledgeItem
  | IQuestMasterKnowledgeItem
  | ICodeKnowledgeItem
  | IMermaidKnowledgeItem
  | IRechartsKnowledgeItem
  | IChessKnowledgeItem
  | IReactKnowledgeItem
  | IHtmlKnowledgeItem
  | ISvgKnowledgeItem
  | ILatticeKnowledgeItem
  | IPythonKnowledgeItem;

interface KnowledgeViewerState {
  selectedTabIndex: number;
  showLineNumbers: boolean;
}

const useKnowledgeViewer = create<KnowledgeViewerState>(() => ({
  selectedTabIndex: 0,
  showLineNumbers: false,
}));

export const setKnowledgeViewer = useKnowledgeViewer.setState;

/**
 * Decides whether the KnowledgeViewer should overwrite the content it is currently showing
 * with the copy fetched from the DB.
 *
 * The content shown when the viewer opens is the freshly-iterated/streamed version, which
 * reaches memory (via the chat preview card and the one-shot write on open) BEFORE the async
 * on-quest-completion persist finishes. During that window a DB read returns the PREVIOUS
 * version. Blindly applying it is the #457 regression - the just-opened version flickers back
 * to the stale one. The opened content carries no version of its own, so we cannot compare
 * versions directly; instead we compare the DB version against a `baselineVersion` captured
 * when the current content was pinned (the DB version present at open time):
 *
 *  - If the DB content already equals what we show, there is nothing to do.
 *  - Otherwise adopt the DB copy ONLY when it is a strictly NEWER version than the baseline
 *    (a genuine new persisted version), never a same-or-older-version stale read.
 *
 * Missing versions coerce to 0. Extracted as a pure predicate so the guard can be unit tested
 * without mounting KnowledgeViewer.
 */
export const shouldSyncArtifactFromDb = (params: {
  currentContent?: string;
  latestContent?: string;
  latestVersion?: number;
  baselineVersion?: number;
}): boolean => {
  // Already showing the DB's content - nothing to sync.
  if (params.latestContent === params.currentContent) return false;

  // Content differs: adopt only a strictly newer version than the pinned baseline, so the
  // stale read during the persist race cannot downgrade the just-opened version.
  return (params.latestVersion ?? 0) > (params.baselineVersion ?? 0);
};

const isMarkdownFile = (item: KnowledgeItem | undefined) => {
  if (!item || item.type !== 'file') return false;
  const mime = item.content.mimeType;
  return (
    mime === SupportedFabFileMimeTypes.TXT_MARKDOWN ||
    mime === SupportedFabFileMimeTypes.TXT_MD_LEGACY ||
    mime === 'text/mdx' ||
    (mime === SupportedFabFileMimeTypes.TXT_PLAIN && item.content.fileName.match(/\.mdx?$/))
  );
};

const isWithinSizeLimit = (item: KnowledgeItem) => {
  if (!item || item.type !== 'file') return false;
  // 50 kb only
  return item.content.fileSize < 50 * 1024;
};

const buttonTooltipTitle = (item: KnowledgeItem) => {
  if (!isWithinSizeLimit(item)) return 'Edit with AI disabled. File is too large (max 50kb).';
  if (!isMarkdownFile(item)) return 'Edit with AI disabled. This is a non-markdown file.';
  return 'Edit with AI';
};

interface KnowledgeViewerProps {
  /** When true (default), auto-hides the layout when no knowledge items or artifacts exist. Set to false for pages like /opti that manage their own layout. */
  autoHideOnEmpty?: boolean;
}

const KnowledgeViewer: React.FC<KnowledgeViewerProps> = ({ autoHideOnEmpty = true }) => {
  const { currentSession, currentSessionId } = useSessions();
  const workBenchFiles = useWorkBenchFiles(currentSessionId);
  const { systemFiles } = useSystemPromptFiles();
  const { subscribeToAction } = useWebsocket();
  const { setWorkBenchFiles } = useWorkBenchActions();

  // Files attached to individual messages
  const messageFiles = useMessageFiles(currentSessionId);

  const pendingMessageFilesRaw = useSessionLayout(s => s.pendingMessageFiles);
  const pendingMessageFiles = useMemo(() => pendingMessageFilesRaw || [], [pendingMessageFilesRaw]);

  const [isLoading, setIsLoading] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  // Publish-and-share for the artifact currently in the viewer.
  const shareUser = useUser(s => s.currentUser);
  // Active account-switcher org (null in personal context) - enables Team/org-scoped publishing.
  const selectedAccount = useSelectedAccount(s => s.selectedAccount);
  const activeOrg = selectedAccount && !selectedAccount.personal ? selectedAccount : null;
  // Only offer Team for the org the server will accept: checkScopePermission gates org publishing
  // on user.organizationId, so a multi-org member who selected a different (still valid) org would
  // be offered Team but 403 on publish. Gate the option on the match so the UI never invites a
  // rejected action.
  const teamOrg = activeOrg && String(activeOrg.id) === String(shareUser?.organizationId) ? activeOrg : null;
  const { publishAndShare: publishAndShareArtifact, modal: artifactShareModal } = usePublishShare();
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDiffPreviewOpen, setIsDiffPreviewOpen] = useState(false);
  const [editResult, setEditResult] = useState<any>(null);
  const [fileRefreshKey, setFileRefreshKey] = useState(0);
  const [showBlogPreviewModal, setShowBlogPreviewModal] = useState(false);
  const [blogPreviewContent, setBlogPreviewContent] = useState<string>('');
  const [blogPreviewTitle, setBlogPreviewTitle] = useState<string>('');
  const [blogPreviewSummary, setBlogPreviewSummary] = useState<string>('');
  const [blogPreviewTags, setBlogPreviewTags] = useState<string[]>([]);
  const model = useLLM(s => s.model);
  const artifactData = useSessionLayout(s => s.artifactData);
  const recentArtifacts = useSessionLayout(s => s.recentArtifacts);
  const selectedArtifactId = useSessionLayout(s => s.selectedArtifactId);
  const { canUseAdminTools } = useAdminTools();
  const isMobile = useIsMobile();
  const { selectedTabIndex, showLineNumbers } = useKnowledgeViewer();
  const layout = useSessionLayout(s => s.layout);
  const questExport = useQuestExport();
  const [markdownContent, setMarkdownContent] = useState<string | null>(null);
  const [migratedArtifactIds] = useState<Set<string>>(new Set());

  // Track previous session ID to detect actual session changes
  const prevSessionIdRef = useRef(currentSessionId);

  // Fetch latest artifact data if it's a Quest 4 artifact
  const isQuest4Artifact = artifactData?.id && artifactData.id.startsWith('artifact_');

  const { isPersisted: isArtifactPersistedState } = useArtifactPersistence(isQuest4Artifact ? artifactData?.id : null);

  const { data: latestArtifact } = useArtifact(
    isQuest4Artifact && isArtifactPersistedState === true ? artifactData?.id : null,
    {
      includeContent: true,
      includeVersions: false,
    }
  );

  // Ref tracks the last updated version to prevent infinite loops.
  const lastUpdatedVersionRef = React.useRef<number | undefined>(undefined);
  // The artifact id (and DB version at that moment) that the currently-shown content was
  // pinned to. Captured on (re)open so shouldSyncArtifactFromDb only adopts a strictly newer
  // persisted version, never the stale read during the async persist race (#457).
  const syncArtifactIdRef = React.useRef<string | undefined>(undefined);
  const syncBaselineVersionRef = React.useRef<number | undefined>(undefined);

  useEffect(() => {
    if (latestArtifact?.artifact.id && artifactData?.id && artifactData.id === latestArtifact.artifact.id) {
      // On switching to a different artifact, pin the baseline to the DB version present now
      // (the version the just-opened content sits at or ahead of) and reset loop tracking.
      // Re-baseline keys on the artifact id only, NOT on close/reopen of the same id. That is
      // safe because handleOpenInViewer invalidates the ['artifact', id] query on open and the
      // "content matches" short-circuit in shouldSyncArtifactFromDb covers a same-id reopen; a
      // refactor that removes either precondition must also re-pin the baseline on reopen.
      if (syncArtifactIdRef.current !== artifactData.id) {
        syncArtifactIdRef.current = artifactData.id;
        syncBaselineVersionRef.current = latestArtifact.artifact.version;
        lastUpdatedVersionRef.current = undefined;
      }

      if (lastUpdatedVersionRef.current === latestArtifact.artifact.version) {
        return;
      }

      // All Quest4 persisted artifact types share one envelope shape (id, type,
      // title, content, metadata, createdAt, updatedAt) and carry string content.
      // 'recharts' is excluded: its content is JSON (application/json) and is not
      // synced through this path, so it does not participate in KB artifact updates.
      const persistedTypes = ['react', 'html', 'svg', 'mermaid', 'python', 'lattice'] as const;
      type PersistedType = (typeof persistedTypes)[number];
      const isPersistedType = (persistedTypes as readonly string[]).includes(artifactData.type);

      // Skip when nothing changed (avoids an infinite loop) and never regress to an older
      // persisted version - see shouldSyncArtifactFromDb for the #457 rationale.
      // Loose cast: all persisted artifact shapes agree on `content: string`.
      const currentArtifact = artifactData.content as { content?: string; version?: number };

      const needsUpdate = shouldSyncArtifactFromDb({
        currentContent: currentArtifact.content,
        latestContent: latestArtifact.content?.content,
        latestVersion: latestArtifact.artifact.version,
        baselineVersion: syncBaselineVersionRef.current,
      });

      if (!needsUpdate) {
        // Advance the ref even when skipping, so this version is not rechecked.
        lastUpdatedVersionRef.current = latestArtifact.artifact.version;
        return;
      }

      if (isPersistedType && artifactData.content) {
        lastUpdatedVersionRef.current = latestArtifact.artifact.version;
        // Adopting a strictly newer version - advance the pinned baseline to it.
        syncBaselineVersionRef.current = latestArtifact.artifact.version;

        // Generic persisted-artifact envelope. Each concrete type (ReactArtifact,
        // HtmlArtifact, etc.) has this shape plus type-specific metadata; keep the
        // existing metadata and override fields from the DB response.
        const previous = artifactData.content as Record<string, unknown>;
        const updatedContent = {
          ...previous,
          id: latestArtifact.artifact.id, // actual persisted ID, with timestamp
          type: artifactData.type as PersistedType,
          title: latestArtifact.artifact.title || (previous.title as string | undefined),
          content: latestArtifact.content?.content || (previous.content as string | undefined),
          metadata: latestArtifact.artifact.metadata || previous.metadata,
          updatedAt: latestArtifact.artifact.updatedAt || previous.updatedAt,
          version: latestArtifact.artifact.version,
          // any: Union of persisted artifact types share this envelope; a precise
          // discriminated-union construction would require a large switch for no
          // runtime benefit.
        } as any;

        setSessionLayout({
          layout: useSessionLayout.getState().layout,
          artifactData: {
            type: artifactData.type,
            content: updatedContent,
            mimeType: artifactData.mimeType,
            id: latestArtifact.artifact.id, // Use the actual persisted ID
          },
          selectedArtifactId: artifactData.id,
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    latestArtifact?.artifact.id,
    latestArtifact?.artifact.version,
    latestArtifact?.content?.content,
    artifactData?.id,
    artifactData?.type,
    // artifactData.content is omitted deliberately: including it loops forever.
    // Changes to it are detected inside the effect instead.
    artifactData?.mimeType,
    latestArtifact?.artifact.title,
    latestArtifact?.artifact.updatedAt,
    latestArtifact?.artifact.metadata,
  ]); // list specific properties, not whole objects

  // Clean up legacy artifacts from localStorage when they've been migrated
  useEffect(() => {
    if (artifactData?.id && artifactData.type === 'react') {
      const isLegacyId = !artifactData.id.startsWith('artifact_');

      // If this is a legacy ID that we've already migrated, clear it
      if (isLegacyId && migratedArtifactIds.has(artifactData.id)) {
        setSessionLayout({
          artifactData: undefined,
          selectedArtifactId: undefined,
        });
      }
    }
  }, [artifactData?.id, artifactData?.type, migratedArtifactIds]);

  const knowledgeItems = useMemo(() => {
    const items: KnowledgeItem[] = [];

    // Add workbench files
    workBenchFiles.forEach(file => {
      items.push({
        id: file.id,
        type: 'file' as const,
        content: file,
        title: file.fileName,
        timestamp: file.createdAt ? new Date(file.createdAt).getTime() : 0, // Use 0 instead of Date.now() for stability
      });
    });

    // Add system prompt files
    systemFiles.forEach(file => {
      items.push({
        id: `system-${file.id}`, // Prefix to distinguish from workbench files
        type: 'file' as const,
        content: file,
        title: `[System] ${file.fileName}`,
        timestamp: file.createdAt ? new Date(file.createdAt).getTime() : 0, // Use 0 instead of Date.now() for stability
      });
    });

    // Add message files (files attached to individual messages, not the session)
    messageFiles.forEach(file => {
      items.push({
        id: file.id,
        type: 'file' as const,
        content: file,
        title: file.fileName,
        timestamp: file.createdAt ? new Date(file.createdAt).getTime() : 0,
      });
    });

    // Add completed pending message files (files being uploaded but not yet sent)
    // Filter out duplicates - only add if not already in messageFiles
    const messageFileIds = new Set(messageFiles.map(f => f.id));
    const workBenchFileIds = new Set(workBenchFiles.map(f => f.id));
    const systemFileIds = new Set(systemFiles.map(f => f.id));

    pendingMessageFiles
      .filter(item => item.status === 'complete')
      .forEach(item => {
        // Skip if already in messageFiles, workBenchFiles, or systemFiles
        if (
          messageFileIds.has(item.fabFile.id) ||
          workBenchFileIds.has(item.fabFile.id) ||
          systemFileIds.has(item.fabFile.id)
        ) {
          return;
        }
        items.push({
          id: item.fabFile.id,
          type: 'file' as const,
          content: item.fabFile,
          title: item.fabFile.fileName,
          timestamp: item.fabFile.createdAt ? new Date(item.fabFile.createdAt).getTime() : 0,
        });
      });

    // Stable timestamp derived from the artifact ID (avoids infinite loops).
    // IDs follow artifact_type_identifier_timestamp_index; extract the timestamp part.
    const getStableTimestamp = (id: string): number => {
      const parts = id.split('_');
      if (parts.length >= 4 && !isNaN(Number(parts[3]))) {
        return Number(parts[3]);
      }
      // Fallback: use a hash of the ID for stability
      return id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    };

    // Add all recentArtifacts to knowledgeItems
    recentArtifacts.forEach(artifact => {
      const artifactTimestamp = getStableTimestamp(artifact.id);

      switch (artifact.type) {
        case 'questmaster':
          items.push({
            id: artifact.id,
            type: 'questmaster',
            content: artifact.content as string,
            title: (artifact.content as QuestMasterData).title || 'Quest Plan',
            timestamp: artifactTimestamp,
          });
          break;
        case 'code':
          items.push({
            id: artifact.id,
            type: 'code',
            content: artifact.content as CodeArtifactData,
            title: (artifact.content as CodeArtifactData).title || 'Code',
            timestamp: artifactTimestamp,
          });
          break;
        case 'mermaid':
          items.push({
            id: artifact.id,
            type: 'mermaid',
            content: artifact.content as MermaidArtifact,
            title: (artifact.content as MermaidArtifact).title || 'Mermaid',
            timestamp: artifactTimestamp,
          });
          break;
        case 'recharts':
          items.push({
            id: artifact.id,
            type: 'recharts',
            content: artifact.content as RechartsArtifact,
            title: (artifact.content as RechartsArtifact).title || 'Interactive Chart',
            timestamp: artifactTimestamp,
          });
          break;
        case 'chess':
          items.push({
            id: artifact.id,
            type: 'chess',
            content: artifact.content as ChessArtifact,
            title: (artifact.content as ChessArtifact).title || 'Chess Game',
            timestamp: artifactTimestamp,
          });
          break;
        case 'react': {
          const reactArtifact = artifact.content as ReactArtifact;

          // Only use latestArtifact if it belongs to this React artifact.
          const isLatestArtifactForThisReact =
            latestArtifact?.artifact.id === reactArtifact.id && artifactData?.type === 'react';
          const artifactId = isLatestArtifactForThisReact ? latestArtifact.artifact.id : reactArtifact.id;

          items.push({
            id: artifactId,
            type: 'react' as const,
            content: {
              ...reactArtifact,
              id: artifactId,
            },
            title: reactArtifact.title || 'React Component',
            timestamp: reactArtifact.createdAt
              ? new Date(reactArtifact.createdAt).getTime()
              : getStableTimestamp(artifactId),
          });
          break;
        }
        case 'html':
          items.push({
            id: artifact.id,
            type: 'html',
            content: artifact.content as HtmlArtifact,
            title: (artifact.content as HtmlArtifact).title || 'HTML Page',
            timestamp: artifactTimestamp,
          });
          break;
        case 'svg':
          items.push({
            id: artifact.id,
            type: 'svg',
            content: artifact.content as SvgArtifact,
            title: (artifact.content as SvgArtifact).title || 'SVG Graphic',
            timestamp: artifactTimestamp,
          });
          break;
        case 'lattice':
          items.push({
            id: artifact.id,
            type: 'lattice',
            content: artifact.content as LatticeArtifact,
            title: (artifact.content as LatticeArtifact).title || 'Financial Model',
            timestamp: artifactTimestamp,
          });
          break;
        case 'python':
          items.push({
            id: artifact.id,
            type: 'python',
            content: artifact.content as PythonArtifact,
            title: (artifact.content as PythonArtifact).title || 'Python Script',
            timestamp: artifactTimestamp,
          });
          break;
        default:
          break;
      }
    });

    // Sort by timestamp, newest first
    items.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentArtifacts, workBenchFiles, systemFiles, messageFiles, pendingMessageFiles, latestArtifact?.artifact.id]);

  // Effect: Reset view when no selection
  useEffect(() => {
    // Also check recentArtifacts: knowledgeItems is briefly empty during the
    // re-render after clicking a code block, which would otherwise race.
    const hasSelected = knowledgeItems.length > 0 || recentArtifacts.length > 0;

    if (!hasSelected) {
      // Functional update, applied only when the value actually changes.
      setKnowledgeViewer(state => {
        if (state.selectedTabIndex !== 0) {
          return { ...state, selectedTabIndex: 0 };
        }
        return state;
      });

      // Only auto-hide if enabled (default). Pages like /opti disable this
      // to keep their floatingChat layout stable.
      if (autoHideOnEmpty) {
        const currentLayout = useSessionLayout.getState().layout;
        if (currentLayout !== 'hide') {
          setSessionLayout({ layout: 'hide' });
        }
      }
    }
  }, [knowledgeItems.length, recentArtifacts.length, autoHideOnEmpty]); // Also watch recentArtifacts to prevent hiding during state updates

  // Effect: Auto-switch tab when selectedArtifactId changes.
  useEffect(() => {
    if (!selectedArtifactId) return;

    const targetIndex = knowledgeItems.findIndex(item => item.id === selectedArtifactId);

    if (targetIndex !== -1 && targetIndex !== selectedTabIndex) {
      // Only update when different, to prevent infinite loops.
      setKnowledgeViewer({ selectedTabIndex: targetIndex });
    }
  }, [selectedArtifactId, knowledgeItems, selectedTabIndex]);

  // Effect: Clear artifacts when switching notebooks/sessions (fixes "knowledge preview goes blank" issue)
  useEffect(() => {
    // Only clear if session ID actually changed (not just on re-render)
    if (prevSessionIdRef.current !== currentSessionId) {
      clearRecentArtifacts();
      prevSessionIdRef.current = currentSessionId;
    }
  }, [currentSessionId]);

  // Effect: Subscribe to streaming updates
  useEffect(() => {
    if (!currentSessionId) return;

    // Read current artifactData via getState so it is not an effect dependency.
    const getCurrentArtifactData = () => useSessionLayout.getState().artifactData;

    const unsubscribe = subscribeToAction('streamed_chat_completion', async (msg: IMessageDataToClient) => {
      if (msg.action !== 'streamed_chat_completion') return;
      if (!msg.quest || msg.quest.sessionId !== currentSessionId) return;

      const currentArtifactData = getCurrentArtifactData();
      if (!currentArtifactData?.type) return;

      // Safe to type-assert now that the action has been checked.
      const streamedMsg = msg as z.infer<typeof StreamedChatCompletionAction>;
      setIsLoading(!!streamedMsg.statusMessage);

      if (streamedMsg.quest?.id && currentArtifactData.type === 'questmaster' && currentArtifactData.id) {
        const questData: QuestMasterData = {
          id: streamedMsg.quest.id,
          title: streamedMsg.quest.questMasterReply || 'Quest',
          description: streamedMsg.quest.reply || '',
          complexity: 'medium',
          subQuests: [],
        };

        // Only update if content actually changed, to avoid an infinite loop.
        const currentContent = currentArtifactData.content as QuestMasterData;
        if (!currentContent || currentContent.description !== questData.description) {
          setSessionLayout({
            layout: useSessionLayout.getState().layout,
            artifactData: {
              ...currentArtifactData,
              content: questData,
            },
          });
        }
      }

      if (currentArtifactData.type === 'code' && currentArtifactData.id) {
        // Code artifacts need no update during streaming; a no-op here avoids a loop.
      }
    });

    return () => unsubscribe();
  }, [currentSessionId, subscribeToAction]); // stable dependencies only

  // Memoize the current item to prevent infinite loops.
  const currentItem = useMemo(() => {
    return knowledgeItems[selectedTabIndex];
  }, [knowledgeItems, selectedTabIndex]);

  // Keyed on primitive item props so it does not depend on the whole array.
  useEffect(() => {
    if (!currentItem?.id || currentItem.type !== 'file') {
      setMarkdownContent(null);
      return;
    }

    const fileContent = currentItem.content;
    const isMarkdown = isMarkdownFile(currentItem);

    if (!isMarkdown || !fileContent.fileUrl) {
      setMarkdownContent(null);
      return;
    }

    getContentFromFabfile({
      fileUrl: fileContent.fileUrl,
      mimeType: fileContent.mimeType,
    }).then(fetchedContent => {
      setMarkdownContent(fetchedContent || '');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentItem?.id, currentItem?.type]);

  const handleTabChange = (event: React.SyntheticEvent<Element, Event> | null, newValue: string | number | null) => {
    if (newValue === null) return;

    const newIndex = Number(newValue);
    setKnowledgeViewer(state => ({ ...state, selectedTabIndex: newIndex }));

    // Sync selectedArtifactId to prevent auto-switch from overriding manual selection
    const selectedItem = knowledgeItems[newIndex];
    if (selectedItem) {
      setSessionLayout({ selectedArtifactId: selectedItem.id });
    }
  };

  const handleEditSubmit = async (instruction: string, options: EditOptions) => {
    const currentItem = knowledgeItems[selectedTabIndex];
    if (!currentItem || currentItem.type !== 'file') return;

    const fileId = currentItem.content.id;

    try {
      const response = await api.post(`/api/fabfiles/${fileId}/edit`, {
        instruction,
        preserveFormatting: options.preserveFormatting,
        applyImmediately: options.applyImmediately,
        model,
        // Only send sessionId if it exists, backend will handle null case
        ...(currentSessionId && { sessionId: currentSessionId }),
      });

      if (options.applyImmediately) {
        toast.success('Edit applied successfully');
        // Refetch to get a fresh signed URL and bypass the cache.
        const refreshedFile = await getFabFileByIdFromServer(fileId);
        if (currentSessionId) {
          setWorkBenchFiles(
            currentSessionId,
            workBenchFiles.map(f => (f.id === fileId ? refreshedFile : f))
          );
        }
        setFileRefreshKey(prev => prev + 1);
      } else if (options.returnDiff) {
        setEditResult(response.data);
        setIsDiffPreviewOpen(true);
        setIsEditDialogOpen(false);
      }
    } catch (error) {
      console.error('Edit failed:', error);
      toast.error('Failed to generate edit');
      throw error; // Re-throw to let EditFileDialog handle it
    }
  };

  const handleApplyEdit = async () => {
    if (!editResult) return;

    const currentItem = knowledgeItems[selectedTabIndex];
    if (!currentItem || currentItem.type !== 'file') return;

    const fileId = currentItem.content.id;

    try {
      await api.post(`/api/fabfiles/${fileId}/apply-edit`, {
        newContent: editResult.modified,
      });

      toast.success('Changes applied successfully');
      setIsDiffPreviewOpen(false);
      setEditResult(null);

      // Refetch to get a fresh signed URL and bypass the cache.
      const refreshedFile = await getFabFileByIdFromServer(fileId);
      if (currentSessionId) {
        setWorkBenchFiles(
          currentSessionId,
          workBenchFiles.map(f => (f.id === fileId ? refreshedFile : f))
        );
      }
      setFileRefreshKey(prev => prev + 1);
    } catch (error) {
      console.error('Apply edit failed:', error);
      toast.error('Failed to apply changes');
    }
  };

  const handleRejectEdit = () => {
    setIsDiffPreviewOpen(false);
    setEditResult(null);
  };

  const handlePublishClick = async () => {
    const currentItem = knowledgeItems[selectedTabIndex];
    if (!currentItem) return;

    let contentToPublish = '';

    switch (currentItem.type) {
      case 'file':
        try {
          if (!currentItem.content.fileUrl) {
            toast.error('No file URL available');
            return;
          }
          const fetchedContent = await getContentFromFabfile({
            fileUrl: currentItem.content.fileUrl,
            mimeType: currentItem.content.mimeType,
          });
          contentToPublish = fetchedContent || '';
        } catch (error) {
          console.error('Error fetching file content:', error);
          toast.error('Failed to fetch file content');
          return;
        }
        break;
      case 'code':
        contentToPublish = currentItem.content.code;
        break;
      case 'mermaid':
        contentToPublish = `\`\`\`mermaid\n${currentItem.content.content}\n\`\`\``;
        break;
      case 'react':
        contentToPublish = `\`\`\`tsx\n${currentItem.content.content}\n\`\`\``;
        break;
      case 'html':
        contentToPublish = `\`\`\`html\n${currentItem.content.content}\n\`\`\``;
        break;
      case 'svg':
        contentToPublish = currentItem.content.content;
        break;
      case 'questmaster':
        contentToPublish = currentItem.content;
        break;
      case 'python':
        contentToPublish = `\`\`\`python\n${currentItem.content.content}\n\`\`\``;
        break;
      default:
        toast.error('Content type not supported for publishing');
        return;
    }

    setBlogPreviewContent(contentToPublish);

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
  };

  // Publish the artifact in the viewer to a public /p/u link + open the share bar.
  // Extracts a string body per type (mirrors the copy handler); html/svg publish
  // as real pages, other source types as a code view.
  const handleShareArtifact = () => {
    const item = knowledgeItems[selectedTabIndex];
    if (!item) return;
    if (!shareUser?.id) {
      toast.error('You must be signed in to publish');
      return;
    }
    let type: string = item.type;
    let content = '';
    // ArtifactData is a union with no top-level `title`; each case below sets it
    // from the per-type content. Fall back to a generic title.
    let title = 'Shared artifact';
    switch (item.type) {
      case 'html':
        content = item.content.content;
        title = item.content.title || title;
        break;
      case 'svg':
        content = item.content.content;
        title = item.content.title || title;
        break;
      case 'code':
        content = item.content.code;
        title = item.content.title || title;
        break;
      case 'mermaid':
      case 'react':
      case 'lattice':
      case 'python':
        content = item.content.content;
        title = (item.content as { title?: string }).title || title;
        break;
      case 'questmaster':
        type = 'code';
        content = typeof item.content === 'string' ? item.content : '';
        break;
      default:
        toast.error("This artifact type can't be published yet");
        return;
    }
    if (!content?.trim()) {
      toast.error('Nothing to publish in this artifact');
      return;
    }
    // The dialog detects a prior publication (via resolveExisting) and offers "update
    // existing" (a new version) vs "publish as new". Key BOTH the lookup and the publish
    // on the id of the exact tab being published (`item.id`, a stable artifact/file id),
    // NOT the session-layout active artifact (`artifactData`), which can be stale or
    // undefined on re-open and would fall back to an unstable positional index. A
    // positional id both misses the lookup AND gets written as source.artifactId,
    // corrupting the linkage. Mirrors the chat artifact-card path in ArtifactGallery.
    const artifactId = item.id;
    if (!artifactId) {
      toast.error('This artifact has no stable id to publish');
      return;
    }
    publishAndShareArtifact({
      title,
      ...(teamOrg ? { orgOption: { label: 'Team', hint: `Members of ${teamOrg.name}` } } : {}),
      ...buildArtifactPublishWiring({
        artifactId,
        type,
        content,
        title,
        userId: String(shareUser.id),
        orgId: teamOrg?.id,
      }),
    });
  };

  const handleCopy = async () => {
    const currentItem = knowledgeItems[selectedTabIndex];
    if (!currentItem) return;

    setIsCopying(true);

    try {
      switch (currentItem.type) {
        case 'file':
          if (currentItem.content.mimeType.startsWith('image/')) {
            if (!currentItem.content.fileUrl) {
              toast.error('No file URL available');
              return;
            }
            try {
              const response = await fetch(currentItem.content.fileUrl);
              if (!response.ok) {
                throw new Error(`Failed to fetch image: ${response.status}`);
              }
              const blob = await response.blob();

              await navigator.clipboard.write([
                new ClipboardItem({
                  [blob.type]: blob,
                }),
              ]);
              toast.success('Image copied to clipboard');
            } catch (error) {
              console.error('Error copying image:', error);
              // Fallback to copying URL if image copy fails
              await copyToClipboard(currentItem.content.fileUrl);
              toast.success('Image URL copied to clipboard');
            }
          } else {
            try {
              if (!currentItem.content.fileUrl) {
                toast.error('No file URL available');
                return;
              }
              const fetchedContent = await getContentFromFabfile({
                fileUrl: currentItem.content.fileUrl,
                mimeType: currentItem.content.mimeType,
              });

              if (currentItem.content.mimeType === 'application/json') {
                try {
                  const contentToCopy = JSON.stringify(JSON.parse(fetchedContent || ''), null, 2);
                  await copyToClipboard(contentToCopy);
                } catch (e) {
                  await copyToClipboard(fetchedContent || '');
                }
              } else {
                await copyToClipboard(fetchedContent || '');
              }
              toast.success('Content copied to clipboard');
            } catch (error) {
              console.error('Error fetching file content:', error);
              toast.error('Failed to fetch file content');
            }
          }
          break;
        case 'questmaster':
          await copyToClipboard(currentItem.content);
          toast.success('Content copied to clipboard');
          break;
        case 'code':
          await copyToClipboard(currentItem.content.code);
          toast.success('Content copied to clipboard');
          break;
        case 'mermaid':
          await copyToClipboard(currentItem.content.content);
          toast.success('Content copied to clipboard');
          break;
        case 'react':
          await copyToClipboard(currentItem.content.content);
          toast.success('React component copied to clipboard');
          break;
        case 'html':
          await copyToClipboard(currentItem.content.content);
          toast.success('HTML content copied to clipboard');
          break;
        case 'svg':
          await copyToClipboard(currentItem.content.content);
          toast.success('SVG content copied to clipboard');
          break;
        case 'lattice':
          await copyToClipboard(currentItem.content.content);
          toast.success('Lattice model JSON copied to clipboard');
          break;
        case 'python':
          await copyToClipboard(currentItem.content.content);
          toast.success('Python script copied to clipboard');
          break;
      }
    } finally {
      setTimeout(() => {
        setIsCopying(false);
      }, 2000);
    }
  };

  const handleDownload = async () => {
    const currentItem = knowledgeItems[selectedTabIndex];
    if (!currentItem) return;

    switch (currentItem.type) {
      case 'file':
        if (currentItem.content.mimeType.startsWith('image/')) {
          if (!currentItem.content.fileUrl) {
            toast.error('No file URL available');
            return;
          }
          window.open(currentItem.content.fileUrl, '_blank');
        } else if (currentItem.content.mimeType === 'text/markdown') {
          try {
            if (!currentItem.content.fileUrl) {
              toast.error('No file URL available');
              return;
            }
            const fetchedContent = await getContentFromFabfile({
              fileUrl: currentItem.content.fileUrl,
              mimeType: currentItem.content.mimeType,
            });
            setMarkdownContent(fetchedContent || '');
          } catch (error) {
            console.error('Error fetching file content:', error);
            toast.error('Failed to fetch file content');
          }
        } else {
          try {
            if (!currentItem.content.fileUrl) {
              toast.error('No file URL available');
              return;
            }
            // Fetch raw binary data to preserve file integrity (not extracted text)
            const response = await fetch(currentItem.content.fileUrl);
            if (!response.ok) {
              throw new Error(`Download failed: ${response.status}`);
            }
            const blob = await response.blob();
            downloadData(blob, currentItem.content.fileName, currentItem.content.mimeType);
          } catch (error) {
            console.error('Error fetching file content:', error);
            toast.error('Failed to download file');
          }
        }
        break;
      case 'questmaster':
        // Use the async export feature for QuestMaster plans
        questExport.startExport(currentItem.content);
        break;
      case 'code':
        downloadFile(
          currentItem.content.code,
          `${currentItem.content.title || 'code'}.${currentItem.content.language || 'txt'}`,
          'text/plain'
        );
        break;
      case 'mermaid':
        downloadFile(currentItem.content.content, `${currentItem.content.title || 'diagram'}.mmd`, 'text/plain');
        break;
      case 'react':
        downloadFile(currentItem.content.content, `${currentItem.content.title || 'component'}.tsx`, 'text/typescript');
        break;
      case 'html':
        downloadFile(currentItem.content.content, `${currentItem.content.title || 'page'}.html`, 'text/html');
        break;
      case 'svg':
        downloadFile(currentItem.content.content, `${currentItem.content.title || 'graphic'}.svg`, 'image/svg+xml');
        break;
      case 'lattice':
        downloadFile(currentItem.content.content, `${currentItem.content.title || 'model'}.json`, 'application/json');
        break;
      case 'python':
        downloadFile(currentItem.content.content, `${currentItem.content.title || 'script'}.py`, 'text/x-python');
        break;
    }
  };

  if (knowledgeItems.length === 0) return null;

  return (
    <Stack
      className="knowledge-viewer-container"
      sx={(theme: Theme) => ({
        height: '100%',
        border: '1px solid',
        borderColor: theme.palette.divider,
        borderRadius: '8px',
        background: theme.palette.background.body,
        position: 'relative',
      })}
    >
      <Box
        className="knowledge-viewer-header"
        sx={(theme: Theme) => ({
          borderBottom: '1px solid',
          borderColor: theme.palette.divider,
          p: '10px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        })}
      >
        <Box
          sx={{
            display: 'grid',
            // On phones the toolbar has too many icon buttons to fit beside the file
            // selector, so stack them (selector on top, controls below) and let the
            // controls row wrap - otherwise download/close overflow off-screen (#457).
            gridTemplateColumns: isMobile ? '1fr' : '1fr auto',
            gap: '1rem',
            width: '100%',
          }}
        >
          <Grid sm xs={12}>
            <Select
              className="knowledge-viewer-select"
              size="sm"
              sx={(theme: Theme) => ({ flexGrow: 1, width: '100%' })}
              indicator={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px', pointerEvents: 'none' }}>
                  {knowledgeItems.length > 1 && (
                    <Box component="span" fontSize={'80%'} sx={(theme: Theme) => ({ opacity: '0.5' })}>
                      {knowledgeItems.length} files
                    </Box>
                  )}
                  <ExpandMore />
                </Box>
              }
              value={selectedTabIndex}
              onChange={handleTabChange}
            >
              {knowledgeItems.map((file, index) => (
                <Option key={index} value={index} label={file.title}>
                  {file.title}
                </Option>
              ))}
            </Select>
          </Grid>

          <Grid
            sx={(theme: Theme) => ({
              display: 'flex',
              flexWrap: 'wrap',
              rowGap: '8px',
              gap: '8px',
              justifyContent: isMobile ? 'flex-start' : 'flex-end',
              '& .MuiSvgIcon-root, .lucide-picture-in-picture, .lucide-x': {
                height: '16px',
                width: '16px',
              },
              '& .MuiIconButton-root:hover': {
                backgroundColor: theme.palette.neutral.softHoverBg,
              },
            })}
            xs
          >
            <Tooltip title={showLineNumbers ? 'Hide Line Numbers' : 'Show Line Numbers'} disableInteractive>
              <IconButton
                size="sm"
                variant="solid"
                sx={(theme: Theme) => ({
                  borderColor: theme.palette.divider,
                  ...(showLineNumbers && {
                    backgroundColor: theme.palette.primary.softActiveBg,
                  }),
                })}
                onClick={() => setKnowledgeViewer({ showLineNumbers: !showLineNumbers })}
                data-testid="toggle-line-numbers"
              >
                <FormatListNumbered sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>

            <ButtonGroup className="knowledge-viewer-layout-controls" size="sm" variant="solid">
              <Tooltip title="Vertical" disableInteractive>
                <IconButton
                  size="sm"
                  sx={(theme: Theme) => ({
                    borderColor: theme.palette.divider,
                    ...(layout === 'vertical' && {
                      backgroundColor: theme.palette.primary.softActiveBg,
                    }),
                  })}
                  onClick={() => setSessionLayout({ layout: layout === 'vertical' ? 'hide' : 'vertical' })}
                >
                  <Splitscreen sx={{ rotate: '90deg' }} />
                </IconButton>
              </Tooltip>
              <Tooltip title="Horizontal" disableInteractive>
                <IconButton
                  size="sm"
                  sx={(theme: Theme) => ({
                    borderColor: theme.palette.divider,
                    ...(layout === 'horizontal' && {
                      backgroundColor: theme.palette.primary.softActiveBg,
                    }),
                  })}
                  onClick={() => setSessionLayout({ layout: layout === 'horizontal' ? 'hide' : 'horizontal' })}
                >
                  <Splitscreen />
                </IconButton>
              </Tooltip>

              <Tooltip title="Picture in Picture" disableInteractive>
                <IconButton
                  size="sm"
                  sx={(theme: Theme) => ({
                    borderColor: theme.palette.divider,
                    ...(layout === 'pip' && {
                      backgroundColor: theme.palette.primary.softActiveBg,
                    }),
                  })}
                  onClick={() => setSessionLayout({ layout: layout === 'pip' ? 'hide' : 'pip' })}
                >
                  <PictureInPictureIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>

              <Tooltip title="Floating Chat" disableInteractive>
                <IconButton
                  size="sm"
                  data-testid="floating-chat-layout-btn"
                  sx={(theme: Theme) => ({
                    borderColor: theme.palette.divider,
                    ...(layout === 'floatingChat' && {
                      backgroundColor: theme.palette.primary.softActiveBg,
                    }),
                  })}
                  onClick={() =>
                    setSessionLayout({
                      layout: layout === 'floatingChat' ? 'hide' : 'floatingChat',
                      previousLayout: layout !== 'floatingChat' ? layout : undefined,
                    })
                  }
                >
                  <OpenInNewIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>

              <Tooltip title="Hide AI" disableInteractive>
                <IconButton
                  size="sm"
                  sx={(theme: Theme) => ({
                    borderColor: theme.palette.divider,
                    ...(layout === 'noAI' && {
                      backgroundColor: theme.palette.primary.softActiveBg,
                    }),
                  })}
                  onClick={() => setSessionLayout({ layout: layout === 'noAI' ? 'hide' : 'noAI' })}
                >
                  <ExtensionOff />
                </IconButton>
              </Tooltip>
            </ButtonGroup>

            <ButtonGroup className="knowledge-viewer-action-buttons" size="sm" variant="solid" sx={{ ml: 1 }}>
              {knowledgeItems[selectedTabIndex]?.type === 'file' && (
                <Tooltip title={buttonTooltipTitle(knowledgeItems[selectedTabIndex])} disableInteractive>
                  <span>
                    <IconButton
                      size="sm"
                      onClick={() => setIsEditDialogOpen(true)}
                      sx={(theme: Theme) => ({
                        borderColor: theme.palette.divider,
                      })}
                      disabled={
                        !isMarkdownFile(knowledgeItems[selectedTabIndex]) ||
                        !isWithinSizeLimit(knowledgeItems[selectedTabIndex])
                      }
                      data-testid="knowledgeviewer-ai-edit-btn"
                    >
                      <EditOutlinedIcon />
                    </IconButton>
                  </span>
                </Tooltip>
              )}
              {canUseAdminTools && (
                <Tooltip title="Publish" disableInteractive>
                  <IconButton
                    size="sm"
                    onClick={handlePublishClick}
                    sx={(theme: Theme) => ({
                      borderColor: theme.palette.divider,
                    })}
                    data-testid="knowledgeviewer-publish-btn"
                  >
                    <SendIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
              )}
              <Tooltip
                title={
                  knowledgeItems[selectedTabIndex]?.type === 'questmaster'
                    ? 'Use Export for Quest Plans'
                    : isCopying
                      ? 'Copied!'
                      : 'Copy Content'
                }
                disableInteractive
              >
                <span>
                  <IconButton
                    size="sm"
                    onClick={handleCopy}
                    disabled={knowledgeItems[selectedTabIndex]?.type === 'questmaster'}
                    sx={(theme: Theme) => ({
                      borderColor: theme.palette.divider,
                      ...(isCopying && {
                        backgroundColor: theme.palette.success.softActiveBg,
                        '&:hover': {
                          backgroundColor: theme.palette.success.softActiveBg,
                        },
                      }),
                    })}
                  >
                    {isCopying ? <CheckIcon sx={{ fontSize: 16 }} /> : <ContentCopyIcon sx={{ fontSize: 16 }} />}
                  </IconButton>
                </span>
              </Tooltip>
              {knowledgeItems[selectedTabIndex]?.type !== 'file' && (
                <Tooltip title="Publish to public link" disableInteractive>
                  <span>
                    <IconButton size="sm" onClick={handleShareArtifact} data-testid="artifact-viewer-share">
                      <ShareIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </span>
                </Tooltip>
              )}
              {artifactShareModal}
              {isMarkdownFile(knowledgeItems[selectedTabIndex]) ? (
                <DownloadMenu
                  content={markdownContent || ''}
                  fileName={
                    knowledgeItems[selectedTabIndex].type === 'file'
                      ? knowledgeItems[selectedTabIndex].content.fileName
                      : ''
                  }
                  onClose={() => {}}
                />
              ) : (
                <Tooltip
                  title={
                    knowledgeItems[selectedTabIndex]?.type === 'questmaster'
                      ? questExport.isExporting
                        ? `Exporting... ${questExport.progress}%`
                        : 'Export Quest Plan'
                      : 'Download Content'
                  }
                  disableInteractive
                >
                  <IconButton
                    size="sm"
                    onClick={handleDownload}
                    disabled={questExport.isExporting || questExport.isStarting}
                    sx={(theme: Theme) => ({
                      borderColor: theme.palette.divider,
                    })}
                  >
                    {questExport.isExporting ? (
                      <CircularProgress size="sm" sx={{ '--CircularProgress-size': '16px' }} />
                    ) : (
                      <FileDownloadOutlinedIcon sx={{ fontSize: 16 }} />
                    )}
                  </IconButton>
                </Tooltip>
              )}
            </ButtonGroup>

            <Tooltip title="Close Knowledge Preview" disableInteractive>
              <IconButton size="sm" variant={'soft'} onClick={() => setSessionLayout({ layout: 'hide' })}>
                <CloseIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          </Grid>
        </Box>
      </Box>

      <Box className="knowledge-viewer-content" sx={{ flexGrow: 1, overflow: 'auto', p: 2, height: '100%' }}>
        <Tabs value={selectedTabIndex} sx={{ height: '100%' }}>
          {knowledgeItems.map((item, index) => (
            <TabPanel
              key={`${item.id}-${item.timestamp}`}
              value={index}
              sx={{
                display: selectedTabIndex === index ? 'block' : 'none',
                height: '100%',
                p: 0,
                '& > div': {
                  // Target immediate child div
                  height: '100%',
                  flex: 1,
                },
              }}
            >
              <Box
                sx={(theme: Theme) => ({
                  backgroundColor: 'background.level2',
                  borderRadius: '4px',
                  height: '100%',
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                })}
              >
                <KnowledgeContent
                  item={item}
                  isLoading={isLoading}
                  currentSession={currentSession}
                  refreshKey={fileRefreshKey}
                  showLineNumbers={showLineNumbers}
                />
              </Box>
            </TabPanel>
          ))}
        </Tabs>
      </Box>

      {/* Edit File Dialog */}
      {knowledgeItems[selectedTabIndex]?.type === 'file' && (
        <EditFileDialog
          open={isEditDialogOpen}
          onClose={() => setIsEditDialogOpen(false)}
          file={knowledgeItems[selectedTabIndex].content}
          onSubmit={handleEditSubmit}
        />
      )}

      {/* Diff Preview Dialog */}
      {editResult && (
        <DiffPreview
          open={isDiffPreviewOpen}
          onClose={() => setIsDiffPreviewOpen(false)}
          fileName={
            knowledgeItems[selectedTabIndex]?.type === 'file' ? knowledgeItems[selectedTabIndex].content.fileName : ''
          }
          original={editResult.original}
          modified={editResult.modified}
          diff={editResult.diff}
          onApply={handleApplyEdit}
          onReject={handleRejectEdit}
        />
      )}

      {/* Blog Preview Modal */}
      <ContentPreviewModal
        open={showBlogPreviewModal}
        onClose={() => setShowBlogPreviewModal(false)}
        initialTitle={blogPreviewTitle}
        initialContent={blogPreviewContent}
        initialSummary={blogPreviewSummary}
        initialTags={blogPreviewTags}
      />
    </Stack>
  );
};

// Separate component for rendering different content types
const KnowledgeContent: React.FC<{
  item: KnowledgeItem;
  isLoading: boolean;
  currentSession: ISessionDocument | null;
  refreshKey?: number;
  showLineNumbers?: boolean;
}> = ({ item, isLoading, currentSession, refreshKey, showLineNumbers = false }) => {
  // Lazy loading state for large code blocks
  const [isCodeContentReady, setIsCodeContentReady] = React.useState(true);
  // Lazy loading effect for large code blocks to prevent UI freeze
  React.useEffect(() => {
    if (item.type !== 'code') {
      setIsCodeContentReady(true);
      return;
    }

    const codeData = item.content as CodeArtifactData;
    const isLargeCodeBlock = codeData.lineCount > 300 || codeData.code.length > 30000;

    if (!isLargeCodeBlock) {
      setIsCodeContentReady(true);
      return;
    }

    // For large code blocks, defer rendering
    setIsCodeContentReady(false);
    const callback = () => {
      setIsCodeContentReady(true);
    };

    if ('requestIdleCallback' in window) {
      const handle = window.requestIdleCallback(callback, { timeout: 1000 });
      return () => window.cancelIdleCallback(handle);
    } else {
      const handle = setTimeout(callback, 100);
      return () => clearTimeout(handle);
    }
  }, [item]);

  const queryClient = useQueryClient();
  const handleSaveReactArtifact = useCallback(
    async (updatedContent: string) => {
      if (!item || item.type !== 'react') {
        return;
      }

      const currentArtifact = item.content;

      // Optimistic update
      const updatedArtifact = {
        ...currentArtifact,
        content: updatedContent,
        updatedAt: new Date(),
        version: currentArtifact.version || 1,
      };

      setSessionLayout({
        layout: useSessionLayout.getState().layout,
        artifactData: {
          ...useSessionLayout.getState().artifactData!,
          content: updatedArtifact,
        },
      });

      try {
        const updatePayload = {
          title: currentArtifact.title,
          content: updatedContent,
          metadata: currentArtifact.metadata,
          // Only create a new version if content actually changed
          createNewVersion: updatedContent !== currentArtifact.content,
        };

        const response = await api.put(`/api/artifacts/${currentArtifact.id}`, updatePayload);

        toast.success('React component saved successfully!');

        // Invalidate version queries to refresh the dropdown
        queryClient.invalidateQueries({ queryKey: ['artifactVersions', currentArtifact.id] });
        queryClient.invalidateQueries({ queryKey: ['artifact', currentArtifact.id] });

        // Return the updated artifact data so the ReactArtifactViewer can update its version
        return response.data;
      } catch (updateError: any) {
        // Check for duplicate key error (artifact already exists)
        if (updateError?.response?.data?.error?.includes('duplicate key error')) {
          toast.success('Artifact already saved');
          return;
        }

        // If artifact doesn't exist (404), create it first
        if (updateError?.response?.status === 404 || updateError?.name === 'NotFoundError') {
          // Create the artifact in Quest 4 system with the original ID
          const createPayload = {
            id: currentArtifact.id, // Use the AI-generated ID directly
            type: 'react' as const,
            title: currentArtifact.title || 'React Component',
            description: 'Migrated React component from legacy system',
            content: updatedContent,
            visibility: 'private' as const,
            tags: [],
            sessionId: currentSession?.id, // Link artifact to current session
            version: 1, // Always start new artifacts at version 1
            metadata: {
              dependencies: currentArtifact.metadata?.dependencies || [],
              hasDefaultExport: currentArtifact.metadata?.hasDefaultExport ?? true,
              errorBoundary: currentArtifact.metadata?.errorBoundary ?? true,
              // Preserve legacy ID for reference
              legacyId: currentArtifact.id,
            },
          };

          const createResponse = await api.post('/api/artifacts', createPayload);

          // Switch the reference to the new Quest 4 ID.
          const newArtifactId = createResponse.data.artifact.id;

          const updatedArtifactWithNewId = {
            ...updatedArtifact,
            id: newArtifactId,
            version: 1,
          };

          setSessionLayout({
            layout: useSessionLayout.getState().layout,
            artifactData: {
              ...useSessionLayout.getState().artifactData!,
              content: updatedArtifactWithNewId,
              id: newArtifactId,
            },
            selectedArtifactId: newArtifactId,
          });

          if (currentSession) {
            try {
              await api.put(`/api/sessions/${currentSession.id}`, {
                artifactIds: [...(currentSession.artifactIds || []), newArtifactId],
              });
            } catch (error) {
              console.error('Failed to update session with new artifact ID:', error);
              // Continue anyway - the artifact is saved with sessionId
            }
          }

          toast.success('React component migrated and saved to Quest 4 system!');

          // Invalidate version queries to refresh the dropdown
          queryClient.invalidateQueries({ queryKey: ['artifactVersions', newArtifactId] });
          queryClient.invalidateQueries({ queryKey: ['artifact', newArtifactId] });

          // Return the created artifact data so the ReactArtifactViewer can update its version
          return createResponse.data;

          // Return here to prevent further processing with the old ID.
          return;
        } else {
          throw updateError;
        }
      }
    },
    [item, currentSession, queryClient]
  );

  const handleSavePythonArtifact = useCallback(
    async (updatedContent: string) => {
      if (!item || item.type !== 'python') {
        return;
      }

      const currentArtifact = item.content;

      // Optimistic update
      const updatedArtifact = {
        ...currentArtifact,
        content: updatedContent,
        updatedAt: new Date(),
        version: currentArtifact.version || 1,
      };

      setSessionLayout({
        layout: useSessionLayout.getState().layout,
        artifactData: {
          ...useSessionLayout.getState().artifactData!,
          content: updatedArtifact,
        },
      });

      try {
        const updatePayload = {
          title: currentArtifact.title,
          content: updatedContent,
          metadata: currentArtifact.metadata,
          createNewVersion: updatedContent !== currentArtifact.content,
        };

        const response = await api.put(`/api/artifacts/${currentArtifact.id}`, updatePayload);

        toast.success('Python script saved successfully!');

        queryClient.invalidateQueries({ queryKey: ['artifactVersions', currentArtifact.id] });
        queryClient.invalidateQueries({ queryKey: ['artifact', currentArtifact.id] });

        return response.data;
      } catch (updateError: any) {
        if (updateError?.response?.data?.error?.includes('duplicate key error')) {
          toast.success('Artifact already saved');
          return;
        }

        if (updateError?.response?.status === 404 || updateError?.name === 'NotFoundError') {
          const createPayload = {
            id: currentArtifact.id,
            type: 'python' as const,
            title: currentArtifact.title || 'Python Script',
            description: 'Python script artifact',
            content: updatedContent,
            visibility: 'private' as const,
            tags: [],
            sessionId: currentSession?.id,
            version: 1,
            metadata: {
              packages: currentArtifact.metadata?.packages || [],
              hasOutput: currentArtifact.metadata?.hasOutput ?? false,
              legacyId: currentArtifact.id,
            },
          };

          const createResponse = await api.post('/api/artifacts', createPayload);
          const newArtifactId = createResponse.data.artifact.id;

          const updatedArtifactWithNewId = {
            ...updatedArtifact,
            id: newArtifactId,
            version: 1,
          };

          setSessionLayout({
            layout: useSessionLayout.getState().layout,
            artifactData: {
              ...useSessionLayout.getState().artifactData!,
              content: updatedArtifactWithNewId,
              id: newArtifactId,
            },
            selectedArtifactId: newArtifactId,
          });

          if (currentSession) {
            try {
              await api.put(`/api/sessions/${currentSession.id}`, {
                artifactIds: [...(currentSession.artifactIds || []), newArtifactId],
              });
            } catch (error) {
              console.error('Failed to update session with new artifact ID:', error);
            }
          }

          toast.success('Python script saved!');

          queryClient.invalidateQueries({ queryKey: ['artifactVersions', newArtifactId] });
          queryClient.invalidateQueries({ queryKey: ['artifact', newArtifactId] });

          return createResponse.data;
        } else {
          throw updateError;
        }
      }
    },
    [item, currentSession, queryClient]
  );

  switch (item.type) {
    case 'file':
      // Use cache-busting when refreshKey > 0 (indicating a file was just edited)
      return (
        <FileContent
          file={item.content}
          signedUrl={item.content.fileUrl}
          fetching={isLoading}
          bustCache={refreshKey !== undefined && refreshKey > 0}
          showLineNumbers={showLineNumbers}
          key={refreshKey}
        />
      );
    case 'questmaster': {
      const questMasterPlanId = item.content;
      if (!currentSession) {
        return (
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
            <Typography level="body-lg">
              Send a message to the AI to begin your session and view this content.
            </Typography>
          </Box>
        );
      }
      return (
        <QuestMasterReply
          questMasterPlanId={questMasterPlanId}
          isInKnowledgeViewer={true}
          currentSession={currentSession}
        />
      );
    }
    case 'code': {
      const codeData = item.content;

      // Show loading state for large code blocks
      if (!isCodeContentReady) {
        return (
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
            <Stack spacing={2} alignItems="center">
              <CircularProgress size="sm" />
              <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
                Loading large code block ({codeData.lineCount} lines)...
              </Typography>
            </Stack>
          </Box>
        );
      }

      return (
        <Box sx={{ width: '100%', height: '100%', overflow: 'auto' }}>
          <SyntaxHighlighter
            language={codeData.language || 'typescript'}
            style={oneDark}
            showLineNumbers={showLineNumbers}
            customStyle={{
              margin: 0,
              borderRadius: '4px',
              minHeight: '100%',
            }}
          >
            {codeData.code}
          </SyntaxHighlighter>
        </Box>
      );
    }
    case 'mermaid': {
      const mermaidData = item.content;
      return (
        <Box
          sx={{ width: '100%', height: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', p: 2 }}
        >
          <MermaidChart chartDefinition={mermaidData.content} />
        </Box>
      );
    }
    case 'recharts': {
      const rechartsData = item.content;
      return (
        <Box
          sx={{
            width: '100%',
            height: '100%',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            p: 2,
            overflow: 'auto',
          }}
        >
          <RechartsRenderer
            config={rechartsData.content}
            title={rechartsData.title}
            description={rechartsData.metadata?.description}
            forceMode="artifact"
          />
        </Box>
      );
    }
    case 'chess': {
      const chessArtifact = item.content as ChessArtifact;
      const defaultFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      let fenStr: string;
      let parsedChessData: Record<string, unknown> = {};
      try {
        // Parse artifact content as JSON first (contains fen + full chess state)
        const content = chessArtifact.content;
        const parsed = typeof content === 'string' ? JSON.parse(content) : content;
        if (parsed && typeof parsed === 'object' && ('fen' in parsed || 'resultingFen' in parsed)) {
          fenStr = (parsed.fen || parsed.resultingFen || defaultFen) as string;
          parsedChessData = parsed;
        } else {
          throw new Error('Parsed chess content lacks FEN fields');
        }
      } catch {
        // Fall back to metadata.fen or raw content string
        const rawFen = chessArtifact.metadata?.fen ?? chessArtifact.content;
        fenStr = typeof rawFen === 'string' && rawFen.includes('/') ? rawFen : defaultFen;
      }
      const sessionId = currentSession?.id || '';
      return (
        <Box
          sx={{
            width: '100%',
            height: '100%',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            p: 2,
          }}
        >
          {sessionId ? (
            <InteractiveChessBoard
              chessData={{
                fen: fenStr,
                turn: (chessArtifact.metadata?.turn || parsedChessData.turn) as 'w' | 'b' | undefined,
                lastMove: chessArtifact.metadata?.lastMove as { from: string; to: string } | undefined,
                isCheck: (chessArtifact.metadata?.isCheck || parsedChessData.isCheck) as boolean | undefined,
                isCheckmate: (chessArtifact.metadata?.isCheckmate || parsedChessData.isCheckmate) as
                  boolean | undefined,
                isDraw: (chessArtifact.metadata?.isDraw || parsedChessData.isDraw) as boolean | undefined,
                isGameOver: (chessArtifact.metadata?.isGameOver || parsedChessData.isGameOver) as boolean | undefined,
                moveNumber: (chessArtifact.metadata?.moveNumber || parsedChessData.moveNumber) as number | undefined,
              }}
              sessionId={sessionId}
              size={480}
            />
          ) : (
            <ChessBoard fen={fenStr} size={480} />
          )}
        </Box>
      );
    }
    case 'react': {
      const reactData = item.content;
      return (
        <Box sx={{ width: '100%', height: '100%' }}>
          <ReactArtifactViewer artifact={reactData} onSave={handleSaveReactArtifact} />
        </Box>
      );
    }
    case 'html': {
      const htmlData = item.content;
      return (
        <Box sx={{ width: '100%', height: '100%' }}>
          <HtmlArtifactViewer artifact={htmlData} />
        </Box>
      );
    }
    case 'svg': {
      const svgData = item.content;
      return (
        <Box sx={{ width: '100%', height: '100%' }}>
          <SvgArtifactViewer artifact={svgData} />
        </Box>
      );
    }
    case 'lattice': {
      const latticeData = item.content;
      return (
        <Box sx={{ width: '100%', height: '100%' }}>
          <LatticeViewer artifact={latticeData} />
        </Box>
      );
    }
    case 'python': {
      const pythonData = item.content;
      return (
        <ErrorBoundary
          fallback={
            <Box
              sx={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                p: 3,
                bgcolor: 'background.level1',
              }}
            >
              <Typography level="title-md" color="danger" sx={{ mb: 1 }}>
                Python Viewer Error
              </Typography>
              <Typography level="body-sm" color="neutral">
                The Python viewer encountered an error. Try refreshing the page.
              </Typography>
            </Box>
          }
        >
          <Box sx={{ width: '100%', height: '100%' }}>
            <PythonArtifactViewer artifact={pythonData} onSave={handleSavePythonArtifact} />
          </Box>
        </ErrorBoundary>
      );
    }
    default:
      return <Typography>Unsupported content type</Typography>;
  }
};

const FileContent = ({
  file,
  signedUrl,
  fetching,
  bustCache = false,
  showLineNumbers = false,
}: {
  file: IFabFileDocument;
  signedUrl?: string;
  fetching: boolean;
  bustCache?: boolean;
  showLineNumbers?: boolean;
}) => {
  const [content, setContent] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [readyToShow, setReadyToShow] = useState(false);

  // The signed URL takes a while to be ready; wait for it before showing content.
  useEffect(() => {
    setReadyToShow(false);
    let timeoutId: NodeJS.Timeout | null = null;
    if (signedUrl) {
      setReadyToShow(true);
      return;
    }
    timeoutId = setTimeout(() => setReadyToShow(true), 10000);
    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [file?.id, signedUrl]);

  useEffect(() => {
    const fetchContent = async () => {
      if (!file?.mimeType) return;

      try {
        setIsLoading(true);

        // If the signed URL is expired or about to expire (within 5 minutes), refresh it
        if (
          !signedUrl ||
          (file.fileUrlExpireAt && new Date(file.fileUrlExpireAt).getTime() - Date.now() < 5 * 60 * 1000)
        ) {
          const refreshedFile = await getFabFileByIdFromServer(file.id);
          if (refreshedFile.fileUrl) {
            const fetchedContent = await getContentFromFabfile({
              fileUrl: refreshedFile.fileUrl,
              mimeType: file.mimeType,
              bustCache,
            });
            setContent(fetchedContent || '');
            return;
          }
        }

        const fetchedContent = await getContentFromFabfile({
          fileUrl: signedUrl || file.fileUrl,
          mimeType: file.mimeType,
          bustCache,
        });

        setContent(fetchedContent || '');
      } catch (error) {
        console.error('Error fetching file content:', error);
        setContent('');
      } finally {
        setIsLoading(false);
      }
    };

    fetchContent();
  }, [file?.id, file?.mimeType, file?.fileUrlExpireAt, file?.fileUrl, signedUrl, bustCache]); // specific file properties, not the whole file object

  if (!file || fetching || isLoading || !readyToShow) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <CircularProgress />
      </Box>
    );
  }

  switch (file.mimeType) {
    case SupportedFabFileMimeTypes.JPG:
    case SupportedFabFileMimeTypes.PNG:
    case SupportedFabFileMimeTypes.WEBP:
    case SupportedFabFileMimeTypes.GIF:
    case SupportedFabFileMimeTypes.SVG:
      if (!signedUrl) {
        return (
          <Stack display={'flex'} justifyContent={'center'} alignItems={'center'}>
            <Typography level="h1" color="danger">
              Missing Image URL
            </Typography>
            <Typography level="h2">Image content not available</Typography>
            <Stack direction="row" spacing={2}>
              <Typography level="h3" color="neutral">
                File Name:
              </Typography>
              <Typography level="h3">{file.fileName}</Typography>
            </Stack>
            <Stack direction="row" spacing={2}>
              <Typography level="h3" color="neutral">
                ID:
              </Typography>
              <Typography level="h3">{file.id}</Typography>
            </Stack>
          </Stack>
        );
      }
      return (
        <Box sx={(theme: Theme) => ({ width: '100%', height: '100%', p: 2 })}>
          <AspectRatio
            variant="outlined"
            ratio="16/9"
            objectFit="contain"
            sx={(theme: Theme) => ({
              width: '100%',
              borderRadius: 'sm',
              bgcolor: 'background.level1',
            })}
          >
            <img
              src={signedUrl}
              alt={file.fileName}
              loading="lazy"
              style={{
                objectFit: 'contain',
              }}
            />
          </AspectRatio>
        </Box>
      );
    case SupportedFabFileMimeTypes.PDF:
      if (!signedUrl) {
        return (
          <Stack display={'flex'} justifyContent={'center'} alignItems={'center'}>
            <Typography level="h1" color="danger">
              Missing S3 URL
            </Typography>
            <Typography level="h2">PDF content not available</Typography>
            <Stack direction="row" spacing={2}>
              <Typography level="h3" color="neutral">
                File Name:
              </Typography>
              <Typography level="h3">{file.fileName}</Typography>
            </Stack>
            <Stack direction="row" spacing={2}>
              <Typography level="h3" color="neutral">
                ID:
              </Typography>
              <Typography level="h3">{file.id}</Typography>
            </Stack>
          </Stack>
        );
      }
      return (
        <Box
          sx={{
            display: 'flex',
            width: '100%',
            height: '100%',
            '& > div': {
              // Target the PdfViewer's root div
              width: '100%',
              height: '100%',
              '& > div': {
                // Target PDF viewer's internal div
                height: '100%',
              },
            },
          }}
        >
          <PdfViewer file={signedUrl} filename={file.fileName} />
        </Box>
      );
    case SupportedFabFileMimeTypes.CSV:
      return <CSVViewer content={content} />;
    case SupportedFabFileMimeTypes.JSON:
      return <JSONViewer content={content} />;
    case SupportedFabFileMimeTypes.TXT_PLAIN:
      if (!signedUrl && readyToShow)
        return (
          <Stack display={'flex'} justifyContent={'center'} alignItems={'center'}>
            <Typography level="h1" color="danger">
              Missing Text Content
            </Typography>
            <Stack direction="row" spacing={2}>
              <Typography level="h3" color="neutral">
                File Name:
              </Typography>
              <Typography level="h3">{file.fileName}</Typography>
            </Stack>
            <Stack direction="row" spacing={2}>
              <Typography level="h3" color="neutral">
                ID:
              </Typography>
              <Typography level="h3">{file.id}</Typography>
            </Stack>
          </Stack>
        );

      return (
        <Stack
          display={'flex'}
          alignItems={'center'}
          sx={(theme: Theme) => ({
            backgroundColor: 'background.level2',
            borderRadius: '4px',
            height: '100%',
            overflow: 'auto',
          })}
        >
          <TextViewer content={content} />
        </Stack>
      );
    case SupportedFabFileMimeTypes.TXT_MARKDOWN:
    case SupportedFabFileMimeTypes.TXT_MD_LEGACY:
      if (content) {
        // Check if the content is a direct Mermaid diagram
        const isMermaidDiagram =
          /^graph\s/.test(content.trim()) ||
          /^sequenceDiagram\s/.test(content.trim()) ||
          /^classDiagram\s/.test(content.trim()) ||
          /^stateDiagram\s/.test(content.trim()) ||
          /^erDiagram\s/.test(content.trim()) ||
          /^gantt\s/.test(content.trim()) ||
          /^pie\s/.test(content.trim()) ||
          /^mindmap\s/.test(content.trim());

        // Check if the content is a Mermaid diagram wrapped in code blocks
        const mermaidMatch = content.match(/```mermaid\s*([\s\S]*?)```/);

        if (isMermaidDiagram || mermaidMatch) {
          return <MermaidChart chartDefinition={mermaidMatch ? mermaidMatch[1].trim() : content} />;
        }

        const wrappedContent = content.includes('```mermaid') ? `\`\`\`mermaid\n${content}\n\`\`\`` : content;

        return <MarkdownViewer content={wrappedContent} />;
      } else {
        return (
          <>
            <Stack display={'flex'} justifyContent={'center'} alignItems={'center'}>
              <Typography level="h1" color="danger">
                Markdown Content not Available
              </Typography>
              <Stack direction="row" spacing={2}>
                <Typography level="h3" color="neutral">
                  File Name:
                </Typography>
                <Typography level="h3">{file.fileName}</Typography>
              </Stack>
              <Stack direction="row" spacing={2}>
                <Typography level="h3" color="neutral">
                  ID:
                </Typography>
                <Typography level="h3">{file.id}</Typography>
              </Stack>
            </Stack>
          </>
        );
      }
    case SupportedFabFileMimeTypes.DOCX:
      if (signedUrl) {
        return (
          <Box sx={{ paddingX: 2, overflow: 'auto' }}>
            <DocxViewer fileUrl={signedUrl as string} />
          </Box>
        );
      } else {
        return (
          <>
            <Stack display={'flex'} justifyContent={'center'} alignItems={'center'}>
              <Typography level="h1">Error: DOCX content not available</Typography>
            </Stack>
          </>
        );
      }
    case SupportedFabFileMimeTypes.XLS:
    case SupportedFabFileMimeTypes.XLSX:
      if (signedUrl) {
        return <XLSXViewer fileUrl={signedUrl} />;
      } else {
        return (
          <Stack display={'flex'} justifyContent={'center'} alignItems={'center'}>
            <Typography level="h1">Error: Excel content not available</Typography>
          </Stack>
        );
      }
    // Programming languages
    case SupportedFabFileMimeTypes.JS:
    case SupportedFabFileMimeTypes.JSX:
    case SupportedFabFileMimeTypes.TS:
    case SupportedFabFileMimeTypes.TSX:
    case SupportedFabFileMimeTypes.PY:
    case SupportedFabFileMimeTypes.JAVA:
    case SupportedFabFileMimeTypes.CPP:
    case SupportedFabFileMimeTypes.CS:
    case SupportedFabFileMimeTypes.PHP:
    case SupportedFabFileMimeTypes.RUBY:
    case SupportedFabFileMimeTypes.GO:
    case SupportedFabFileMimeTypes.SWIFT:
    case SupportedFabFileMimeTypes.KOTLIN:
    case SupportedFabFileMimeTypes.RUST:
    // Web technologies
    case SupportedFabFileMimeTypes.CSS:
    case SupportedFabFileMimeTypes.LESS:
    case SupportedFabFileMimeTypes.SASS:
    case SupportedFabFileMimeTypes.SCSS:
    // Data serialization
    case SupportedFabFileMimeTypes.YAML:
    case SupportedFabFileMimeTypes.TOML:
    // Shell scripts
    case SupportedFabFileMimeTypes.SH:
    case SupportedFabFileMimeTypes.BASH:
      if (!content) {
        return (
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
            <Stack spacing={2}>
              <Typography level="h4" color="danger">
                Unable to load file content
              </Typography>
              <Typography level="body-sm" color="neutral">
                File: {file.fileName}
              </Typography>
            </Stack>
          </Box>
        );
      }
      return (
        <Box sx={{ width: '100%', height: '100%', overflow: 'auto' }}>
          <SyntaxHighlighter
            language={getLanguageFromFileName(file.fileName)}
            style={oneDark}
            showLineNumbers={showLineNumbers}
            customStyle={{
              margin: 0,
              borderRadius: '4px',
              minHeight: '100%',
              fontSize: '14px',
              lineHeight: '1.5',
            }}
          >
            {content}
          </SyntaxHighlighter>
        </Box>
      );
    default:
      return (
        <Stack display={'flex'} justifyContent={'center'} alignItems={'center'}>
          <Typography level="h1">No file selected</Typography>
        </Stack>
      );
  }
};

export default KnowledgeViewer;
