import { useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  IconButton,
  Input,
  List,
  ListItem,
  ListItemButton,
  ListItemContent,
  Skeleton,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined';
import PersonOutlineIcon from '@mui/icons-material/PersonOutline';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import { useDataLakeSurface } from '@client/app/components/datalake/surfaceTokens';
import { lakeVisibilityLabelShort } from '@client/app/components/datalake/lakeVisibility';
import type { ManageableDataLakeConfig } from '@bike4mind/common';

/**
 * The page surface's lake list: the primary object, visible without opening a modal (#1645).
 *
 * Read-only navigation - it selects which lake the browse panes are scoped to and nothing else.
 * Lake-level MUTATIONS live on the header beside it, so this stays a list and the actions have a
 * single home. `null` selection is the explicit all-lakes scope, not an absence of choice.
 *
 * No Drive/source indicator per row on purpose: the manager list projection
 * (`ManageableDataLakeConfig`) carries no connection field, so a per-row badge would cost one
 * request per lake. The selected lake's source state is shown on the header instead, which needs
 * exactly one. Surfacing it per row wants a `driveConnected` flag on the list projection first.
 */
export interface DataLakeRailProps {
  lakes: ManageableDataLakeConfig[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /** null = the all-lakes scope. */
  selectedLakeId: string | null;
  onSelect: (lakeId: string | null) => void;
  /** Distinct live files per lake, keyed by `datalakeTag` (see DataLakeTagCountsResponse). */
  lakeFileCounts: Record<string, number> | undefined;
  /** Combined distinct-file count across every reachable lake, for the all-lakes row. */
  totalFileCount: number;
  onCreate?: () => void;
}

/** Below this many lakes a filter box is noise rather than help. */
const SEARCH_THRESHOLD = 8;

export default function DataLakeRail({
  lakes,
  isLoading,
  isError,
  onRetry,
  selectedLakeId,
  onSelect,
  lakeFileCounts,
  totalFileCount,
  onCreate,
}: DataLakeRailProps) {
  const muiTheme = useTheme();
  const isDark = muiTheme.palette.mode === 'dark';
  const { copy } = useDataLakeSurface();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    if (!lakes) return [];
    const q = query.trim().toLowerCase();
    if (!q) return lakes;
    return lakes.filter(l => l.name.toLowerCase().includes(q) || l.fileTagPrefix.toLowerCase().includes(q));
  }, [lakes, query]);

  const showSearch = (lakes?.length ?? 0) >= SEARCH_THRESHOLD;

  return (
    <Box
      data-testid="datalake-rail"
      sx={{
        width: 248,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        borderRight: '1px solid',
        borderColor: 'divider',
        bgcolor: isDark ? 'rgba(0,0,0,0.16)' : 'rgba(255,255,255,0.5)',
      }}
    >
      <Box sx={{ px: 2, pt: 2, pb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography level="title-sm" sx={{ color: 'text.secondary', flex: 1 }}>
          {copy.railTitle}
        </Typography>
        {/* The count is the honest answer to "do I have lakes?" - the question the old
            file-scoped empty state answered wrongly. Withheld while loading/erroring so it
            never reads as a confident zero. */}
        {!isLoading && !isError && (
          <Chip size="sm" variant="soft" color="neutral" data-testid="datalake-rail-count" sx={{ fontSize: '11px' }}>
            {lakes?.length ?? 0}
          </Chip>
        )}
        {onCreate && (
          <Tooltip title={copy.createLabel} size="sm">
            <IconButton
              size="sm"
              variant="plain"
              color="primary"
              data-testid="datalake-rail-create-btn"
              onClick={onCreate}
            >
              <AddIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        )}
      </Box>

      {showSearch && (
        <Box sx={{ px: 2, pb: 1 }}>
          <Input
            size="sm"
            placeholder="Filter lakes"
            value={query}
            onChange={e => setQuery(e.target.value)}
            startDecorator={<SearchIcon sx={{ fontSize: 16 }} />}
            slotProps={{ input: { 'data-testid': 'datalake-rail-search' } }}
          />
        </Box>
      )}

      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 1, pb: 1 }}>
        {isLoading ? (
          <Box data-testid="datalake-rail-loading" sx={{ px: 1, py: 0.5 }}>
            {[0, 1, 2].map(i => (
              <Skeleton key={i} variant="text" level="body-sm" sx={{ my: 1.25 }} />
            ))}
          </Box>
        ) : isError ? (
          // A failed read must not render as an empty list: an empty rail beside a
          // "create your first lake" pane is exactly the lie this issue is about.
          <Box data-testid="datalake-rail-error" sx={{ px: 1.5, py: 1.5 }}>
            <Typography level="body-sm" sx={{ color: 'danger.400', mb: 1 }}>
              {copy.lakesErrorTitle}
            </Typography>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              startDecorator={<RefreshIcon sx={{ fontSize: 16 }} />}
              onClick={onRetry}
              data-testid="datalake-rail-retry-btn"
            >
              Retry
            </Button>
          </Box>
        ) : (
          <List size="sm" sx={{ '--ListItem-radius': '8px', '--List-gap': '2px' }}>
            {/* All-lakes stays an explicit ROW rather than the unlabelled default the page used
                to open in, so cross-lake browse is something the user chose. */}
            <ListItem>
              <ListItemButton
                selected={selectedLakeId === null}
                onClick={() => onSelect(null)}
                data-testid="datalake-rail-all"
              >
                <LayersOutlinedIcon sx={{ fontSize: 16, flexShrink: 0, color: 'text.tertiary' }} />
                <ListItemContent>
                  <Typography noWrap level="body-sm">
                    {copy.allLakesLabel}
                  </Typography>
                </ListItemContent>
                <Typography level="body-xs" sx={{ fontFamily: 'monospace', color: 'text.tertiary' }}>
                  {totalFileCount || '-'}
                </Typography>
              </ListItemButton>
            </ListItem>

            {filtered.length === 0 ? (
              <ListItem>
                <Typography level="body-xs" sx={{ px: 1, py: 1, color: 'text.tertiary' }}>
                  {query ? 'No matches' : `No ${copy.allLakesLabel.toLowerCase()} yet`}
                </Typography>
              </ListItem>
            ) : (
              filtered.map(lake => {
                const count = lakeFileCounts?.[lake.datalakeTag];
                return (
                  <ListItem key={lake.id}>
                    <ListItemButton
                      selected={selectedLakeId === lake.id}
                      onClick={() => onSelect(lake.id)}
                      data-testid={`datalake-rail-lake-${lake.id}`}
                    >
                      <FolderOutlinedIcon sx={{ fontSize: 16, flexShrink: 0, color: 'text.tertiary' }} />
                      <ListItemContent sx={{ minWidth: 0 }}>
                        <Typography noWrap level="body-sm">
                          {lake.name}
                        </Typography>
                        <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                          {lakeVisibilityLabelShort(lake)}
                        </Typography>
                      </ListItemContent>
                      {/* Mirrors the manager list's marker: an admin sees every tenant's lakes,
                          so an unmarked row would read as their own. */}
                      {lake.isOwn === false && (
                        <Tooltip
                          size="sm"
                          title={lake.ownerDisplayName ? `Owned by ${lake.ownerDisplayName}` : 'Owned by another user'}
                        >
                          <PersonOutlineIcon
                            data-testid={`datalake-rail-owner-icon-${lake.id}`}
                            sx={{ fontSize: 14, color: 'warning.400', flexShrink: 0 }}
                          />
                        </Tooltip>
                      )}
                      {typeof count === 'number' && (
                        <Typography level="body-xs" sx={{ fontFamily: 'monospace', color: 'text.tertiary' }}>
                          {count}
                        </Typography>
                      )}
                    </ListItemButton>
                  </ListItem>
                );
              })
            )}
          </List>
        )}
      </Box>
    </Box>
  );
}
