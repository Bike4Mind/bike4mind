import { Box, Chip, ChipDelete, Stack, Tooltip, Typography } from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import type { ManageableDataLakeConfig } from '@bike4mind/common';
import { useDataLakeSurface } from './surfaceTokens';
import { isDraftLake, DRAFT_LAKE_TOOLTIP } from './lakeVisibility';

/**
 * Names every lake the chat is currently grounded on, for the multi-lake scope the picker trigger
 * can only report as a number (#3042). The whole point of narrowing to a subset is knowing which
 * subset, and "3 lakes" on a collapsed dropdown does not answer that - a user who cannot see the
 * set without reopening the menu cannot tell a deliberate scope from a stale one.
 *
 * Takes the strip slot under the picker that SelectedLakeHeader occupies for a single-lake scope;
 * the two are mutually exclusive, so the card never grows a second header. It deliberately
 * carries no lake-level ACTIONS, unlike that header: every one of them (Add files, Configure,
 * Connect Drive) addresses one lake, and a row of them per chip is how a compact strip turns into
 * a second manager panel. The per-chip remove is a SCOPE edit, not a lake action, so it belongs.
 *
 * `onRemove` receives one lake id; the host computes the next set. The strip only renders for a
 * scope of two or more, so a remove always leaves at least one lake - it can never silently widen
 * the scope to all lakes, which is what an empty set means.
 *
 * An EMPTY `lakes` is the deliberate no-lake scope, not "nothing to show": the strip is what makes
 * that state visible and escapable, since the tree stays browsable (the user has to be able to
 * reach a lake to get back out) and so says nothing about what retrieval is grounded on.
 */
export default function ActiveLakeScopeStrip({
  lakes,
  onClear,
  onRemove,
}: {
  lakes: ManageableDataLakeConfig[];
  onClear: () => void;
  onRemove?: (lakeId: string) => void;
}) {
  const { copy } = useDataLakeSurface();

  return (
    <Box
      data-testid="datalake-active-scope-strip"
      sx={{ px: '12px', pt: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}
    >
      <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
        Grounded on
      </Typography>
      <Stack direction="row" alignItems="center" gap={0.5} flexWrap="wrap">
        {/* Warning, not neutral: a chat that retrieves from nothing looks identical to one that
            simply found no match, and the colour is the only thing separating them at a glance. */}
        {lakes.length === 0 && (
          <Chip
            size="sm"
            variant="soft"
            color="warning"
            sx={{ fontSize: '11px' }}
            data-testid="datalake-active-scope-none"
          >
            {copy.noLakesLabel}
          </Chip>
        )}
        {lakes.map(lake => {
          const isDraft = isDraftLake(lake);
          return (
            <Tooltip key={lake.id} size="sm" title={isDraft ? DRAFT_LAKE_TOOLTIP : ''}>
              <Chip
                size="sm"
                variant="soft"
                color={isDraft ? 'warning' : 'neutral'}
                sx={{ fontSize: '11px', maxWidth: '100%' }}
                data-testid={`datalake-active-scope-chip-${lake.id}`}
                endDecorator={
                  onRemove && (
                    <ChipDelete
                      onDelete={() => onRemove(lake.id)}
                      aria-label={`Remove ${lake.name} from scope`}
                      data-testid={`datalake-active-scope-remove-${lake.id}`}
                    />
                  )
                }
              >
                {lake.name}
              </Chip>
            </Tooltip>
          );
        })}
        {/* Clears back to every reachable lake. The picker can do this too (its "All data lakes"
            row), but that is two clicks behind a trigger whose label is the thing being
            questioned, and undoing a narrow scope should not require reading the menu again. */}
        <Tooltip size="sm" title="Use all data lakes">
          <Chip
            size="sm"
            variant="plain"
            color="neutral"
            onClick={onClear}
            startDecorator={<CloseIcon sx={{ fontSize: 14 }} />}
            sx={{ fontSize: '11px' }}
            // On the ACTION slot, not the root: a clickable Joy Chip renders its handler on an
            // inner button, and a testid on the surrounding div hands tests an element whose
            // click never reaches it.
            slotProps={{ action: { 'data-testid': 'datalake-active-scope-clear-btn' } }}
          >
            Clear
          </Chip>
        </Tooltip>
      </Stack>
    </Box>
  );
}
