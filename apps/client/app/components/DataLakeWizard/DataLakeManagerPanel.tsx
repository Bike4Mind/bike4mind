import { useCallback, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Input,
  List,
  ListItem,
  ListItemButton,
  ListItemContent,
  Modal,
  ModalDialog,
  Skeleton,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/joy';
import SearchIcon from '@mui/icons-material/Search';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import StorageIcon from '@mui/icons-material/Storage';
import AddIcon from '@mui/icons-material/Add';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';
import UnarchiveOutlinedIcon from '@mui/icons-material/UnarchiveOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import RestoreIcon from '@mui/icons-material/Restore';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import PersonOutlineIcon from '@mui/icons-material/PersonOutline';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import {
  buildTagTree,
  getNodeAtPath,
  getNodesAtPath,
} from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import { HUES, inkFor } from '@client/app/components/datalake/deckChrome';
import {
  COUNT_CHIP_SX,
  FOOTER_BTN_SX,
  ICON_BTN_SX,
  SORT_MODE_ICON,
  TREE_BACK_STICKY_SX,
  TREE_LIST_SX,
  TREE_SCROLL_SX,
  hueForBranch,
  humanizeSegment,
  treeBackRowSx,
  treeRowSx,
} from '@client/app/components/datalake/treeChrome';
import type { TreeSortMode } from '@client/app/components/datalake/treeChrome';
import { gray } from '@client/app/utils/themes/colors';
import {
  useActiveDataLakeBatches,
  useArchiveDataLake,
  useCleanupDataLake,
  useDataLakeFiles,
  useGetArchivedDataLakes,
  useGetDataLakes,
  useGetDataLakeTagCounts,
  useGetDeletedDataLakes,
  usePermanentDeleteDataLake,
  useRestoreDeletedDataLake,
  useUnarchiveDataLake,
} from '@client/app/hooks/data/dataLakes';
import { toast } from 'sonner';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import useStartChatWithLake from '@client/app/hooks/useStartChatWithLake';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import DataLakeEmptyState from '@client/app/components/datalake/DataLakeEmptyState';
import DataLakeArticlePanel from './DataLakeArticlePanel';
import DataLakeDiscoverPanel from './DataLakeDiscoverPanel';
import { DataLakeSettingsModal } from './DataLakeSettingsModal';
import type { EditableLake } from './DataLakeSettingsModal';
import TaxonomyReviewPanel from './TaxonomyReviewPanel';
import FieldTooltip from '@client/app/components/help/FieldTooltip';
import { FIELD_TOOLTIPS } from '@client/app/components/help/fieldTooltips';
import type { IDataLakeBatchSummary, IFabFileDocument } from '@bike4mind/common';
import { satisfiesTagPrefix } from '@bike4mind/common';

type ManagerLake = NonNullable<ReturnType<typeof useGetDataLakes>['data']>[number];

/** Synthetic category for lake files that carry no prefix-matching tag (e.g. appended or
 *  meta-tag-only files), so every file is always reachable in the manager. */
const UNCATEGORIZED_KEY = '__uncategorized__';

const normalizePrefix = (fileTagPrefix: string) => (fileTagPrefix.endsWith(':') ? fileTagPrefix : `${fileTagPrefix}:`);

/** The prefix's namespace segments, e.g. 'books' -> ['books']. Lake navigation seeds the
 *  path past these so clicking a lake lands directly on its categories. */
const prefixSegments = (fileTagPrefix: string) => fileTagPrefix.replace(/:+$/, '').split(':').filter(Boolean);

/**
 * Data Lakes management surface: one persistent two-pane layout. The left sidebar navigates
 * lakes -> categories -> files with the exact styling of the in-chat tree (treeChrome); the
 * right pane shows the selected lake's details/actions, or the file's content, or (at root)
 * the archived/deleted lifecycle sections. Replaces the old stacked list + viewer modals.
 */
export default function DataLakeManagerPanel() {
  const { data: dataLakes, isLoading } = useGetDataLakes();
  const { data: activeBatches } = useActiveDataLakeBatches();
  // Id only, not the batch object - `reviewingBatch` below is derived from the live, polled
  // `activeBatches` list so a re-analyze's cache refresh flows into the open review panel
  // instead of leaving it stuck showing pre-refresh suggestions.
  const [reviewingBatchId, setReviewingBatchId] = useState<string | null>(null);
  const reviewingBatch = useMemo(
    () => activeBatches?.find(b => b.id === reviewingBatchId) ?? null,
    [activeBatches, reviewingBatchId]
  );
  // One pass over the batch list, not a per-lake filter/find on every row render. Only batches
  // whose taxonomy phase actually needs attention are kept - a lake with none just misses the
  // map entry, which every consumer already treats the same as "nothing to show."
  const taxonomyBatchByLakeId = useMemo(() => {
    const map = new Map<string, IDataLakeBatchSummary>();
    for (const batch of activeBatches ?? []) {
      if (!batch.taxonomyStatus || batch.taxonomyStatus === 'none') continue;
      if (!map.has(batch.dataLakeId)) map.set(batch.dataLakeId, batch);
    }
    return map;
  }, [activeBatches]);
  const openWizard = useDataLakeWizardStore(s => s.openWizard);
  // Store-driven so openManager('discover') deep-links land on the public catalog; the
  // sidebar footer's Discover button flips it the same way.
  const managerTab = useDataLakeWizardStore(s => s.managerTab);
  const openManager = useDataLakeWizardStore(s => s.openManager);
  const { isFeatureEnabled } = useAdminSettingsCache();

  // The lakes list projection carries no per-lake file counts. Size a lake by MEMBERSHIP, not
  // by its `<prefix>:` tag matches: a lake whose files carry only the meta-tag (what the upload
  // wizard produces) reported 0 while its own file list showed them, and a multi-tagged file
  // was counted once per tag.
  const { data: tagCountsData } = useGetDataLakeTagCounts('datalakes');
  const lakeCount = useCallback(
    (lake: ManagerLake): number | undefined => tagCountsData?.lakeFileCounts?.[lake.datalakeTag],
    [tagCountsData]
  );

  const [lakeId, setLakeId] = useState<string | null>(null);
  const [path, setPath] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<IFabFileDocument | null>(null);
  const [editingLakeId, setEditingLakeId] = useState<string | null>(null);

  // Derived, not effect-synced: when the active lake vanishes from the list (archived or
  // deleted), this goes null and the panel falls back to the root view on its own. The stale
  // path/file are unreachable behind the null and reset on the next lake click.
  const activeLake = useMemo(() => dataLakes?.find(l => l.id === lakeId) ?? null, [dataLakes, lakeId]);

  // Derive the lake being edited from the LIVE list (by id) rather than a snapshot, so a
  // visibility mutation's cache refresh flows into the settings modal instead of leaving the
  // Visibility control showing stale pre-mutation state.
  const editingLake = useMemo<EditableLake | null>(() => {
    const l = dataLakes?.find(d => d.id === editingLakeId);
    return l
      ? {
          id: l.id,
          name: l.name,
          description: l.description ?? '',
          requiredUserTag: l.requiredUserTag ?? '',
          requiredEntitlement: l.requiredEntitlement ?? '',
          organizationId: l.organizationId ?? '',
          isPublic: l.isPublic ?? false,
          // '' both when unset and when the server withheld it (non-editors never receive
          // the text); the modal renders the field off canManage, never off this value.
          systemPrompt: l.systemPrompt ?? '',
          // Same as systemPrompt: '' when unset OR withheld from a non-editor; rendered off canManage.
          preferredSystemPromptId: l.preferredSystemPromptId ?? '',
          canManage: !!l.canManage,
        }
      : null;
  }, [dataLakes, editingLakeId]);

  const selectLake = (lake: ManagerLake) => {
    setLakeId(lake.id);
    // Seed past the shared prefix root so the first in-lake view shows its categories
    // instead of a single redundant folder named like the lake.
    setPath(prefixSegments(lake.fileTagPrefix));
    setSelectedFile(null);
    // Opening one of YOUR lakes leaves the public catalog, so backing out of the lake
    // lands on the overview, not back in Discover.
    if (managerTab !== 'mine') openManager('mine');
  };

  // Discover swaps the right pane, but the activeLake branch below outranks it - so a click
  // while a lake was open changed nothing on screen, then surfaced later as the catalog
  // appearing when the user pressed Back. Exit the lake on the way in. Toggling back out is
  // the only exit that does not require owning a lake to click.
  const toggleDiscover = () => {
    if (managerTab === 'discover') {
      openManager('mine');
      return;
    }
    setLakeId(null);
    setPath([]);
    setSelectedFile(null);
    openManager('discover');
  };

  // Shared choke point for every manager entry point: with the feature off the lakes
  // queries 403 and the empty panel is a dead end, so never render - even if some (future)
  // ungated caller opens the manager. Mirrors the render guard in SendToDataLakeModal.
  // Placed after all hooks so the hook order is stable.
  if (!isFeatureEnabled('EnableDataLakes')) return null;

  return (
    // No header bar: the nav floats as a full-height card (same chrome as the in-chat tree)
    // and the modal's ModalClose sits in the top-right corner across from it.
    <Box
      data-testid="datalake-manager-panel"
      sx={{ display: 'flex', height: '100%', minHeight: 0, overflow: 'hidden', p: '12px', gap: '12px' }}
    >
      <ManagerNav
        lakes={dataLakes}
        lakesLoading={isLoading}
        lakeCount={lakeCount}
        taxonomyBatchByLakeId={taxonomyBatchByLakeId}
        activeLake={activeLake}
        path={path}
        selectedFileId={selectedFile?.id ?? null}
        onSelectLake={selectLake}
        onNavigate={p => {
          setPath(p);
          setSelectedFile(null);
        }}
        onExitLake={() => {
          setLakeId(null);
          setPath([]);
          setSelectedFile(null);
        }}
        onSelectFile={setSelectedFile}
        onCreateLake={openWizard}
        isDiscovering={managerTab === 'discover'}
        onDiscover={toggleDiscover}
        onReviewTaxonomy={setReviewingBatchId}
      />
      {activeLake ? (
        selectedFile ? (
          <DataLakeArticlePanel
            file={selectedFile}
            dataLakeId={activeLake.id}
            canManage={activeLake.canManage}
            onRemoved={() => setSelectedFile(null)}
          />
        ) : (
          <LakeInfoPanel
            lake={activeLake}
            fileCount={lakeCount(activeLake)}
            taxonomyBatch={taxonomyBatchByLakeId.get(activeLake.id)}
            onOpenSettings={() => setEditingLakeId(activeLake.id)}
            onReviewTaxonomy={setReviewingBatchId}
            onArchived={() => {
              setLakeId(null);
              setPath([]);
              setSelectedFile(null);
            }}
          />
        )
      ) : managerTab === 'discover' ? (
        // Public-lake catalog (store deep-link openManager('discover') or the footer button).
        <Box sx={{ ...TREE_SCROLL_SX, minWidth: 0, px: 1 }}>
          <DataLakeDiscoverPanel />
        </Box>
      ) : (
        <ManagerOverview />
      )}

      <DataLakeSettingsModal lake={editingLake} onClose={() => setEditingLakeId(null)} />

      {/* Review/apply the background AI tag suggestions for a batch */}
      {reviewingBatch && (
        <TaxonomyReviewPanel
          batch={reviewingBatch}
          prefix={dataLakes?.find(l => l.id === reviewingBatch.dataLakeId)?.fileTagPrefix ?? ''}
          onClose={() => setReviewingBatchId(null)}
        />
      )}
    </Box>
  );
}

// Left sidebar

interface ManagerNavProps {
  lakes: ManagerLake[] | undefined;
  lakesLoading: boolean;
  /** Per-lake live file count, resolved by lake membership (see lakeCount). */
  lakeCount: (lake: ManagerLake) => number | undefined;
  /** Lake id -> its attention-worthy taxonomy batch, if any (see taxonomyBatchByLakeId). */
  taxonomyBatchByLakeId: Map<string, IDataLakeBatchSummary>;
  activeLake: ManagerLake | null;
  /** In-lake tag path, seeded with the lake's prefix segments (see selectLake). */
  path: string[];
  selectedFileId: string | null;
  onSelectLake: (lake: ManagerLake) => void;
  onNavigate: (path: string[]) => void;
  onExitLake: () => void;
  onSelectFile: (file: IFabFileDocument) => void;
  onCreateLake: () => void;
  /** True while the right pane shows the public catalog, so the footer button reads as pressed. */
  isDiscovering: boolean;
  /** Toggles the public-lake Discover catalog in the right pane. */
  onDiscover: () => void;
  /** Opens the review/apply panel for a batch whose taxonomy suggestions are ready or failed. */
  onReviewTaxonomy: (batchId: string) => void;
}

function ManagerNav({
  lakes,
  lakesLoading,
  lakeCount,
  taxonomyBatchByLakeId,
  activeLake,
  path,
  selectedFileId,
  onSelectLake,
  onNavigate,
  onExitLake,
  onSelectFile,
  onCreateLake,
  isDiscovering,
  onDiscover,
  onReviewTaxonomy,
}: ManagerNavProps) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const hoverBg = theme.palette.notebooklist.hoverBg;
  const borderColor = isDark ? gray[800] : gray[200];
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<TreeSortMode>('count');
  const SortModeIcon = SORT_MODE_ICON[sortBy];

  // Root accordions: active lakes open by default; the lifecycle lists stay collapsed (their
  // queries only fire once expanded, same as the old right-pane sections).
  const [showLakes, setShowLakes] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<{ id: string; name: string } | null>(null);
  const unarchiveLake = useUnarchiveDataLake();
  const restoreDeletedLake = useRestoreDeletedDataLake();
  const deleteLake = usePermanentDeleteDataLake();
  const cleanupLake = useCleanupDataLake();
  const { data: archivedLakes } = useGetArchivedDataLakes(showArchived);
  const { data: deletedLakes } = useGetDeletedDataLakes(showDeleted);

  const { data: filesResult, isLoading: filesLoading, isError: filesError } = useDataLakeFiles(activeLake?.id ?? null);
  const articles = useMemo(() => filesResult?.data ?? [], [filesResult]);

  // Per-lake category tree from the lake's prefix-matching tags (datalake: meta-tags excluded).
  const tree = useMemo(() => {
    if (!activeLake) return [];
    const prefix = normalizePrefix(activeLake.fileTagPrefix);
    const tagCountMap = new Map<string, number>();
    for (const file of articles) {
      for (const tag of file.tags ?? []) {
        if (tag.name.startsWith(prefix) && !tag.name.startsWith('datalake:')) {
          tagCountMap.set(tag.name, (tagCountMap.get(tag.name) ?? 0) + 1);
        }
      }
    }
    return buildTagTree(Array.from(tagCountMap.entries()).map(([tag, count]) => ({ tag, count })));
  }, [articles, activeLake]);

  const currentNodes = useMemo(() => getNodesAtPath(tree, path), [tree, path]);
  const currentNode = useMemo(() => getNodeAtPath(tree, path), [tree, path]);

  const filteredNodes = useMemo(() => {
    let nodes = currentNodes;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      nodes = nodes.filter(node => node.segment.toLowerCase().includes(q));
    }
    return [...nodes].sort((a, b) =>
      sortBy === 'count' ? b.fileCount - a.fileCount : a.segment.localeCompare(b.segment)
    );
  }, [currentNodes, searchQuery, sortBy]);

  // Files in the lake with no prefix-matching (non-meta) tag - surfaced under "Uncategorized".
  // Shares the server's predicate so this bucket holds exactly the files the write doors and the
  // backfill consider uncategorized; a local copy already drifted on the bare-prefix case.
  const uncategorizedFiles = useMemo(() => {
    if (!activeLake) return [];
    const prefix = normalizePrefix(activeLake.fileTagPrefix);
    return [...articles]
      .filter(
        f =>
          !satisfiesTagPrefix(
            (f.tags ?? []).map(t => t.name),
            prefix
          )
      )
      .sort((a, b) => a.fileName.localeCompare(b.fileName));
  }, [articles, activeLake]);

  const seedDepth = activeLake ? prefixSegments(activeLake.fileTagPrefix).length : 0;
  const atLakeRoot = !!activeLake && path.length <= seedDepth;
  const isUncategorized = path[path.length - 1] === UNCATEGORIZED_KEY;
  // Leaf detection starts BELOW the seeded lake root, so an empty/untagged lake still shows
  // the folder view (with the Uncategorized bucket) instead of flipping to a dead file list.
  const leafTag =
    activeLake && !isUncategorized && path.length > seedDepth && currentNodes.length === 0 ? path.join(':') : null;
  const showFiles = isUncategorized || !!leafTag;
  const files = useMemo(() => {
    if (isUncategorized) return uncategorizedFiles;
    if (!leafTag) return [];
    return articles
      .filter(f => (f.tags ?? []).some(t => t.name === leafTag))
      .sort((a, b) => a.fileName.localeCompare(b.fileName));
  }, [isUncategorized, uncategorizedFiles, leafTag, articles]);

  // A branch node (has children) can ALSO carry files tagged with its own exact path, not just a
  // deeper child tag - shown as file rows mixed into the folder list below rather than a separate
  // route, matching how DataLakeTreeView handles the same case for the standalone/chat surfaces.
  const ownTag = activeLake && !isUncategorized && !leafTag && path.length > seedDepth ? path.join(':') : null;
  const ownFiles = useMemo(() => {
    if (!ownTag || !currentNode?.ownFileCount) return [];
    return articles
      .filter(f => (f.tags ?? []).some(t => t.name === ownTag))
      .sort((a, b) => a.fileName.localeCompare(b.fileName));
  }, [ownTag, currentNode, articles]);
  const showOwnFiles = !searchQuery && ownFiles.length > 0;

  const filteredLakes = useMemo(() => {
    let list = lakes ?? [];
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(l => l.name.toLowerCase().includes(q));
    }
    return [...list].sort((a, b) =>
      sortBy === 'count' ? (lakeCount(b) ?? 0) - (lakeCount(a) ?? 0) : a.name.localeCompare(b.name)
    );
  }, [lakes, searchQuery, sortBy, lakeCount]);

  // The sidebar search also narrows the lifecycle lists; undefined stays undefined so the
  // sections keep their loading skeleton.
  const filterByName = <T extends { name: string }>(list: T[] | undefined): T[] | undefined => {
    if (!list || !searchQuery.trim()) return list;
    const q = searchQuery.toLowerCase();
    return list.filter(l => l.name.toLowerCase().includes(q));
  };

  // Search is scoped to the current level: entering/leaving a lake or drilling a category
  // clears it, so a query typed to find a lake at root can't silently filter (and hide) that
  // lake's categories once opened. Wrap every level transition to reset it.
  const selectLake = (lake: ManagerLake) => {
    setSearchQuery('');
    onSelectLake(lake);
  };
  const navigate = (next: string[]) => {
    setSearchQuery('');
    onNavigate(next);
  };
  const handleBack = () => {
    setSearchQuery('');
    if (!activeLake || atLakeRoot) onExitLake();
    else onNavigate(path.slice(0, -1));
  };

  const backLabel = !activeLake
    ? ''
    : atLakeRoot
      ? 'All Lakes'
      : path.length - 1 <= seedDepth
        ? activeLake.name
        : humanizeSegment(path[path.length - 2], path.length - 2);

  const rowTypographySx = { fontSize: '14px', fontWeight: 400, color: 'text.primary' } as const;

  return (
    <Box
      data-testid="datalake-manager-nav"
      sx={{
        width: 280,
        minWidth: 280,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        // Floating-card chrome like the in-chat tree (DataLakeTree), slightly tighter radius.
        backgroundColor: 'background.surface2',
        border: '1px solid',
        borderColor,
        borderRadius: '8px',
      }}
    >
      {/* Search bar + sort toggle - same toolbar as the in-chat tree. */}
      <Box sx={{ mt: '12px', mb: '12px', px: '12px', display: 'flex', gap: '10px', alignItems: 'center' }}>
        <Input
          size="sm"
          placeholder="Search"
          startDecorator={<SearchIcon sx={{ fontSize: 18 }} />}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          data-testid="datalake-manager-search"
          sx={{ flex: 1, '--Input-minHeight': '32px', color: 'text.primary', boxShadow: 'none' }}
        />
        <Tooltip
          title={sortBy === 'count' ? 'Sort: by count (click for A-Z)' : 'Sort: A-Z (click for count)'}
          size="sm"
        >
          <IconButton
            variant="outlined"
            color="neutral"
            onClick={() => setSortBy(prev => (prev === 'count' ? 'alpha' : 'count'))}
            data-testid="datalake-manager-sort-toggle"
            data-sort={sortBy}
            sx={{ ...ICON_BTN_SX, flexShrink: 0 }}
          >
            <SortModeIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      </Box>

      <Box sx={{ ...TREE_SCROLL_SX, px: '8px' }}>
        {activeLake && (
          <Box sx={TREE_BACK_STICKY_SX}>
            <ListItemButton onClick={handleBack} data-testid="datalake-manager-back" sx={treeBackRowSx(hoverBg)}>
              <ArrowBackIcon sx={{ fontSize: 16, color: 'text.secondary', flexShrink: 0 }} />
              <Typography noWrap sx={rowTypographySx}>
                {backLabel}
              </Typography>
            </ListItemButton>
          </Box>
        )}

        {!activeLake ? (
          /* Root: accordions - active lakes (tree-folder rows) + the lifecycle lists. */
          <>
            <Box data-testid="datalake-manager-lakes-section">
              <NavSectionHeader
                label="Data Lakes"
                open={showLakes}
                onToggle={() => setShowLakes(v => !v)}
                testid="datalake-manager-lakes-section-toggle"
                hoverBg={hoverBg}
                infoTooltip={
                  <FieldTooltip
                    content={FIELD_TOOLTIPS.dataLake}
                    placement="bottom"
                    ariaLabel="Help: Data Lakes"
                    data-testid="field-tooltip-data-lake-panel"
                  />
                }
              />
              {showLakes &&
                (lakesLoading ? (
                  <NavSkeletons />
                ) : (
                  <List size="sm" sx={TREE_LIST_SX}>
                    {filteredLakes.length === 0 ? (
                      <EmptyHint text={searchQuery ? 'No matches' : 'No data lakes yet'} />
                    ) : (
                      filteredLakes.map(lake => {
                        const count = lakeCount(lake);
                        const taxonomyBatch = taxonomyBatchByLakeId.get(lake.id);
                        return (
                          <ListItem key={lake.id}>
                            <ListItemButton
                              onClick={() => selectLake(lake)}
                              data-testid={`datalake-manager-lake-${lake.id}`}
                              // pr aligns the count chip with the section headers' chevrons.
                              sx={{ ...treeRowSx(hoverBg), pr: '12px' }}
                            >
                              <FolderOutlinedIcon
                                sx={{
                                  fontSize: 16,
                                  color: inkFor(hueForBranch(prefixSegments(lake.fileTagPrefix)[0] ?? '', []), isDark),
                                  flexShrink: 0,
                                }}
                              />
                              <ListItemContent>
                                <Typography noWrap sx={rowTypographySx}>
                                  {lake.name}
                                </Typography>
                              </ListItemContent>
                              {/* Owner marker in the LIST itself, not just the detail pane: the
                                  row otherwise shows only a name, so an admin (who sees every
                                  tenant's lakes, even private) can't tell whose is whose without
                                  opening each one. The owner name is already on the row, so this
                                  costs no extra request. */}
                              {lake.isOwn === false && (
                                <Tooltip
                                  title={
                                    lake.ownerDisplayName
                                      ? `Owned by ${lake.ownerDisplayName}`
                                      : 'Owned by another user'
                                  }
                                  size="sm"
                                >
                                  <PersonOutlineIcon
                                    data-testid={`datalake-manager-owner-icon-${lake.id}`}
                                    sx={{ fontSize: 14, color: 'warning.400', flexShrink: 0 }}
                                  />
                                </Tooltip>
                              )}
                              {/* Background AI-tag suggestion indicator - an independent clock
                                  from ingest, so this can appear well after the lake's files
                                  are already fully uploaded/searchable. */}
                              {(taxonomyBatch?.taxonomyStatus === 'queued' ||
                                taxonomyBatch?.taxonomyStatus === 'analyzing') && (
                                <Tooltip title="Suggesting tags with AI - usually ready in under a minute" size="sm">
                                  <AutoAwesomeIcon
                                    data-testid={`datalake-manager-taxonomy-progress-${lake.id}`}
                                    sx={{ fontSize: 14, color: 'primary.400', flexShrink: 0 }}
                                  />
                                </Tooltip>
                              )}
                              {taxonomyBatch?.taxonomyStatus === 'ready' && (
                                <Tooltip title="AI tag suggestions ready - click to review" size="sm">
                                  <IconButton
                                    size="sm"
                                    variant="plain"
                                    color="success"
                                    data-testid={`datalake-manager-taxonomy-review-${lake.id}`}
                                    onClick={e => {
                                      e.stopPropagation();
                                      onReviewTaxonomy(taxonomyBatch.id);
                                    }}
                                    sx={{ '--IconButton-size': '22px', flexShrink: 0 }}
                                  >
                                    <AutoAwesomeIcon sx={{ fontSize: 14 }} />
                                  </IconButton>
                                </Tooltip>
                              )}
                              {taxonomyBatch?.taxonomyStatus === 'failed' && (
                                <Tooltip title="AI tagging failed - click to view" size="sm">
                                  <IconButton
                                    size="sm"
                                    variant="plain"
                                    color="warning"
                                    data-testid={`datalake-manager-taxonomy-failed-${lake.id}`}
                                    onClick={e => {
                                      e.stopPropagation();
                                      onReviewTaxonomy(taxonomyBatch.id);
                                    }}
                                    sx={{ '--IconButton-size': '22px', flexShrink: 0 }}
                                  >
                                    <ErrorOutlineIcon sx={{ fontSize: 14 }} />
                                  </IconButton>
                                </Tooltip>
                              )}
                              {typeof count === 'number' && (
                                <Chip size="sm" variant="soft" color="neutral" sx={COUNT_CHIP_SX}>
                                  {count}
                                </Chip>
                              )}
                            </ListItemButton>
                          </ListItem>
                        );
                      })
                    )}
                  </List>
                ))}
            </Box>

            {/* Archived (reversible) */}
            <NavLifecycleSection
              label="Archived"
              open={showArchived}
              onToggle={() => setShowArchived(v => !v)}
              testid="datalake-archived-section"
              emptyText="No archived data lakes."
              lakes={showArchived ? filterByName(archivedLakes) : undefined}
              hoverBg={hoverBg}
              renderActions={lake => (
                <>
                  <Tooltip title="Restore" size="sm">
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="success"
                      data-testid={`datalake-restore-btn-${lake.id}`}
                      onClick={() => unarchiveLake.mutate(lake.id)}
                      sx={{ '--IconButton-size': '24px' }}
                    >
                      <UnarchiveOutlinedIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Delete (recoverable)" size="sm">
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="danger"
                      data-testid={`datalake-delete-btn-${lake.id}`}
                      onClick={() => deleteLake.mutate(lake.id)}
                      sx={{ '--IconButton-size': '24px' }}
                    >
                      <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                </>
              )}
            />

            {/* Deleted (recoverable until purged) */}
            <NavLifecycleSection
              label="Deleted (recoverable)"
              open={showDeleted}
              onToggle={() => setShowDeleted(v => !v)}
              testid="datalake-deleted-section"
              emptyText="No deleted data lakes."
              lakes={showDeleted ? filterByName(deletedLakes) : undefined}
              hoverBg={hoverBg}
              renderActions={lake => (
                <>
                  <Tooltip title="Restore" size="sm">
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="success"
                      data-testid={`datalake-restore-deleted-btn-${lake.id}`}
                      onClick={() => restoreDeletedLake.mutate(lake.id)}
                      sx={{ '--IconButton-size': '24px' }}
                    >
                      <RestoreIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Purge permanently" size="sm">
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="danger"
                      data-testid={`datalake-purge-btn-${lake.id}`}
                      onClick={() => setPurgeTarget({ id: lake.id, name: lake.name })}
                      sx={{ '--IconButton-size': '24px' }}
                    >
                      <DeleteForeverIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                </>
              )}
            />

            {/* Irreversible purge confirmation */}
            <Modal open={!!purgeTarget} onClose={() => setPurgeTarget(null)}>
              <ModalDialog data-testid="datalake-purge-confirm" role="alertdialog">
                <DialogTitle>Permanently purge data lake?</DialogTitle>
                <DialogContent>
                  This irreversibly deletes “{purgeTarget?.name}” and all its files, chunks, and batches. This cannot be
                  undone.
                </DialogContent>
                <DialogActions>
                  <Button
                    variant="solid"
                    color="danger"
                    data-testid="datalake-purge-confirm-btn"
                    loading={cleanupLake.isPending}
                    onClick={() => {
                      if (purgeTarget) cleanupLake.mutate(purgeTarget.id, { onSuccess: () => setPurgeTarget(null) });
                    }}
                  >
                    Purge permanently
                  </Button>
                  <Button variant="plain" color="neutral" onClick={() => setPurgeTarget(null)}>
                    Cancel
                  </Button>
                </DialogActions>
              </ModalDialog>
            </Modal>
          </>
        ) : filesError ? (
          <Box sx={{ p: 2, textAlign: 'center' }} data-testid="datalake-manager-error">
            <Typography level="body-xs" sx={{ color: 'danger.400' }}>
              Failed to load files
            </Typography>
          </Box>
        ) : filesLoading ? (
          <NavSkeletons />
        ) : showFiles ? (
          /* File list at leaf */
          <List size="sm" sx={TREE_LIST_SX}>
            {files.length === 0 ? (
              <EmptyHint text="No files found" />
            ) : (
              files.map(file => (
                <ListItem key={file.id}>
                  <ListItemButton
                    selected={selectedFileId === file.id}
                    onClick={() => onSelectFile(file)}
                    data-testid={`datalake-manager-file-${file.id}`}
                    sx={treeRowSx(hoverBg)}
                  >
                    <ArticleOutlinedIcon
                      sx={{
                        fontSize: 16,
                        color: selectedFileId === file.id ? inkFor(HUES.cyan, isDark) : 'text.tertiary',
                        flexShrink: 0,
                      }}
                    />
                    <ListItemContent>
                      <Typography
                        noWrap
                        sx={{ ...rowTypographySx, fontWeight: selectedFileId === file.id ? 'lg' : 400 }}
                      >
                        {file.fileName.replace(/\.[^/.]+$/, '')}
                      </Typography>
                    </ListItemContent>
                  </ListItemButton>
                </ListItem>
              ))
            )}
          </List>
        ) : (
          /* In-lake folder tree */
          <List size="sm" sx={TREE_LIST_SX}>
            {filteredNodes.map(node => (
              <ListItem key={node.segment}>
                <ListItemButton
                  onClick={() => navigate([...path, node.segment])}
                  sx={treeRowSx(hoverBg)}
                  data-testid={`datalake-manager-node-${node.segment}`}
                >
                  <FolderOutlinedIcon
                    sx={{ fontSize: 16, color: inkFor(hueForBranch(node.segment, path), isDark), flexShrink: 0 }}
                  />
                  <ListItemContent>
                    <Typography noWrap sx={rowTypographySx}>
                      {humanizeSegment(node.segment, path.length)}
                    </Typography>
                  </ListItemContent>
                  <Chip size="sm" variant="soft" color="neutral" sx={COUNT_CHIP_SX}>
                    {node.fileCount}
                  </Chip>
                </ListItemButton>
              </ListItem>
            ))}

            {/* Fallback bucket: files with no prefix-matching tag, so nothing is hidden. */}
            {atLakeRoot && !searchQuery && uncategorizedFiles.length > 0 && (
              <ListItem key={UNCATEGORIZED_KEY}>
                <ListItemButton
                  onClick={() => navigate([...path, UNCATEGORIZED_KEY])}
                  data-testid="datalake-manager-uncategorized"
                  sx={treeRowSx(hoverBg)}
                >
                  <FolderOutlinedIcon sx={{ fontSize: 16, color: 'neutral.400', flexShrink: 0 }} />
                  <ListItemContent>
                    <Typography noWrap sx={{ ...rowTypographySx, fontStyle: 'italic', color: 'text.secondary' }}>
                      Uncategorized
                    </Typography>
                  </ListItemContent>
                  <Chip size="sm" variant="soft" color="neutral" sx={COUNT_CHIP_SX}>
                    {uncategorizedFiles.length}
                  </Chip>
                </ListItemButton>
              </ListItem>
            )}

            {/* Files tagged with this branch's own exact path, mixed in alongside its subfolders. */}
            {showOwnFiles &&
              ownFiles.map(file => (
                <ListItem key={file.id}>
                  <ListItemButton
                    selected={selectedFileId === file.id}
                    onClick={() => onSelectFile(file)}
                    data-testid={`datalake-manager-file-${file.id}`}
                    sx={treeRowSx(hoverBg)}
                  >
                    <ArticleOutlinedIcon
                      sx={{
                        fontSize: 16,
                        color: selectedFileId === file.id ? inkFor(HUES.cyan, isDark) : 'text.tertiary',
                        flexShrink: 0,
                      }}
                    />
                    <ListItemContent>
                      <Typography
                        noWrap
                        sx={{ ...rowTypographySx, fontWeight: selectedFileId === file.id ? 'lg' : 400 }}
                      >
                        {file.fileName.replace(/\.[^/.]+$/, '')}
                      </Typography>
                    </ListItemContent>
                  </ListItemButton>
                </ListItem>
              ))}

            {filteredNodes.length === 0 &&
              !(atLakeRoot && !searchQuery && uncategorizedFiles.length > 0) &&
              !showOwnFiles && <EmptyHint text={searchQuery ? 'No matches' : 'No categories'} />}
          </List>
        )}
      </Box>

      {/* Sticky bottom bar, same chrome as the in-chat tree footer. */}
      <Box sx={{ display: 'flex', gap: '8px', p: '12px', borderTop: '1px solid', borderColor }}>
        <Tooltip
          title={
            isDiscovering
              ? 'Showing public data lakes. Click to return to your own lakes.'
              : 'Browse data lakes other people have published, from across the app.'
          }
          size="sm"
        >
          <Button
            variant={isDiscovering ? 'soft' : 'outlined'}
            color="neutral"
            onClick={onDiscover}
            aria-pressed={isDiscovering}
            data-testid="datalake-manager-discover-btn"
            sx={FOOTER_BTN_SX}
          >
            Discover
          </Button>
        </Tooltip>
        <Button
          variant="solid"
          color="primary"
          onClick={onCreateLake}
          data-testid="datalake-manager-create-btn"
          sx={FOOTER_BTN_SX}
        >
          Create
        </Button>
      </Box>
    </Box>
  );
}

function NavSkeletons() {
  return (
    <Box sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
      {[1, 2, 3, 4].map(i => (
        <Skeleton key={i} variant="rectangular" height={32} sx={{ borderRadius: 'sm' }} />
      ))}
    </Box>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <Box sx={{ p: 2, textAlign: 'center' }}>
      <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
        {text}
      </Typography>
    </Box>
  );
}

/** Accordion header for the sidebar's root sections, styled like the tree rows. */
function NavSectionHeader({
  label,
  open,
  onToggle,
  testid,
  hoverBg,
  infoTooltip,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  testid: string;
  hoverBg: string;
  /** Persistent help affordance next to the label, e.g. explaining RAG for the Lakes section. */
  infoTooltip?: React.ReactNode;
}) {
  return (
    <ListItemButton
      onClick={onToggle}
      data-testid={testid}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        px: '8px',
        mb: '4px',
        height: '32px',
        minHeight: '32px',
        borderRadius: '8px',
        transition: 'background 0.15s',
        '--variant-plainHoverBg': hoverBg,
      }}
    >
      <Typography noWrap sx={{ flex: 1, minWidth: 0, fontSize: '14px', fontWeight: 400, color: 'text.primary' }}>
        {label}
      </Typography>
      {/* Not part of the toggle - stop the click from also collapsing/expanding the section. */}
      {infoTooltip && <Box onClick={e => e.stopPropagation()}>{infoTooltip}</Box>}
      {open ? (
        <ExpandLessIcon sx={{ fontSize: 18, color: 'text.tertiary', flexShrink: 0 }} />
      ) : (
        <ExpandMoreIcon sx={{ fontSize: 18, color: 'text.tertiary', flexShrink: 0 }} />
      )}
    </ListItemButton>
  );
}

interface LifecycleSectionLake {
  id: string;
  name: string;
  fileTagPrefix: string;
}

/** Sidebar accordion for archived/deleted lakes: tree-style rows with restore/delete actions.
 *  `lakes` undefined -> loading skeleton (the query fires only once the section is expanded). */
function NavLifecycleSection({
  label,
  open,
  onToggle,
  testid,
  emptyText,
  lakes,
  hoverBg,
  renderActions,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  testid: string;
  emptyText: string;
  lakes: LifecycleSectionLake[] | undefined;
  hoverBg: string;
  renderActions: (lake: LifecycleSectionLake) => React.ReactNode;
}) {
  return (
    <Box data-testid={testid} sx={{ mt: '8px' }}>
      <NavSectionHeader label={label} open={open} onToggle={onToggle} testid={`${testid}-toggle`} hoverBg={hoverBg} />
      {open &&
        (!lakes ? (
          <Box sx={{ px: '8px', pb: 1 }}>
            <Skeleton variant="rectangular" height={28} sx={{ borderRadius: 'sm' }} />
          </Box>
        ) : lakes.length === 0 ? (
          <Typography level="body-xs" sx={{ color: 'text.tertiary', px: '8px', pb: 1 }}>
            {emptyText}
          </Typography>
        ) : (
          <List size="sm" sx={TREE_LIST_SX}>
            {lakes.map(lake => (
              <ListItem key={lake.id}>
                <Box
                  data-testid={`${testid}-card-${lake.id}`}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    px: '8px',
                    minHeight: '28px',
                    width: '100%',
                  }}
                >
                  <FolderOutlinedIcon sx={{ fontSize: 16, color: 'text.tertiary', flexShrink: 0 }} />
                  <Typography
                    noWrap
                    sx={{ flex: 1, minWidth: 0, fontSize: '14px', fontWeight: 400, color: 'text.primary' }}
                  >
                    {lake.name}
                  </Typography>
                  {renderActions(lake)}
                </Box>
              </ListItem>
            ))}
          </List>
        ))}
    </Box>
  );
}

// Right pane: selected lake's details + management actions

function LakeInfoPanel({
  lake,
  fileCount,
  taxonomyBatch,
  onOpenSettings,
  onReviewTaxonomy,
  onArchived,
}: {
  lake: ManagerLake;
  fileCount: number | undefined;
  /** This lake's attention-worthy taxonomy batch, if any (see taxonomyBatchByLakeId). */
  taxonomyBatch: IDataLakeBatchSummary | undefined;
  onOpenSettings: () => void;
  /** Opens the review/apply panel for a batch whose taxonomy suggestions are ready or failed. */
  onReviewTaxonomy: (batchId: string) => void;
  /** Called after the active lake is archived, so the panel exits to root instead of the
   *  derived activeLake re-binding to a lake that just left the list (and a later restore
   *  teleporting back in). */
  onArchived: () => void;
}) {
  const openWizardForLake = useDataLakeWizardStore(s => s.openWizardForLake);
  const archiveLake = useArchiveDataLake();
  const startChatWithLake = useStartChatWithLake();
  const [startingChat, setStartingChat] = useState(false);
  const visibility = lake.isPublic ? 'Public' : lake.organizationId ? 'Organization' : 'Private';

  return (
    <Box
      data-testid="datalake-manager-lakeinfo"
      sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}
    >
      {/* pr clears the modal's absolutely-positioned ModalClose (top-right). */}
      <Box sx={{ px: 3, pr: 6, pt: 2.5, pb: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 1 }}>
          <Typography level="h4" sx={{ flex: 1, minWidth: 0 }}>
            {lake.name}
          </Typography>
          {/* Start chat is available to ANY user who can reach the lake (not manage-gated): it
              opens a session scoped to this lake, applying the lake's preferred prompt server-side.
              Minimal placement for now - see useStartChatWithLake's note; polish is a design follow-up. */}
          <Button
            size="sm"
            variant="soft"
            color="primary"
            startDecorator={<ChatBubbleOutlineIcon sx={{ fontSize: 16 }} />}
            data-testid={`datalake-startchat-btn-${lake.id}`}
            loading={startingChat}
            onClick={async () => {
              setStartingChat(true);
              try {
                await startChatWithLake(lake.id);
              } catch {
                toast.error('Could not start a chat with this lake');
              } finally {
                // Reset in finally, not only on error: a success that does not unmount this panel
                // (e.g. navigation interrupted) would otherwise leave the spinner stuck forever.
                setStartingChat(false);
              }
            }}
            sx={{ flexShrink: 0, fontSize: '13px' }}
          >
            Start chat
          </Button>
          {/* Add files / Settings / Archive are owner-or-admin only (the backend enforces the
              same rule). The nav surfaces other users' read-only public lakes too. */}
          {lake.canManage && (
            <>
              <Button
                size="sm"
                variant="soft"
                color="primary"
                startDecorator={<AddIcon sx={{ fontSize: 16 }} />}
                data-testid={`datalake-addfiles-btn-${lake.id}`}
                onClick={() =>
                  openWizardForLake({
                    id: lake.id,
                    slug: lake.slug,
                    name: lake.name,
                    fileTagPrefix: lake.fileTagPrefix,
                    requiredUserTag: lake.requiredUserTag,
                    requiredEntitlement: lake.requiredEntitlement,
                  })
                }
                sx={{ flexShrink: 0, fontSize: '13px' }}
              >
                Add files
              </Button>
              <Button
                size="sm"
                variant="outlined"
                color="neutral"
                startDecorator={<SettingsOutlinedIcon sx={{ fontSize: 16 }} />}
                data-testid={`datalake-settings-btn-${lake.id}`}
                onClick={onOpenSettings}
                sx={{ flexShrink: 0, fontSize: '13px' }}
              >
                Settings
              </Button>
              <Tooltip title="Archive (restorable from the manager home)" size="sm">
                <Button
                  size="sm"
                  variant="outlined"
                  color="warning"
                  startDecorator={<ArchiveOutlinedIcon sx={{ fontSize: 16 }} />}
                  data-testid={`datalake-archive-btn-${lake.id}`}
                  loading={archiveLake.isPending}
                  onClick={() => archiveLake.mutate(lake.id, { onSuccess: onArchived })}
                  sx={{ flexShrink: 0, fontSize: '13px' }}
                >
                  Archive
                </Button>
              </Tooltip>
            </>
          )}
        </Box>
        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
          {/* Not-your-lake marker: the sidebar lists lakes the caller can REACH, not only ones
              they own (org lakes, others' public lakes, and - for an admin - every tenant's, even
              private). Flagged here, next to Add files / Settings / Archive, so someone else's
              lake can't be mistaken for your own and managed by accident. */}
          {lake.isOwn === false && (
            <Chip
              size="sm"
              variant="soft"
              color="warning"
              startDecorator={<PersonOutlineIcon sx={{ fontSize: 12 }} />}
              sx={{ fontSize: '11px' }}
              data-testid={`datalake-manager-owner-chip-${lake.id}`}
            >
              {lake.ownerDisplayName ? `Owner: ${lake.ownerDisplayName}` : 'Owned by another user'}
            </Chip>
          )}
          <Chip size="sm" variant="soft" color="neutral" sx={{ fontSize: '11px' }}>
            {lake.fileTagPrefix}
          </Chip>
          {lake.requiredUserTag && (
            <Chip size="sm" variant="soft" color="primary" sx={{ fontSize: '11px' }}>
              {lake.requiredUserTag}
            </Chip>
          )}
          <Chip size="sm" variant="outlined" color="neutral" sx={{ fontSize: '11px' }}>
            {visibility}
          </Chip>
          {typeof fileCount === 'number' && (
            <Chip size="sm" variant="outlined" color="neutral" sx={{ fontSize: '11px' }}>
              {fileCount} {fileCount === 1 ? 'file' : 'files'}
            </Chip>
          )}
          {/* Background AI-tag suggestion progress - an independent clock from ingest, so this
              can appear well after the lake's files are already fully uploaded/searchable. */}
          {(taxonomyBatch?.taxonomyStatus === 'queued' || taxonomyBatch?.taxonomyStatus === 'analyzing') && (
            <Tooltip title="Usually ready in under a minute" size="sm">
              <Chip
                size="sm"
                variant="soft"
                color="primary"
                startDecorator={<AutoAwesomeIcon sx={{ fontSize: 12 }} />}
                sx={{ fontSize: '11px' }}
                data-testid={`datalake-manager-taxonomy-progress-chip-${lake.id}`}
              >
                AI tagging&hellip;
              </Chip>
            </Tooltip>
          )}
          {taxonomyBatch?.taxonomyStatus === 'ready' && (
            <Chip
              size="sm"
              variant="solid"
              color="success"
              startDecorator={<AutoAwesomeIcon sx={{ fontSize: 12 }} />}
              sx={{ fontSize: '11px', cursor: 'pointer' }}
              data-testid={`datalake-manager-taxonomy-review-chip-${lake.id}`}
              onClick={() => onReviewTaxonomy(taxonomyBatch.id)}
            >
              Review AI tags
            </Chip>
          )}
          {taxonomyBatch?.taxonomyStatus === 'failed' && (
            <Chip
              size="sm"
              variant="soft"
              color="warning"
              startDecorator={<ErrorOutlineIcon sx={{ fontSize: 12 }} />}
              sx={{ fontSize: '11px', cursor: 'pointer' }}
              data-testid={`datalake-manager-taxonomy-failed-chip-${lake.id}`}
              onClick={() => onReviewTaxonomy(taxonomyBatch.id)}
            >
              AI tagging failed
            </Chip>
          )}
        </Box>
      </Box>
      <Box sx={{ ...TREE_SCROLL_SX, px: 3, py: 2 }}>
        {lake.description ? (
          <Typography level="body-md" sx={{ whiteSpace: 'pre-wrap' }}>
            {lake.description}
          </Typography>
        ) : (
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            No description.
          </Typography>
        )}
        <Typography level="body-sm" sx={{ color: 'text.tertiary', mt: 2 }}>
          Browse the categories and files in the left sidebar - click a file to read it here.
        </Typography>
      </Box>
    </Box>
  );
}

// Right pane at root: pick-a-lake hint (the lifecycle sections live in the sidebar accordions)

function ManagerOverview() {
  return (
    <DataLakeEmptyState
      icon={<StorageIcon sx={{ fontSize: 18, color: 'text.tertiary' }} />}
      title="Select a data lake"
      data-testid="datalake-manager-overview"
    >
      Pick a lake on the left to see its details
      <br /> and browse its files, or create a new one.
    </DataLakeEmptyState>
  );
}
