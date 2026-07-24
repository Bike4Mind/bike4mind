import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Typography, useTheme } from '@mui/joy';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import { useSessions, useWorkBenchActions } from '@client/app/contexts/SessionsContext';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import DataLakeTree from './DataLakeTree';
import DataLakeArticle from './DataLakeArticle';
import { deckBackground } from '@client/app/components/datalake/deckChrome';
import { useGetDataLakeArticles, useGetDataLakeTagCounts } from '@client/app/hooks/data/fabFiles';
import type { DataLakeBrowseSource } from '@client/app/hooks/data/fabFiles';
import { buildTagTree, getNodesAtPath } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import DataLakeIngestPickerModal from '@client/app/components/DataLakeWizard/DataLakeIngestPickerModal';
import { readDroppedItems } from '@client/app/utils/dropReader';
import { toast } from 'sonner';
import type { IFabFileDocument } from '@bike4mind/common';

interface DataLakeExplorerProps {
  onBack: () => void;
  onAskAbout: (prompt: string) => void;
  /** When set (from URL param), auto-select and display this article on mount. */
  articleId?: string | null;
  /** Which browse backend to read (default 'opti'). The standalone Data Lakes home
   *  passes 'datalakes' so non-Opti users can browse their own lakes. */
  source?: DataLakeBrowseSource;
  /** Root breadcrumb crumb label + handler (defaults to the Mission Hub crumb). */
  rootLabel?: string;
  /** When provided, the tree's gear button opens the lake management panel. */
  onManage?: () => void;
  /** When provided, the tree's blue + button opens the Create Lake wizard. */
  onCreateLake?: () => void;
  /**
   * Chat-first surface: when provided, this node (a full `SessionContainer`) fills the RIGHT
   * pane instead of `DataLakeArticle`, and file clicks open the rich `KnowledgeModal` viewer.
   * The parent owns/pre-creates the session (see issue #836). When absent, the legacy
   * markdown `DataLakeArticle` behavior is kept unchanged (back-compat for pinned consumers).
   */
  chatSlot?: React.ReactNode;
}

/** True only for drags carrying real files (not text/image-from-page drags). */
const isFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types ?? []).includes('Files');

export default function DataLakeExplorer({
  onAskAbout,
  articleId,
  source = 'opti',
  rootLabel = 'Data Lake',
  onManage,
  onCreateLake,
  chatSlot,
}: DataLakeExplorerProps) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const [breadcrumb, setBreadcrumb] = useState<string[]>([]);
  const [userSelectedFile, setUserSelectedFile] = useState<IFabFileDocument | null>(null);

  // Chat-first mode: clicking a file opens it INLINE in the chat's KnowledgeViewer (the split
  // "knowledge-viewer-container") rather than a modal - by adding it to the session workbench and
  // switching the layout to `vertical` (KnowledgeViewer left, chat right). The parent's
  // SessionContainer drives the global session context, so `currentSessionId` here is the
  // datalake chat's session. (#836)
  const usingChat = !!chatSlot;
  const { currentSessionId } = useSessions();
  const { setWorkBenchFiles } = useWorkBenchActions();
  // Id of the file most recently opened in the viewer, kept to highlight it in the tree.
  const [viewerFileId, setViewerFileId] = useState<string | null>(usingChat ? (articleId ?? null) : null);
  const openFileInViewer = useCallback(
    (file: IFabFileDocument) => {
      if (currentSessionId) {
        setWorkBenchFiles(currentSessionId, prev => (prev.some(f => f.id === file.id) ? prev : [...prev, file]));
      }
      // Show the KnowledgeViewer split and select this file's tab.
      setSessionLayout({ layout: 'vertical', selectedArtifactId: file.id });
      setViewerFileId(file.id);
    },
    [currentSessionId, setWorkBenchFiles]
  );

  // Drag-to-ingest: an overlay invites dropping files/folders, which then open a lake
  // picker that hands off to the append wizard. A counter ref avoids flicker as drag
  // events bubble across child nodes.
  const [isDragging, setIsDragging] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<File[] | null>(null);
  const dragDepth = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (isFileDrag(e)) e.preventDefault();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragging(false);
    // Prefer the items API (traverses folders); fall back to the flat files list for any
    // browser without it - mirrors the wizard's SourceSelectionStep handler.
    const files = e.dataTransfer.items?.length
      ? await readDroppedItems(e.dataTransfer.items)
      : Array.from(e.dataTransfer.files);
    if (files.length === 0) {
      toast.error('No files found in that drop.');
      return;
    }
    setDroppedFiles(files);
  }, []);

  // Phase 1: Lightweight counts for the tree (server-side aggregation, ~50 entries)
  const { data: tagCountsData, isLoading: tagCountsLoading, isError: tagCountsError } = useGetDataLakeTagCounts(source);
  const tree = buildTagTree(tagCountsData?.tagCounts ?? []);

  // Derive the current leaf tag from breadcrumb + tree state
  const currentNodes = getNodesAtPath(tree, breadcrumb);
  const leafTag = breadcrumb.length > 0 && currentNodes.length === 0 ? breadcrumb.join(':') : null;

  // Phase 2: Fetch articles only when at a leaf node (filtered by tag, paginated)
  const { data: leafArticlesResult, isLoading: leafLoading } = useGetDataLakeArticles(
    leafTag ? { tags: [leafTag], limit: 50 } : null,
    source
  );
  const leafArticles = leafTag ? (leafArticlesResult?.data ?? []) : [];

  // Deep-link: fetch the specific article by ID when URL param is present. The inline viewer
  // needs the FabFile OBJECT (to add to the workbench), so chat mode fetches it too.
  const { data: deepLinkResult } = useGetDataLakeArticles(
    articleId && !userSelectedFile ? { id: articleId, limit: 1 } : null,
    source
  );
  // Derive selectedFile (used by the legacy DataLakeArticle fallback): explicit click first,
  // then the deep-link result. Pure derivation - no effects, no setState during render.
  const deepLinkTarget = deepLinkResult?.data?.[0] ?? null;
  const selectedFile = userSelectedFile ?? (articleId ? deepLinkTarget : null);

  // Chat mode deep-link: open the URL's article in the inline viewer once it resolves. Guarded
  // so it fires once per id (closing the viewer or re-rendering won't reopen it).
  const openedDeepLinkRef = useRef<string | null>(null);
  useEffect(() => {
    if (usingChat && deepLinkTarget && openedDeepLinkRef.current !== deepLinkTarget.id) {
      openedDeepLinkRef.current = deepLinkTarget.id;
      openFileInViewer(deepLinkTarget);
    }
  }, [usingChat, deepLinkTarget, openFileInViewer]);

  const handleNavigate = useCallback(
    (newBreadcrumb: string[]) => {
      setBreadcrumb(newBreadcrumb);
      setUserSelectedFile(null);
      // Browsing away closes the inline file viewer, returning to the full-width chat.
      if (usingChat) {
        setSessionLayout({ layout: 'hide' });
        setViewerFileId(null);
      }
    },
    [usingChat]
  );

  const handleSelectFile = useCallback(
    (file: IFabFileDocument) => {
      if (usingChat) {
        openFileInViewer(file);
      } else {
        setUserSelectedFile(file);
      }
    },
    [usingChat, openFileInViewer]
  );

  // Quick dives for the empty state: richest second-level categories across prefixes
  const quickDives = useMemo(
    () =>
      tree
        .flatMap(prefix =>
          prefix.children.map(child => ({
            path: [prefix.segment, child.segment],
            segment: child.segment,
            count: child.fileCount,
          }))
        )
        .sort((a, b) => b.count - a.count)
        .slice(0, 6),
    [tree]
  );

  return (
    <Box
      data-testid="opti-datalake-explorer"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      sx={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: deckBackground(isDark),
      }}
    >
      {isDragging && (
        <Box
          data-testid="opti-datalake-dropzone"
          sx={{
            position: 'absolute',
            inset: 12,
            zIndex: 10,
            borderRadius: 'lg',
            border: '2px dashed',
            borderColor: 'primary.400',
            backgroundColor: 'rgba(0,0,0,0.55)',
            backdropFilter: 'blur(2px)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1.5,
            pointerEvents: 'none',
          }}
        >
          <CloudUploadIcon sx={{ fontSize: 56, color: 'primary.300' }} />
          <Typography level="h4" sx={{ color: 'common.white' }}>
            Drop to add to a data lake
          </Typography>
          <Typography level="body-sm" sx={{ color: 'rgba(255,255,255,0.7)' }}>
            Files or folders — you&apos;ll pick the destination next
          </Typography>
        </Box>
      )}
      <Box
        className="datalake-explorer-body"
        sx={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden', p: '12px', gap: '8px' }}
      >
        <DataLakeTree
          tree={tree}
          articles={leafArticles}
          breadcrumb={breadcrumb}
          onNavigate={handleNavigate}
          selectedFileId={usingChat ? viewerFileId : (selectedFile?.id ?? null)}
          onSelectFile={handleSelectFile}
          isLoading={tagCountsLoading || (!!leafTag && leafLoading)}
          isError={tagCountsError}
          title={rootLabel}
          onManage={onManage}
          onCreateLake={onCreateLake}
        />
        {chatSlot ? (
          <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
            {chatSlot}
          </Box>
        ) : (
          <DataLakeArticle
            file={selectedFile}
            onAskAbout={onAskAbout}
            quickDives={quickDives}
            onDive={handleNavigate}
          />
        )}
      </Box>

      {/* Drag-to-ingest: pick a destination lake, then the append wizard takes over.
          The wizard modal is a store-driven singleton already mounted by FileBrowser
          via ProviderBundle (live on the /opti route too), so we drive it through the
          store and must NOT mount a second instance here — that would stack a
          duplicate wizard. */}
      <DataLakeIngestPickerModal
        open={droppedFiles !== null}
        files={droppedFiles ?? []}
        onClose={() => setDroppedFiles(null)}
      />
    </Box>
  );
}
