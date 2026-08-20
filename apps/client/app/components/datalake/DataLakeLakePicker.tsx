import { useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Dropdown,
  Input,
  ListDivider,
  ListItem,
  ListItemContent,
  ListItemDecorator,
  Menu,
  MenuButton,
  MenuItem,
  Skeleton,
  Tooltip,
  Typography,
} from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined';
import PersonOutlineIcon from '@mui/icons-material/PersonOutline';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import TravelExploreIcon from '@mui/icons-material/TravelExplore';
import { menuSurfaceSx } from '@client/app/components/layouts/Notebook/Sidenav/menuSurfaceSx';
import { useDataLakeSurface } from '@client/app/components/datalake/surfaceTokens';
import { lakeVisibilityLabelShort } from '@client/app/components/datalake/lakeVisibility';
import type { ManageableDataLakeConfig } from '@bike4mind/common';

/**
 * Which lake the in-chat surface is scoped to: a trigger in the tree card's header opening the
 * full lake list (#1943). Replaces the standalone page's persistent rail - the chat already
 * spends its width on the conversation, so a third column is not available, but the list itself
 * (all-lakes row, per-lake scope + file count, foreign-owner marker, filter past a threshold)
 * survives intact one click away.
 *
 * Read-only navigation: it chooses the scope and nothing else. Lake-level MUTATIONS live on the
 * SelectedLakeHeader strip below it, so this stays a list and the actions have a single home.
 * `null` selection is the explicit all-lakes scope, not an absence of choice.
 *
 * No Drive/source indicator per row on purpose: the manager list projection
 * (`ManageableDataLakeConfig`) carries no connection field, so a per-row badge would cost one
 * request per lake. The selected lake's source state is shown on the header strip instead, which
 * needs exactly one. Surfacing it per row wants a `driveConnected` flag on the list projection.
 */
export interface DataLakeLakePickerProps {
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
  /** Opens the Create Lake wizard. */
  onCreate?: () => void;
  /** Opens the public-lake browse catalog (the manager's Discover tab). */
  onDiscover?: () => void;
}

/** Below this many lakes a filter box is noise rather than help. */
const SEARCH_THRESHOLD = 8;

/** Monospaced count, right-aligned, so the column of numbers lines up down the menu. */
const COUNT_SX = { fontFamily: 'monospace', color: 'text.tertiary', flexShrink: 0 } as const;

/**
 * Same column treatment for the trigger's count, but inheriting the button's color rather than
 * `text.tertiary`. See the trigger label below for why: on the button, tertiary is unreadable.
 */
const TRIGGER_COUNT_SX = { fontFamily: 'monospace', flexShrink: 0 } as const;

export default function DataLakeLakePicker({
  lakes,
  isLoading,
  isError,
  onRetry,
  selectedLakeId,
  onSelect,
  lakeFileCounts,
  totalFileCount,
  onCreate,
  onDiscover,
}: DataLakeLakePickerProps) {
  const { copy } = useDataLakeSurface();
  const [query, setQuery] = useState('');

  const selectedLake = useMemo(
    () => (selectedLakeId ? (lakes?.find(l => l.id === selectedLakeId) ?? null) : null),
    [lakes, selectedLakeId]
  );

  const filtered = useMemo(() => {
    if (!lakes) return [];
    const q = query.trim().toLowerCase();
    if (!q) return lakes;
    return lakes.filter(l => l.name.toLowerCase().includes(q) || l.fileTagPrefix.toLowerCase().includes(q));
  }, [lakes, query]);

  const showSearch = (lakes?.length ?? 0) >= SEARCH_THRESHOLD;
  const selectedCount = selectedLake ? lakeFileCounts?.[selectedLake.datalakeTag] : totalFileCount;

  const lakeTotal = lakes?.length ?? 0;
  // While a filter is narrowing the list, the bare total reads as a stale count sitting under a
  // shorter set of rows (or under "No matches"), so name both numbers.
  const lakeCountLabel =
    query && filtered.length !== lakeTotal
      ? `${filtered.length} of ${lakeTotal} lakes`
      : `${lakeTotal} ${lakeTotal === 1 ? 'lake' : 'lakes'}`;

  return (
    <Box sx={{ px: '12px', pt: '12px' }}>
      <Dropdown>
        <MenuButton
          variant="outlined"
          color="neutral"
          size="sm"
          data-testid="datalake-lake-picker-btn"
          endDecorator={<ExpandMoreIcon sx={{ fontSize: 18 }} />}
          sx={{ width: '100%', justifyContent: 'flex-start', gap: '8px', fontWeight: 400 }}
        >
          {selectedLake ? (
            <FolderOutlinedIcon sx={{ fontSize: 16, flexShrink: 0, color: 'text.tertiary' }} />
          ) : (
            <LayersOutlinedIcon sx={{ fontSize: 16, flexShrink: 0, color: 'text.tertiary' }} />
          )}
          {/* textColor=inherit is load-bearing: Joy defaults `body-sm`/`body-xs` to
              `text.tertiary`, which this theme defines as the brand hue at 50% alpha (~2.2:1 on
              the light surface). That is fine for a subtitle but not for the label naming the
              current scope - the one thing this control exists to tell you. The button's own
              color is solid, so inheriting it is both legible and themed. */}
          <Typography noWrap level="body-sm" textColor="inherit" sx={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
            {selectedLake ? selectedLake.name : copy.allLakesLabel}
          </Typography>
          {/* Withheld while the counts are unknown so the trigger never shows a confident zero. */}
          {typeof selectedCount === 'number' && selectedCount > 0 && (
            <Typography
              level="body-xs"
              textColor="inherit"
              sx={TRIGGER_COUNT_SX}
              data-testid="datalake-lake-picker-count"
            >
              {selectedCount}
            </Typography>
          )}
        </MenuButton>
        <Menu
          size="sm"
          placement="bottom-start"
          data-testid="datalake-lake-picker-menu"
          sx={theme => ({
            ...menuSurfaceSx(theme),
            borderRadius: '8px',
            minWidth: 236,
            maxWidth: 300,
            maxHeight: 360,
            overflowY: 'auto',
            '--List-padding': '8px',
            '--List-radius': '8px',
            '--List-gap': '2px',
          })}
        >
          {showSearch && (
            /* The menu owns arrow-key navigation and typeahead, both of which would steal the
               keystrokes meant for this box, so its keydowns stop here. */
            <ListItem sx={{ px: '4px', pb: '6px' }} onKeyDown={e => e.stopPropagation()}>
              <Input
                size="sm"
                autoFocus
                placeholder="Filter lakes"
                value={query}
                onChange={e => setQuery(e.target.value)}
                startDecorator={<SearchIcon sx={{ fontSize: 16 }} />}
                slotProps={{ input: { 'data-testid': 'datalake-lake-picker-search' } }}
                sx={{ width: '100%' }}
              />
            </ListItem>
          )}

          {isLoading ? (
            <ListItem data-testid="datalake-lake-picker-loading" sx={{ display: 'block', px: 1, py: 0.5 }}>
              {[0, 1, 2].map(i => (
                <Skeleton key={i} variant="text" level="body-sm" sx={{ my: 1.25 }} />
              ))}
            </ListItem>
          ) : isError ? (
            // A failed read must not render as an empty list: an empty picker beside a
            // "create your first lake" tree is exactly the lie #1645 removed.
            <ListItem data-testid="datalake-lake-picker-error" sx={{ display: 'block', px: 1, py: 1 }}>
              <Typography level="body-sm" sx={{ color: 'danger.400', mb: 1 }}>
                {copy.lakesErrorTitle}
              </Typography>
              <Button
                size="sm"
                variant="outlined"
                color="neutral"
                startDecorator={<RefreshIcon sx={{ fontSize: 16 }} />}
                onClick={onRetry}
                data-testid="datalake-lake-picker-retry-btn"
              >
                Retry
              </Button>
            </ListItem>
          ) : (
            <>
              {/* All-lakes stays an explicit ROW rather than an unlabelled default, so
                  cross-lake browse is something the user chose. */}
              <MenuItem
                selected={selectedLakeId === null}
                onClick={() => onSelect(null)}
                data-testid="datalake-lake-picker-all"
              >
                <ListItemDecorator>
                  <LayersOutlinedIcon sx={{ fontSize: 16, color: 'text.tertiary' }} />
                </ListItemDecorator>
                <ListItemContent>
                  <Typography noWrap level="body-sm">
                    {copy.allLakesLabel}
                  </Typography>
                </ListItemContent>
                <Typography level="body-xs" sx={COUNT_SX}>
                  {totalFileCount || '-'}
                </Typography>
              </MenuItem>

              {filtered.length === 0 ? (
                <ListItem>
                  <Typography level="body-xs" sx={{ px: 1, py: 1, color: 'text.tertiary' }}>
                    {/* rootLabel, not allLakesLabel: the latter is the "All data lakes" ROW label,
                        which reads as "No all data lakes yet" in a sentence. */}
                    {query ? 'No matches' : `No ${copy.rootLabel.toLowerCase()} yet`}
                  </Typography>
                </ListItem>
              ) : (
                filtered.map(lake => {
                  const count = lakeFileCounts?.[lake.datalakeTag];
                  return (
                    <MenuItem
                      key={lake.id}
                      selected={selectedLakeId === lake.id}
                      onClick={() => onSelect(lake.id)}
                      data-testid={`datalake-lake-picker-lake-${lake.id}`}
                    >
                      <ListItemDecorator>
                        <FolderOutlinedIcon sx={{ fontSize: 16, color: 'text.tertiary' }} />
                      </ListItemDecorator>
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
                            data-testid={`datalake-lake-picker-owner-icon-${lake.id}`}
                            sx={{ fontSize: 14, color: 'warning.400', flexShrink: 0 }}
                          />
                        </Tooltip>
                      )}
                      {typeof count === 'number' && (
                        <Typography level="body-xs" sx={COUNT_SX}>
                          {count}
                        </Typography>
                      )}
                    </MenuItem>
                  );
                })
              )}
            </>
          )}

          {(onCreate || onDiscover) && <ListDivider sx={{ my: '6px' }} />}
          {onCreate && (
            <MenuItem onClick={onCreate} data-testid="datalake-lake-picker-create-btn">
              <ListItemDecorator>
                <AddIcon sx={{ fontSize: 16 }} />
              </ListItemDecorator>
              <Typography noWrap level="body-sm">
                {copy.createLabel}
              </Typography>
            </MenuItem>
          )}
          {/* Discover has no other home on this surface: the standalone page was the only thing
              that ever passed it, so public-lake browse was unreachable while that page was
              (#1943). It sits with the lake list because it is a "find more lakes" action. */}
          {onDiscover && (
            <MenuItem onClick={onDiscover} data-testid="datalake-lake-picker-discover-btn">
              <ListItemDecorator>
                <TravelExploreIcon sx={{ fontSize: 16 }} />
              </ListItemDecorator>
              <Typography noWrap level="body-sm">
                Discover
              </Typography>
            </MenuItem>
          )}
          {/* Count of reachable lakes: the honest answer to "do I have lakes?", withheld while
              loading or erroring so it never reads as a confident zero. */}
          {!isLoading && !isError && (
            <ListItem sx={{ mt: '6px' }}>
              <Chip
                size="sm"
                variant="soft"
                color="neutral"
                data-testid="datalake-lake-picker-lake-count"
                sx={{ fontSize: '11px' }}
              >
                {lakeCountLabel}
              </Chip>
            </ListItem>
          )}
        </Menu>
      </Dropdown>
    </Box>
  );
}
