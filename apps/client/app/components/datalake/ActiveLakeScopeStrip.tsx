import { Fragment, type ReactNode } from 'react';
import { Box, Chip, ChipDelete, Stack, Tooltip, Typography } from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import AddIcon from '@mui/icons-material/Add';
import CheckIcon from '@mui/icons-material/Check';
import type { RetrievabilityLabeledDataLake } from '@bike4mind/common';
import { isUnsearchable, UnsearchableLakeIcon } from './lakeRetrievability';
import { useDataLakeSurface } from './surfaceTokens';
import { isDraftLake, DRAFT_LAKE_TOOLTIP } from './lakeVisibility';

/**
 * Names everything the chat is currently grounded on: every scoped lake, which the picker trigger
 * can only report as a number (#3042), and whether the caller's own and shared files ("My files")
 * are searched alongside them. A user who cannot see the set without reopening the menu cannot tell
 * a deliberate scope from a stale one.
 *
 * Renders for every scope - one lake, several, all lakes (`allLakes`) and none. For a single lake
 * SelectedLakeHeader sits below it with that lake's ACTIONS only; the strip carries none, since
 * every one of them addresses one lake and a row per chip would turn it into a second manager
 * panel. The per-chip remove and the My files chip are SCOPE edits, so they belong.
 *
 * `onRemove` receives one lake id; the host computes the next set. Remove is offered only while two
 * or more lakes are scoped, so it can never silently widen the scope to all lakes, which is what an
 * empty set means. `library` is omitted until a session exists, since there is nothing to write to.
 *
 * An EMPTY `lakes` is the deliberate no-lake scope, not "nothing to show": the strip is what makes
 * that state visible and escapable, since the tree stays browsable (the user has to be able to
 * reach a lake to get back out) and so says nothing about what retrieval is grounded on.
 */
export default function ActiveLakeScopeStrip({
  lakes,
  allLakes = false,
  onClear,
  onRemove,
  library,
}: {
  lakes: RetrievabilityLabeledDataLake[];
  allLakes?: boolean;
  onClear: () => void;
  onRemove?: (lakeId: string) => void;
  library?: { included: boolean; pending: boolean; onToggle: () => void };
}) {
  const { copy } = useDataLakeSurface();
  // A lake chat cannot search is selected but grounds nothing, so it gets its own group rather than
  // a chip under "Grounded on".
  const groundedLakes: typeof lakes = [];
  const unsearchableLakes: typeof lakes = [];
  for (const lake of lakes) {
    (isUnsearchable(lake) ? unsearchableLakes : groundedLakes).push(lake);
  }
  const showGrounded = allLakes || lakes.length === 0 || groundedLakes.length > 0;
  const allUnsearchable = !showGrounded;

  // Clears back to every reachable lake. The picker can do this too (its "All data lakes" row), but
  // that is two clicks behind a trigger whose label is the thing being questioned, and undoing a
  // narrow scope should not require reading the menu again.
  const clearChip = (
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
  );

  const removeDecorator = (lake: RetrievabilityLabeledDataLake) =>
    onRemove &&
    lakes.length > 1 && (
      <ChipDelete
        onDelete={() => onRemove(lake.id)}
        aria-label={`Remove ${lake.name} from scope`}
        data-testid={`datalake-active-scope-remove-${lake.id}`}
      />
    );

  const groups: { key: string; heading: ReactNode; testId: string; chips: ReactNode }[] = [];
  if (showGrounded) {
    groups.push({
      key: 'grounded',
      heading: (
        <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
          Grounded on
        </Typography>
      ),
      testId: 'datalake-active-scope-grounded',
      chips: (
        <>
          {/* Warning, not neutral: a chat that retrieves from nothing looks identical to one that
              simply found no match, and the colour is the only thing separating them at a glance. */}
          {allLakes && (
            <Chip
              size="sm"
              variant="soft"
              color="neutral"
              sx={{ fontSize: '11px' }}
              data-testid="datalake-active-scope-all"
            >
              {copy.allLakesLabel}
            </Chip>
          )}
          {!allLakes && lakes.length === 0 && (
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
          {groundedLakes.map(lake => {
            const isDraft = isDraftLake(lake);
            return (
              <Tooltip key={lake.id} size="sm" title={isDraft ? DRAFT_LAKE_TOOLTIP : ''}>
                <Chip
                  size="sm"
                  variant="soft"
                  color={isDraft ? 'warning' : 'neutral'}
                  sx={{ fontSize: '11px', maxWidth: '100%' }}
                  data-testid={`datalake-active-scope-chip-${lake.id}`}
                  endDecorator={removeDecorator(lake)}
                >
                  {lake.name}
                </Chip>
              </Tooltip>
            );
          })}
        </>
      ),
    });
  }
  if (unsearchableLakes.length > 0) {
    groups.push({
      key: 'unsearchable',
      heading: (
        <Typography
          level="body-xs"
          sx={{ color: 'warning.400' }}
          data-testid={allUnsearchable ? 'datalake-active-scope-all-unsearchable' : undefined}
        >
          {allUnsearchable ? 'Chat cannot search any selected lake' : 'Not searched'}
        </Typography>
      ),
      testId: 'datalake-active-scope-unsearchable-group',
      chips: unsearchableLakes.map(lake => (
        <Chip
          key={lake.id}
          size="sm"
          variant="soft"
          color="warning"
          startDecorator={<UnsearchableLakeIcon lake={lake} testId={`datalake-active-scope-unsearchable-${lake.id}`} />}
          slotProps={{ startDecorator: { sx: { pointerEvents: 'auto' } } }}
          sx={{ fontSize: '11px', maxWidth: '100%' }}
          data-testid={`datalake-active-scope-chip-${lake.id}`}
          endDecorator={removeDecorator(lake)}
        >
          {lake.name}
        </Chip>
      )),
    });
  }

  const libraryChip = library && (
    <Tooltip
      size="sm"
      title={library.included ? 'Stop searching your own and shared files' : 'Also search your own and shared files'}
    >
      <Chip
        size="sm"
        variant={library.included ? 'solid' : 'soft'}
        color="primary"
        disabled={library.pending}
        onClick={library.onToggle}
        startDecorator={library.included ? <CheckIcon sx={{ fontSize: 14 }} /> : <AddIcon sx={{ fontSize: 14 }} />}
        sx={{ fontSize: '11px' }}
        slotProps={{
          action: { 'data-testid': 'datalake-active-scope-myfiles-chip', 'aria-pressed': library.included },
        }}
      >
        My files
      </Chip>
    </Tooltip>
  );

  return (
    <Box
      data-testid="datalake-active-scope-strip"
      sx={{ px: '12px', pt: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}
    >
      {/* My files and the clear chip trail whichever group renders last. */}
      {groups.map((group, i) => (
        <Fragment key={group.key}>
          {group.heading}
          <Stack direction="row" alignItems="center" gap={0.5} flexWrap="wrap" data-testid={group.testId}>
            {group.chips}
            {i === groups.length - 1 && libraryChip}
            {i === groups.length - 1 && !allLakes && clearChip}
          </Stack>
        </Fragment>
      ))}
    </Box>
  );
}
