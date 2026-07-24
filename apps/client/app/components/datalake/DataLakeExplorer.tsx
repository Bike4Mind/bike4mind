import { useCallback, useMemo, useRef, useState } from 'react';
import { Box, Button, Typography, useTheme } from '@mui/joy';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import TravelExploreIcon from '@mui/icons-material/TravelExplore';
import { OptiModeBreadcrumb } from '@client/app/components/datalake/OptiModeBreadcrumb';
import DataLakeTree from './DataLakeTree';
import DataLakeArticle from './DataLakeArticle';
import { TelemetryTicker, deckBackground } from '@client/app/components/datalake/deckChrome';
import { useGetDataLakeArticles, useGetDataLakeTagCounts } from '@client/app/hooks/data/fabFiles';
import type { DataLakeBrowseSource } from '@client/app/hooks/data/fabFiles';
import { buildTagTree, getNodesAtPath } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import DataLakeIngestPickerModal from '@client/app/components/DataLakeWizard/DataLakeIngestPickerModal';
import { readDroppedItems } from '@client/app/utils/dropReader';
import { toast } from 'sonner';
import FieldTooltip from '@client/app/components/help/FieldTooltip';
import { FIELD_TOOLTIPS } from '@client/app/components/help/fieldTooltips';
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
  /** When provided, renders a "Manage" button that opens the lake management panel. */
  onManage?: () => void;
  /** When provided, renders a "Discover" button that opens the public-lake browse catalog. */
  onDiscover?: () => void;
}

/** True only for drags carrying real files (not text/image-from-page drags). */
const isFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types ?? []).includes('Files');

export default function DataLakeExplorer({
  onBack,
  onAskAbout,
  articleId,
  source = 'opti',
  rootLabel = '⛩ Mission Hub',
  onManage,
  onDiscover,
}: DataLakeExplorerProps) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const [breadcrumb, setBreadcrumb] = useState<string[]>([]);
  const [userSelectedFile, setUserSelectedFile] = useState<IFabFileDocument | null>(null);

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

  // Deep-link: fetch the specific article by ID when URL param is present.
  // Uses dedicated id-lookup path on the server (search by ID as text never matched).
  const { data: deepLinkResult } = useGetDataLakeArticles(
    articleId && !userSelectedFile ? { id: articleId, limit: 1 } : null,
    source
  );

  // Derive selectedFile: user's explicit click takes priority, then deep-link result.
  // Pure derivation - no effects, no refs, no setState during render.
  const deepLinkTarget = deepLinkResult?.data?.[0] ?? null;
  const selectedFile = userSelectedFile ?? (articleId ? deepLinkTarget : null);

  const handleNavigate = useCallback((newBreadcrumb: string[]) => {
    setBreadcrumb(newBreadcrumb);
    setUserSelectedFile(null);
  }, []);

  const handleSelectFile = useCallback((file: IFabFileDocument) => {
    setUserSelectedFile(file);
  }, []);

  // Truthful distinct-file count (the tree's fileCounts are tag-occurrence sums, which
  // overcount multi-tagged articles ~2x); branch count stays tree-derived.
  const totalArticles = tagCountsData?.uniqueArticleCounts?.total ?? 0;
  const branchCount = useMemo(() => tree.reduce((sum, node) => sum + Math.max(node.children.length, 1), 0), [tree]);

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
      <Box sx={{ px: 3, pt: 2, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <OptiModeBreadcrumb segments={[{ label: rootLabel, onClick: onBack }, { label: 'Data Lake Explorer' }]} />
        {/* mb:2 matches the breadcrumb's own mb so this icon's center lines up with the
            breadcrumb text in the center-aligned header row (breadcrumb carries mb:2). */}
        <FieldTooltip
          content={FIELD_TOOLTIPS.dataLake}
          placement="bottom"
          ariaLabel="Help: Data Lakes"
          data-testid="field-tooltip-data-lake-explorer"
          sx={{ mb: 2 }}
        />
        {onManage && (
          <Button
            data-testid="datalake-manage-btn"
            size="sm"
            variant="outlined"
            color="neutral"
            startDecorator={<SettingsOutlinedIcon sx={{ fontSize: 16 }} />}
            onClick={onManage}
            sx={{ mb: 2 }}
          >
            Manage lakes
          </Button>
        )}
        {onDiscover && (
          <Button
            data-testid="datalake-discover-btn"
            size="sm"
            variant="outlined"
            color="neutral"
            startDecorator={<TravelExploreIcon sx={{ fontSize: 16 }} />}
            onClick={onDiscover}
            sx={{ mb: 2, ml: 1 }}
          >
            Discover
          </Button>
        )}
        <Box sx={{ ml: 'auto', mb: 2 }}>
          <TelemetryTicker
            stats={[
              { label: 'Articles', value: String(totalArticles || '—') },
              { label: 'Branches', value: String(branchCount || '—') },
              {
                label: 'Depth',
                value: String(breadcrumb.length),
                sub: breadcrumb.length === 0 ? 'surface' : breadcrumb.join(' : '),
              },
            ]}
            isDark={isDark}
          />
        </Box>
      </Box>
      <Box sx={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <DataLakeTree
          tree={tree}
          articles={leafArticles}
          breadcrumb={breadcrumb}
          onNavigate={handleNavigate}
          selectedFileId={selectedFile?.id ?? null}
          onSelectFile={handleSelectFile}
          isLoading={tagCountsLoading || (!!leafTag && leafLoading)}
          isError={tagCountsError}
        />
        <DataLakeArticle file={selectedFile} onAskAbout={onAskAbout} quickDives={quickDives} onDive={handleNavigate} />
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
