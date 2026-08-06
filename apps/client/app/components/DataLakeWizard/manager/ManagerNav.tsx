import { useMemo, useState } from 'react';
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
  Tooltip,
  Typography,
  useTheme,
} from '@mui/joy';
import SearchIcon from '@mui/icons-material/Search';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import UnarchiveOutlinedIcon from '@mui/icons-material/UnarchiveOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import RestoreIcon from '@mui/icons-material/Restore';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { buildTagTree } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import { HUES, inkFor } from '@client/app/components/datalake/deckChrome';
import DataLakeTreeView, { type DataLakeTreeChrome } from '@client/app/components/datalake/DataLakeTreeView';
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
  useCleanupDataLake,
  useDataLakeFiles,
  useGetArchivedDataLakes,
  useGetDeletedDataLakes,
  usePermanentDeleteDataLake,
  useRestoreDeletedDataLake,
  useUnarchiveDataLake,
} from '@client/app/hooks/data/dataLakes';
import FieldTooltip from '@client/app/components/help/FieldTooltip';
import { FIELD_TOOLTIPS } from '@client/app/components/help/fieldTooltips';
import type { IDataLakeBatchSummary, IFabFileDocument } from '@bike4mind/common';
import { satisfiesTagPrefix } from '@bike4mind/common';
import type { ManagerLake } from './shared';
import { normalizePrefix, prefixSegments } from './shared';
import { EmptyHint, NavLifecycleSection, NavSectionHeader, NavSkeletons } from './navChrome';

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

export default function ManagerNav({
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
    if (!activeLake || path.length <= seedDepth) onExitLake();
    else onNavigate(path.slice(0, -1));
  };

  const backLabel = !activeLake
    ? ''
    : path.length <= seedDepth
      ? 'All Lakes'
      : path.length - 1 <= seedDepth
        ? activeLake.name
        : humanizeSegment(path[path.length - 2], path.length - 2);

  const rowTypographySx = { fontSize: '14px', fontWeight: 400, color: 'text.primary' } as const;

  // Bucket row for files with no prefix-matching tag - TreeView owns visibility (root only,
  // hidden while searching) and the synthetic-breadcrumb interception; this only renders the row.
  const renderUncategorizedRow = (count: number, onOpen: () => void) => (
    <ListItem>
      <ListItemButton onClick={onOpen} data-testid="datalake-manager-uncategorized" sx={treeRowSx(hoverBg)}>
        <FolderOutlinedIcon sx={{ fontSize: 16, color: 'neutral.400', flexShrink: 0 }} />
        <ListItemContent>
          <Typography noWrap sx={{ ...rowTypographySx, fontStyle: 'italic', color: 'text.secondary' }}>
            Uncategorized
          </Typography>
        </ListItemContent>
        <Chip size="sm" variant="soft" color="neutral" sx={COUNT_CHIP_SX}>
          {count}
        </Chip>
      </ListItemButton>
    </ListItem>
  );

  // Chrome for the in-lake DataLakeTreeView instance: the manager's own toolbar/back row/rows,
  // carried verbatim from the pre-fold-in JSX below (now render props instead of inline JSX).
  const managerTreeChrome: DataLakeTreeChrome = {
    containerSx: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, overflow: 'hidden' },
    // Dormant under hideToolbar (ManagerNav renders its own toolbar above) - kept accurate in
    // case a future host drops hideToolbar. No data-testid/data-sort here: the real toolbar
    // above already emits datalake-manager-sort-toggle, and duplicating it on this dormant
    // copy would be a latent duplicate-locator hazard if hideToolbar is ever dropped.
    toolbarSx: { mt: '12px', mb: '12px', px: '12px', display: 'flex', gap: '10px', alignItems: 'center' },
    searchPlaceholder: 'Search',
    searchSx: { flex: 1, '--Input-minHeight': '32px', color: 'text.primary', boxShadow: 'none' },
    renderSortButton: (sortMode, toggle) => {
      const SortIcon = SORT_MODE_ICON[sortMode];
      return (
        <Tooltip
          title={sortMode === 'count' ? 'Sort: by count (click for A-Z)' : 'Sort: A-Z (click for count)'}
          size="sm"
        >
          <IconButton variant="outlined" color="neutral" onClick={toggle} sx={{ ...ICON_BTN_SX, flexShrink: 0 }}>
            <SortIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      );
    },
    // Ignores TreeView's computed label/onBack: the seeded lake root needs the 'All Lakes'/
    // lake-name ladder (backLabel) and to exit the lake at that root (handleBack), not TreeView's
    // generic one-level-up back.
    renderBackRow: () => (
      <ListItemButton onClick={handleBack} data-testid="datalake-manager-back" sx={treeBackRowSx(hoverBg)}>
        <ArrowBackIcon sx={{ fontSize: 16, color: 'text.secondary', flexShrink: 0 }} />
        <Typography noWrap sx={rowTypographySx}>
          {backLabel}
        </Typography>
      </ListItemButton>
    ),
    backRowPlacement: 'sticky',
    stickyBackSx: TREE_BACK_STICKY_SX,
    scrollSx: { ...TREE_SCROLL_SX, px: '8px' },
    nodeListSx: TREE_LIST_SX,
    fileListSx: TREE_LIST_SX,
    renderNodeRow: (node, depth, onOpen) => (
      <ListItem>
        <ListItemButton onClick={onOpen} sx={treeRowSx(hoverBg)} data-testid={`datalake-manager-node-${node.segment}`}>
          <FolderOutlinedIcon
            sx={{ fontSize: 16, color: inkFor(hueForBranch(node.segment, path), isDark), flexShrink: 0 }}
          />
          <ListItemContent>
            <Typography noWrap sx={rowTypographySx}>
              {humanizeSegment(node.segment, depth)}
            </Typography>
          </ListItemContent>
          <Chip size="sm" variant="soft" color="neutral" sx={COUNT_CHIP_SX}>
            {node.fileCount}
          </Chip>
        </ListItemButton>
      </ListItem>
    ),
    renderFileRow: (file, selected, onSelect) => (
      <ListItem>
        <ListItemButton
          selected={selected}
          onClick={onSelect}
          data-testid={`datalake-manager-file-${file.id}`}
          sx={treeRowSx(hoverBg)}
        >
          <ArticleOutlinedIcon
            sx={{
              fontSize: 16,
              color: selected ? inkFor(HUES.cyan, isDark) : 'text.tertiary',
              flexShrink: 0,
            }}
          />
          <ListItemContent>
            <Typography noWrap sx={{ ...rowTypographySx, fontWeight: selected ? 'lg' : 400 }}>
              {file.fileName.replace(/\.[^/.]+$/, '')}
            </Typography>
          </ListItemContent>
        </ListItemButton>
      </ListItem>
    ),
    humanize: humanizeSegment,
    // Unused given the renderBackRow override above, but kept truthful.
    allCategoriesLabel: 'All Lakes',
    emptyFilesLabel: 'No files found',
    errorLabel: 'Failed to load files',
  };

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

      {!activeLake ? (
        <Box sx={{ ...TREE_SCROLL_SX, px: '8px' }}>
          {/* Root: accordions - active lakes (tree-folder rows) + the lifecycle lists. */}
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
                  This irreversibly deletes &ldquo;{purgeTarget?.name}&rdquo; and all its files, chunks, and batches.
                  This cannot be undone.
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
        </Box>
      ) : (
        <DataLakeTreeView
          tree={tree}
          articles={articles}
          breadcrumb={path}
          onNavigate={navigate}
          selectedFileId={selectedFileId}
          onSelectFile={onSelectFile}
          isLoading={filesLoading}
          isError={filesError}
          chrome={managerTreeChrome}
          uncategorized={{ files: uncategorizedFiles, renderRow: renderUncategorizedRow }}
          search={searchQuery}
          onSearchChange={setSearchQuery}
          sort={sortBy}
          onSortChange={setSortBy}
          hideToolbar
          leafMinDepth={seedDepth}
          alwaysShowBackRow
          testIds={{ container: 'datalake-manager-tree', error: 'datalake-manager-error' }}
        />
      )}

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
