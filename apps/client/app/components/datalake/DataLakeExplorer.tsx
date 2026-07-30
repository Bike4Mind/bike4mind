import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Typography } from '@mui/joy';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import { useSessions, useWorkBenchActions } from '@client/app/contexts/SessionsContext';
import useSetDataLakeMode from '@client/app/hooks/useSetDataLakeMode';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { useNotebookLayout } from '@client/app/components/layouts/Notebook';
import DataLakeTree from './DataLakeTree';
import { DataLakeNavProvider } from './dataLakeNavContext';
import { useGetDataLakeArticles, useGetDataLakeTagCounts } from '@client/app/hooks/data/fabFiles';
import type { DataLakeBrowseSource } from '@client/app/hooks/data/fabFiles';
import { buildTagTree, getNodesAtPath } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import DataLakeIngestPickerModal from '@client/app/components/DataLakeWizard/DataLakeIngestPickerModal';
import { readDroppedItems } from '@client/app/utils/dropReader';
import { DATA_LAKES } from '@client/app/components/datalake/dataLakeBranding';
import { toast } from 'sonner';
import type { IFabFileDocument } from '@bike4mind/common';

interface DataLakeExplorerProps {
  /** @deprecated Unused; accepted only so the currently PINNED premium overlay (which still
   *  passes it) keeps typechecking against main. Remove with the next overlay pin bump. */
  onBack?: () => void;
  /** @deprecated Unused; accepted only so the currently PINNED premium overlay (which still
   *  passes it) keeps typechecking against main. Remove with the next overlay pin bump. */
  onAskAbout?: (prompt: string) => void;
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
   * Fills the pane right of the tree. Two host arrangements exist:
   * - Main app (DataLakeChatSurface): the chat's SessionContainer, declared via `chatEmbedded`.
   * - Premium overlay: the page's own (non-chat) content, with the chat DOCKED as a sibling
   *   outside this component.
   */
  chatSlot?: React.ReactNode;
  /**
   * True when `chatSlot` holds the chat's SessionContainer (main app): clicking a tree file
   * opens it inline in the KnowledgeViewer split (layout `vertical`) via the session workbench,
   * rather than a modal - the parent owns/pre-creates the session (see issue #836) - and tree
   * navigation closes that split. When omitted (overlay), the chat lives OUTSIDE this component
   * (docked), so the global layout is never touched - switching it would collapse the docked
   * chat into a 0x0 branch - and a clicked file is added to the chat's workbench with a toast.
   * Keyed on the HOST, not the live layout: the layout store is global and persists across
   * surfaces, so it can't tell who owns the chat.
   */
  chatEmbedded?: boolean;
  /**
   * Called when a file is clicked with NO active session (/new, where creation is deferred to
   * the first message): must create + adopt the session and resolve its id so the click can
   * proceed into the normal open-in-viewer flow. Omitted (overlay) -> a guidance toast instead.
   */
  createSessionForFile?: () => Promise<string>;
  /**
   * Whether the tree header shows the close (X) that turns Data Lake mode off. Default true.
   * Hosts where the surface is entered/left by navigation rather than a per-session toggle
   * (e.g. a dedicated Data Lake page/mission) pass false, so the info icon stands alone -
   * turning the shared mode off there wouldn't even hide the tree.
   */
  showModeClose?: boolean;
}

/** True only for drags carrying real files (not text/image-from-page drags). */
const isFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types ?? []).includes('Files');

export default function DataLakeExplorer({
  articleId,
  source = 'opti',
  rootLabel = DATA_LAKES,
  onManage,
  onCreateLake,
  chatSlot,
  chatEmbedded = false,
  createSessionForFile,
  showModeClose = true,
}: DataLakeExplorerProps) {
  const [breadcrumb, setBreadcrumb] = useState<string[]>([]);

  // Clicking a file adds it to the current session's workbench and highlights it. What ELSE
  // happens is the host's contract (see the chatEmbedded doc): embedded chat -> open the
  // KnowledgeViewer split; external (docked) chat -> leave the layout alone and toast so the
  // click still has visible feedback. `currentSessionId` is whatever session the host page
  // has active. (#836)
  const { currentSessionId } = useSessions();
  const { setWorkBenchFiles } = useWorkBenchActions();
  const setDataLakeMode = useSetDataLakeMode();
  // When the sidenav is collapsed its floating expand control overlaps the top-left, so the
  // tree needs extra left clearance past it (same 48px the deck top bar uses).
  const sidenavOpen = useNotebookLayout(s => s.openSideNav);
  // Id of the file most recently opened in the viewer, kept to highlight it in the tree.
  const [viewerFileId, setViewerFileId] = useState<string | null>(articleId ?? null);
  // Guards double-clicks while createSessionForFile's POST is in flight - a second click
  // would otherwise mint a second session.
  const creatingSessionRef = useRef(false);
  const openFileInViewer = useCallback(
    async (file: IFabFileDocument) => {
      let sessionId = currentSessionId;
      if (!sessionId) {
        // /new: session creation is deferred to the first message, so there is no workbench
        // to attach the file to and the viewer would render empty (then auto-hide). Hosts
        // that can mint the grounded session do so here; otherwise guide instead of silently
        // no-oping. The highlight below still marks the pick either way.
        if (!createSessionForFile || creatingSessionRef.current) {
          if (!createSessionForFile) {
            toast.info('Start the chat with a first message - lake files will then open right here.');
            setViewerFileId(file.id);
          }
          return;
        }
        creatingSessionRef.current = true;
        try {
          sessionId = await createSessionForFile();
        } catch (error) {
          console.error('Data Lake session create failed:', error);
          toast.error("Couldn't start the chat - please try again.");
          return;
        } finally {
          creatingSessionRef.current = false;
        }
      }
      setWorkBenchFiles(sessionId, prev => (prev.some(f => f.id === file.id) ? prev : [...prev, file]));
      if (chatEmbedded) {
        // Chat is embedded in our right pane: show the KnowledgeViewer split with this file's tab.
        setSessionLayout({ layout: 'vertical', selectedArtifactId: file.id });
      } else {
        toast.info(`Added "${file.fileName.replace(/\.[^/.]+$/, '')}" to the chat's files`);
      }
      setViewerFileId(file.id);
    },
    [currentSessionId, setWorkBenchFiles, chatEmbedded, createSessionForFile]
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
  const tree = useMemo(() => buildTagTree(tagCountsData?.tagCounts ?? []), [tagCountsData]);

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
  // needs the FabFile OBJECT to add to the workbench.
  const { data: deepLinkResult } = useGetDataLakeArticles(articleId ? { id: articleId, limit: 1 } : null, source);
  const deepLinkTarget = deepLinkResult?.data?.[0] ?? null;

  // Open the URL's article in the inline viewer once it resolves. Guarded so it fires once per
  // id (closing the viewer or re-rendering won't reopen it).
  const openedDeepLinkRef = useRef<string | null>(null);
  useEffect(() => {
    if (deepLinkTarget && openedDeepLinkRef.current !== deepLinkTarget.id) {
      openedDeepLinkRef.current = deepLinkTarget.id;
      void openFileInViewer(deepLinkTarget);
    }
  }, [deepLinkTarget, openFileInViewer]);

  const handleNavigate = useCallback(
    (newBreadcrumb: string[]) => {
      setBreadcrumb(newBreadcrumb);
      // Browsing away closes the inline file viewer, returning to the full-width chat. Only
      // when the chat is embedded, and only resetting a layout WE opened ('vertical' above) -
      // an unconditional 'hide' would collapse a docked/floating chat on external-chat hosts.
      if (chatEmbedded) {
        setSessionLayout(prev => (prev.layout === 'vertical' ? { layout: 'hide' } : {}));
      }
      setViewerFileId(null);
    },
    [chatEmbedded]
  );

  const handleSelectFile = useCallback(
    (file: IFabFileDocument) => {
      void openFileInViewer(file);
    },
    [openFileInViewer]
  );

  // Richest second-level branches (top 6), exposed to a host idle pane in the chatSlot via
  // context so its quick-dive chips can drive the tree. Aligned with THIS tree, so the dives
  // always match what the sidebar shows regardless of `source`.
  const nav = useMemo(
    () => ({
      navigate: handleNavigate,
      quickDives: tree
        .flatMap(prefix =>
          prefix.children.map(child => ({
            path: [prefix.segment, child.segment],
            segment: child.segment,
            count: child.fileCount,
          }))
        )
        .sort((a, b) => b.count - a.count)
        .slice(0, 6),
    }),
    [tree, handleNavigate]
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
        sx={{
          display: 'flex',
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
          p: '12px',
          pl: sidenavOpen ? '12px' : '48px',
          gap: '8px',
          transition: 'padding-left 0.2s ease',
        }}
      >
        <DataLakeTree
          tree={tree}
          articles={leafArticles}
          breadcrumb={breadcrumb}
          onNavigate={handleNavigate}
          selectedFileId={viewerFileId}
          onSelectFile={handleSelectFile}
          isLoading={tagCountsLoading || (!!leafTag && leafLoading)}
          isError={tagCountsError}
          title={rootLabel}
          onManage={onManage}
          onCreateLake={onCreateLake}
          onClose={showModeClose ? () => setDataLakeMode(false) : undefined}
        />
        <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
          <DataLakeNavProvider value={nav}>{chatSlot}</DataLakeNavProvider>
        </Box>
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
