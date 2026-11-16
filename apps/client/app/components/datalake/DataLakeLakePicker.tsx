import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Dropdown,
  IconButton,
  Input,
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
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import TravelExploreIcon from '@mui/icons-material/TravelExplore';
import { menuItemListSx, menuSurfaceSx } from '@client/app/components/layouts/Notebook/Sidenav/menuSurfaceSx';
import { useDataLakeSurface } from '@client/app/components/datalake/surfaceTokens';
import { isDraftLake, lakeVisibilityLabelShort } from '@client/app/components/datalake/lakeVisibility';
import LakeOwnerIcon from '@client/app/components/datalake/LakeOwnerIcon';
import LakeDraftChip from '@client/app/components/datalake/LakeDraftChip';
import { isUnsearchable, UnsearchableLakeIcon } from '@client/app/components/datalake/lakeRetrievability';
import type { RetrievabilityLabeledDataLake } from '@bike4mind/common';

/**
 * Which lakes the in-chat surface is scoped to: a trigger in the tree card's header opening the
 * full lake list (#1943). Replaces the standalone page's persistent rail - the chat already
 * spends its width on the conversation, so a third column is not available, but the list itself
 * (per-lake scope + file count, foreign-owner marker, filter past a threshold)
 * survives intact one click away, grouped by owner so other users' lakes do not mix into the
 * caller's own.
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
  lakes: RetrievabilityLabeledDataLake[] | undefined;
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
   * Combined distinct-file count across every reachable lake, for the all-lakes trigger.
   * `undefined` means not yet known - a known zero is `0` and renders as such. Pass the raw
   * value rather than coalescing to 0, or a loading payload reads as an empty account.
   */
  totalFileCount: number | undefined;
  /** Opens the Create Lake wizard. */
  onCreate?: () => void;
  /** Opens the public-lake browse catalog (the manager's Discover tab). */
  onDiscover?: () => void;
  /** Called each time the list opens, so the host can refresh names and counts a background sync changed. */
  onOpen?: () => void;
}

/** Below this many lakes a filter box is noise rather than help, unless it has Create or Discover to sit beside. */
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

/**
 * The picker prints two kinds of count - files per scope and lakes in the list - and bare numbers
 * beside each other read as the same unit ("All data lakes 255" over a "43 lakes" footer looks
 * like a disagreement). Every file count therefore names its unit, or sits under a column that does.
 */
const fileCountLabel = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;
const lakeCountLabel = (n: number) => `${n} ${n === 1 ? 'lake' : 'lakes'}`;

interface LakeGroup {
  key: string;
  label: string;
  lakes: RetrievabilityLabeledDataLake[];
}

/**
 * Splits the list into the caller's own lakes, then one group per other owner. The manager list is
 * "lakes I can reach", so for an admin it holds every tenant's lakes (test lakes included); a flat
 * list leaves the per-row owner icon as the only thing separating them from the caller's own.
 * Own first because that is what a user scopes to most; other owners alphabetical, with lakes whose
 * owner is unresolved (built-in fallbacks, deleted accounts) last. List order is kept within a group.
 * Owner groups key on `ownerUserId` (falling back to the name for payloads without it), so two
 * owners sharing a display name get separate headers, told apart by username.
 */
const groupLakesByOwner = (lakes: RetrievabilityLabeledDataLake[]): LakeGroup[] => {
  const own: RetrievabilityLabeledDataLake[] = [];
  const byOwner = new Map<string, { name: string; username?: string; lakes: RetrievabilityLabeledDataLake[] }>();
  const unknownOwner: RetrievabilityLabeledDataLake[] = [];
  for (const lake of lakes) {
    if (lake.isOwn !== false) own.push(lake);
    else if (lake.ownerDisplayName) {
      const key = lake.ownerUserId ?? lake.ownerDisplayName;
      const bucket = byOwner.get(key);
      if (bucket) bucket.lakes.push(lake);
      else byOwner.set(key, { name: lake.ownerDisplayName, username: lake.ownerUsername, lakes: [lake] });
    } else unknownOwner.push(lake);
  }
  const nameCounts = new Map<string, number>();
  for (const { name } of byOwner.values()) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  const groups: LakeGroup[] = [];
  if (own.length) groups.push({ key: 'own', label: 'Your lakes', lakes: own });
  [...byOwner]
    .map(([key, { name, username, lakes: ownerLakes }]) => ({
      key: `owner:${key}`,
      label: (nameCounts.get(name) ?? 0) > 1 && username ? `Owned by ${name} (${username})` : `Owned by ${name}`,
      lakes: ownerLakes,
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key))
    .forEach(group => groups.push(group));
  if (unknownOwner.length) groups.push({ key: 'unknown', label: 'Other lakes', lakes: unknownOwner });
  return groups;
};

interface LakeRowProps {
  lake: RetrievabilityLabeledDataLake;
  count: number | undefined;
  isSelected: boolean;
  onToggle: (lakeId: string) => void;
}

/**
 * One lake in the list. Memoized, and fed a stable `onToggle`, so ticking a lake or typing in the
 * filter re-renders the rows that changed rather than every row: the list holds each lake the
 * caller can reach, which for an admin is every tenant's.
 */
const LakeRow = memo(function LakeRow({ lake, count, isSelected, onToggle }: LakeRowProps) {
  return (
    <MenuItem
      selected={isSelected}
      // The row, not the box, owns the click: a Checkbox with its own handler
      // inside a clickable row toggles twice and lands back where it started.
      onClick={(e: MouseEvent & MenuDismissibleEvent) => {
        keepMenuOpen(e);
        onToggle(lake.id);
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
        <Typography noWrap level="body-sm" sx={{ color: 'text.primary' }}>
          {lake.name}
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
          <Typography noWrap level="body-xs" sx={{ color: 'text.tertiary', minWidth: 0 }}>
            {lakeVisibilityLabelShort(lake)}
          </Typography>
          {isDraftLake(lake) && <LakeDraftChip testId={`datalake-lake-picker-draft-chip-${lake.id}`} />}
        </Box>
      </ListItemContent>
      {/* Mirrors the manager list's marker: an admin sees every tenant's lakes,
        so an unmarked row would read as their own. */}
      {lake.isOwn === false && <LakeOwnerIcon lake={lake} testId={`datalake-lake-picker-owner-icon-${lake.id}`} />}
      {/* Marked, not disabled: selection also scopes the browse tree, which still works. */}
      {isUnsearchable(lake) && (
        <UnsearchableLakeIcon lake={lake} testId={`datalake-lake-picker-unsearchable-${lake.id}`} />
      )}
      {typeof count === 'number' && (
        <Typography level="body-xs" sx={COUNT_SX} aria-label={fileCountLabel(count)}>
          {count}
        </Typography>
      )}
    </MenuItem>
  );
});

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
  onOpen,
}: DataLakeLakePickerProps) {
  const { copy } = useDataLakeSurface();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  // The box keeps up with typing; the list narrows a beat later when it is long.
  const deferredQuery = useDeferredValue(query);

  const selectedIdSet = useMemo(() => new Set(selectedLakeIds), [selectedLakeIds]);

  // The selection in LIST order, not click order, so the label of a two-lake scope does not
  // depend on which one was ticked first. Resolved against `lakes` for the same reason the host
  // derives its own scope from that list: an id whose lake has since been deleted or archived is
  // not a scope anything else is honouring.
  const selectedLakes = useMemo(() => lakes?.filter(l => selectedIdSet.has(l.id)) ?? [], [lakes, selectedIdSet]);
  const soleSelectedLake = selectedLakes.length === 1 ? selectedLakes[0] : null;

  const filtered = useMemo(() => {
    if (!lakes) return [];
    const q = deferredQuery.trim().toLowerCase();
    if (!q) return lakes;
    return lakes.filter(l => l.name.toLowerCase().includes(q) || l.fileTagPrefix.toLowerCase().includes(q));
  }, [lakes, deferredQuery]);

  const groups = useMemo(() => groupLakesByOwner(filtered), [filtered]);

  const showSearch = (lakes?.length ?? 0) >= SEARCH_THRESHOLD || !!onCreate || !!onDiscover;
  const leaveFor = (action: () => void) => {
    setOpen(false);
    setQuery('');
    action();
  };

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

  // Read at click time through a ref, so the callback the rows hold never changes identity and a
  // tick does not re-render every other row.
  const latest = useRef({ selectedLakeIds, onChange });
  useEffect(() => {
    latest.current = { selectedLakeIds, onChange };
  });
  const toggleLake = useCallback((lakeId: string) => {
    const { selectedLakeIds: ids, onChange: change } = latest.current;
    change(ids.includes(lakeId) ? ids.filter(id => id !== lakeId) : [...ids, lakeId]);
  }, []);

  // The all-lakes trigger reads as its two counts alone ("36 lakes, 1539 files"): the figures
  // already say this is the lake list, and it is the one place the count of reachable lakes is
  // printed. Until the list has loaded there is no lake count to print, so the row's own label
  // stands in rather than a confident zero.
  const allLakesScope = selectedLakes.length === 0 && !noLakeScope;
  const allLakesSummary =
    lakes && !isError
      ? [
          lakeCountLabel(lakes.length),
          ...(typeof selectedCount === 'number' ? [fileCountLabel(selectedCount)] : []),
        ].join(', ')
      : copy.allLakesLabel;

  return (
    <Box sx={{ px: '12px', pt: '12px' }}>
      {/* The filter is scratch state for one browse, not a setting: a query left over from a
          previous open would greet the next one with a narrowed list, which reads as a broken picker
          rather than a remembered choice. */}
      <Dropdown
        open={open}
        onOpenChange={(_, isOpen) => {
          setOpen(isOpen);
          if (isOpen) onOpen?.();
          else setQuery('');
        }}
      >
        <MenuButton
          variant="outlined"
          color="neutral"
          size="sm"
          data-testid="datalake-lake-picker-btn"
          endDecorator={
            <ExpandMoreIcon
              sx={{ fontSize: 18, transition: 'transform 0.2s ease', transform: open ? 'rotate(180deg)' : 'none' }}
            />
          }
          sx={{ width: '100%', justifyContent: 'flex-start', gap: '8px', fontWeight: 400 }}
        >
          {soleSelectedLake && <FolderOutlinedIcon sx={{ fontSize: 16, flexShrink: 0, color: 'text.tertiary' }} />}
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
              : allLakesScope
                ? allLakesSummary
                : (soleSelectedLake?.name ?? `${selectedLakes.length} lakes`)}
          </Typography>
          {/* Withheld only while the count is UNKNOWN. A known zero prints 0: suppressing it too
              made an empty lake indistinguishable from a still-loading one, which is the very
              ambiguity this guard exists to prevent. */}
          {!allLakesScope && typeof selectedCount === 'number' && (
            <Typography
              level="body-xs"
              textColor="inherit"
              sx={TRIGGER_COUNT_SX}
              data-testid="datalake-lake-picker-count"
            >
              ({fileCountLabel(selectedCount)})
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
            maxWidth: 320,
            maxHeight: 360,
            overflowY: 'auto',
          })}
        >
          {showSearch && (
            /* The menu owns arrow-key navigation and typeahead, both of which would steal the
               keystrokes meant for this box, so its keydowns stop here. */
            <ListItem sx={{ px: '4px', pb: '6px', gap: '6px' }} onKeyDown={e => e.stopPropagation()}>
              <Input
                size="sm"
                autoFocus
                placeholder="Filter lakes"
                value={query}
                onChange={e => setQuery(e.target.value)}
                startDecorator={<SearchIcon sx={{ fontSize: 16 }} />}
                slotProps={{ input: { 'data-testid': 'datalake-lake-picker-search' } }}
                sx={{ flex: 1, minWidth: 0 }}
              />
              {/* Icon buttons, not MenuItems, so nothing dismisses the list for them. */}
              {onDiscover && (
                <Tooltip title="Discover" disableInteractive>
                  <IconButton
                    size="sm"
                    variant="outlined"
                    color="neutral"
                    aria-label="Discover"
                    onClick={() => leaveFor(onDiscover)}
                    data-testid="datalake-lake-picker-discover-btn"
                  >
                    <TravelExploreIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
              )}
              {onCreate && (
                <Tooltip title={copy.createLabel} disableInteractive>
                  <IconButton
                    size="sm"
                    variant="outlined"
                    color="neutral"
                    aria-label={copy.createLabel}
                    onClick={() => leaveFor(onCreate)}
                    data-testid="datalake-lake-picker-create-btn"
                  >
                    <AddIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
              )}
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
              {/* No all-lakes row: the trigger already reads as that scope's counts, and unticking
                  the last lake returns to it - the empty set IS the all-lakes scope. */}
              {filtered.length === 0 ? (
                <ListItem>
                  <Typography level="body-xs" sx={{ px: 1, py: 1, color: 'text.tertiary' }}>
                    {/* rootLabel, not allLakesLabel: the latter names the all-lakes scope,
                        which reads as "No all data lakes yet" in a sentence. */}
                    {deferredQuery ? 'No matches' : `No ${copy.rootLabel.toLowerCase()} yet`}
                  </Typography>
                </ListItem>
              ) : (
                groups.map(group => [
                  // A header, not a row: role="none" keeps it out of the menu's arrow-key order.
                  // Its right edge labels the count column below it, so the per-lake numbers need
                  // no unit of their own and still line up.
                  <ListItem
                    key={`group-${group.key}`}
                    role="none"
                    data-testid={`datalake-lake-picker-group-${group.key}`}
                    sx={{ pt: '8px', pb: '2px', px: '8px', minBlockSize: 0, gap: '8px' }}
                  >
                    <Typography
                      noWrap
                      level="body-xs"
                      sx={{ flex: 1, minWidth: 0, fontWeight: 600, color: 'text.tertiary' }}
                    >
                      {group.label}
                    </Typography>
                    <Typography level="body-xs" sx={{ color: 'text.tertiary', flexShrink: 0 }}>
                      files
                    </Typography>
                  </ListItem>,
                  ...group.lakes.map(lake => (
                    <LakeRow
                      key={lake.id}
                      lake={lake}
                      count={lakeFileCounts?.[lake.datalakeTag]}
                      isSelected={selectedIdSet.has(lake.id)}
                      onToggle={toggleLake}
                    />
                  )),
                ])
              )}
            </>
          )}
        </Menu>
      </Dropdown>
    </Box>
  );
}
