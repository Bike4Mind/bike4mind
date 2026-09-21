import { useMemo, useState, type MouseEvent } from 'react';
import {
  Box,
  Button,
  Checkbox,
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
import { menuItemListSx, menuSurfaceSx } from '@client/app/components/layouts/Notebook/Sidenav/menuSurfaceSx';
import { useDataLakeSurface } from '@client/app/components/datalake/surfaceTokens';
import { lakeVisibilityLabelShort } from '@client/app/components/datalake/lakeVisibility';
import type { ManageableDataLakeConfig } from '@bike4mind/common';

/**
 * Which lakes the in-chat surface is scoped to: a trigger in the tree card's header opening the
 * full lake list (#1943). Replaces the standalone page's persistent rail - the chat already
 * spends its width on the conversation, so a third column is not available, but the list itself
 * (all-lakes row, per-lake scope + file count, foreign-owner marker, filter past a threshold)
 * survives intact one click away.
 *
 * The selection is a SET (#3042). It scopes the browse tree and, through the host, the session's
 * grounded retrieval, so this is the one control answering "which lakes am I talking to" - the
 * case it exists for is reaching the main corpus without the noisier connector-fed lakes beside
 * it. An EMPTY set is the explicit all-lakes scope, not an absence of choice.
 *
 * Read-only navigation: it chooses the scope and nothing else. Lake-level MUTATIONS live on the
 * SelectedLakeHeader strip below it, so this stays a list and the actions have a single home.
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
  /** Empty = the all-lakes scope. */
  selectedLakeIds: string[];
  /** Receives the WHOLE next set, so the host never has to replay the toggle to know it. */
  onChange: (lakeIds: string[]) => void;
  /**
   * The session grounds on NO lake - an empty scope its owner marked deliberate. Distinct from an
   * empty `selectedLakeIds`, which is the all-lakes scope; the two are opposites, so the trigger
   * must never show one as the other. Only an API caller can reach it (session create or update -
   * see SessionUpdateRequestSchema); picking in this menu always lands in one of the other two.
   */
  noLakeScope?: boolean;
  /** Distinct live files per lake, keyed by `datalakeTag` (see DataLakeTagCountsResponse). */
  lakeFileCounts: Record<string, number> | undefined;
  /**
   * Combined distinct-file count across every reachable lake, for the all-lakes row.
   * `undefined` means not yet known - a known zero is `0` and renders as such. Pass the raw
   * value rather than coalescing to 0, or a loading payload reads as an empty account.
   */
  totalFileCount: number | undefined;
  /** Opens the Create Lake wizard. */
  onCreate?: () => void;
  /** Opens the public-lake browse catalog (the manager's Discover tab). */
  onDiscover?: () => void;
}

/** Below this many lakes a filter box is noise rather than help. */
const SEARCH_THRESHOLD = 8;

/**
 * MUI's opt-out from a MenuItem dismissing its Dropdown: `useMenuItem` calls the item's own
 * onClick first and returns early instead of dispatching `close` when this is set. Load-bearing
 * for a multi-select list - without it, picking a second lake means reopening the menu.
 *
 * Declared locally rather than imported: the flag rides an ordinary React event, and reaching
 * into @mui/base (a transitive dep of Joy) for a two-field type would be the only import of it
 * in the app.
 */
type MenuDismissibleEvent = { defaultMuiPrevented?: boolean };

/** Toggles a row's lake without dismissing the list. */
const keepMenuOpen = (event: MenuDismissibleEvent) => {
  event.defaultMuiPrevented = true;
};

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
  selectedLakeIds,
  onChange,
  noLakeScope = false,
  lakeFileCounts,
  totalFileCount,
  onCreate,
  onDiscover,
}: DataLakeLakePickerProps) {
  const { copy } = useDataLakeSurface();
  const [query, setQuery] = useState('');

  const selectedIdSet = useMemo(() => new Set(selectedLakeIds), [selectedLakeIds]);

  // The selection in LIST order, not click order, so the label of a two-lake scope does not
  // depend on which one was ticked first. Resolved against `lakes` for the same reason the host
  // derives its own scope from that list: an id whose lake has since been deleted or archived is
  // not a scope anything else is honouring.
  const selectedLakes = useMemo(() => lakes?.filter(l => selectedIdSet.has(l.id)) ?? [], [lakes, selectedIdSet]);
  const soleSelectedLake = selectedLakes.length === 1 ? selectedLakes[0] : null;

  const filtered = useMemo(() => {
    if (!lakes) return [];
    const q = query.trim().toLowerCase();
    if (!q) return lakes;
    return lakes.filter(l => l.name.toLowerCase().includes(q) || l.fileTagPrefix.toLowerCase().includes(q));
  }, [lakes, query]);

  const showSearch = (lakes?.length ?? 0) >= SEARCH_THRESHOLD;

  // Only the two scopes with an HONEST figure print one. The per-lake counts are distinct live
  // files per lake, so a multi-lake scope would have to sum them - and a file that sits in two
  // selected lakes is then counted twice, which is exactly why the all-lakes total is a separate
  // server-side figure rather than arithmetic (see totalFileCount). A wrong number on the control
  // naming the scope is worse than no number, so a multi-lake scope prints none.
  const selectedCount =
    noLakeScope || selectedLakes.length > 1
      ? undefined
      : selectedLakes.length === 0
        ? totalFileCount
        : lakeFileCounts?.[selectedLakes[0].datalakeTag];

  const toggleLake = (lakeId: string) =>
    onChange(selectedIdSet.has(lakeId) ? selectedLakeIds.filter(id => id !== lakeId) : [...selectedLakeIds, lakeId]);

  const lakeTotal = lakes?.length ?? 0;
  // While a filter is narrowing the list, the bare total reads as a stale count sitting under a
  // shorter set of rows (or under "No matches"), so name both numbers.
  const lakeCountLabel =
    query && filtered.length !== lakeTotal
      ? `${filtered.length} of ${lakeTotal} lakes`
      : `${lakeTotal} ${lakeTotal === 1 ? 'lake' : 'lakes'}`;

  return (
    <Box sx={{ px: '12px', pt: '12px' }}>
      {/* The filter is scratch state for one browse, not a setting: a query left over from a
          previous open would greet the next one with a narrowed list and a "1 of 10 lakes"
          chip, which reads as a broken picker rather than a remembered choice. */}
      <Dropdown onOpenChange={(_, isOpen) => !isOpen && setQuery('')}>
        <MenuButton
          variant="outlined"
          color="neutral"
          size="sm"
          data-testid="datalake-lake-picker-btn"
          endDecorator={<ExpandMoreIcon sx={{ fontSize: 18 }} />}
          sx={{ width: '100%', justifyContent: 'flex-start', gap: '8px', fontWeight: 400 }}
        >
          {soleSelectedLake ? (
            <FolderOutlinedIcon sx={{ fontSize: 16, flexShrink: 0, color: 'text.tertiary' }} />
          ) : (
            <LayersOutlinedIcon sx={{ fontSize: 16, flexShrink: 0, color: 'text.tertiary' }} />
          )}
          {/* textColor=inherit is load-bearing: Joy defaults `body-sm`/`body-xs` to
              `text.tertiary`, which this theme defines as the brand hue at 50% alpha (~2.2:1 on
              the light surface). That is fine for a subtitle but not for the label naming the
              current scope - the one thing this control exists to tell you. The button's own
              color is solid, so inheriting it is both legible and themed. */}
          {/* One lake still reads as its NAME rather than "1 lake": the single-lake scope is the
              common case and the name is the more useful thing to show. Past one, the names do
              not fit the trigger, so the count stands in and the ticks in the list are the
              itemised answer - with the active set also named in full on the strip below. */}
          <Typography
            noWrap
            level="body-sm"
            textColor="inherit"
            sx={{ flex: 1, textAlign: 'left', minWidth: 0 }}
            data-testid="datalake-lake-picker-label"
          >
            {noLakeScope
              ? copy.noLakesLabel
              : selectedLakes.length === 0
                ? copy.allLakesLabel
                : (soleSelectedLake?.name ?? `${selectedLakes.length} lakes`)}
          </Typography>
          {/* Withheld only while the count is UNKNOWN. A known zero prints 0: suppressing it too
              made an empty lake indistinguishable from a still-loading one, which is the very
              ambiguity this guard exists to prevent. */}
          {typeof selectedCount === 'number' && (
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
            // 2px, matching the row action menu: this list is dense and can run long.
            ...menuItemListSx(theme, { gap: '2px' }),
            minWidth: 236,
            maxWidth: 300,
            maxHeight: 360,
            overflowY: 'auto',
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
                  cross-lake browse is something the user chose. It is the CLEAR action for the
                  set, not a member of it, so it carries no checkbox - ticking every lake by hand
                  and choosing "all" are different scopes once a new lake appears. */}
              <MenuItem
                selected={selectedLakes.length === 0 && !noLakeScope}
                onClick={(e: MouseEvent & MenuDismissibleEvent) => {
                  keepMenuOpen(e);
                  onChange([]);
                }}
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
                  {typeof totalFileCount === 'number' ? totalFileCount : '-'}
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
                  const isSelected = selectedIdSet.has(lake.id);
                  return (
                    <MenuItem
                      key={lake.id}
                      selected={isSelected}
                      // The row, not the box, owns the click: a Checkbox with its own handler
                      // inside a clickable row toggles twice and lands back where it started.
                      onClick={(e: MouseEvent & MenuDismissibleEvent) => {
                        keepMenuOpen(e);
                        toggleLake(lake.id);
                      }}
                      data-testid={`datalake-lake-picker-lake-${lake.id}`}
                    >
                      <ListItemDecorator>
                        <Checkbox
                          size="sm"
                          checked={isSelected}
                          readOnly
                          tabIndex={-1}
                          // aria-hidden + the row's own aria-selected: announcing a checkbox the
                          // row already reports as selected reads the state twice.
                          aria-hidden
                          sx={{ pointerEvents: 'none' }}
                          slotProps={{ input: { 'data-testid': `datalake-lake-picker-check-${lake.id}` } }}
                        />
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
          {/* A shortcut, not a restoration: Discover was already reachable through Manage ->
              the manager's own Discover button, and still is. It is duplicated here because it
              is a "find more lakes" action and this is the lake list, so it belongs one click
              from the scope you are trying to change rather than two through a modal. */}
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
