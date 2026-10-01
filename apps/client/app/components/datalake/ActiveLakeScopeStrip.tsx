import { Box, Chip, Stack, Tooltip, Typography } from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import type { ManageableDataLakeConfig } from '@bike4mind/common';
import { isUnsearchable, UnsearchableLakeIcon, type SessionAdmissionView } from './lakeRetrievability';
import { useDataLakeSurface } from './surfaceTokens';

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
 * a second manager panel.
 *
 * An EMPTY `lakes` is the deliberate no-lake scope, not "nothing to show": the strip is what makes
 * that state visible and escapable, since the tree stays browsable (the user has to be able to
 * reach a lake to get back out) and so says nothing about what retrieval is grounded on.
 */
export default function ActiveLakeScopeStrip({
  lakes,
  onClear,
  session,
  viewerUserId,
}: {
  lakes: ManageableDataLakeConfig[];
  onClear: () => void;
  session?: SessionAdmissionView | null;
  viewerUserId?: string;
}) {
  const { copy } = useDataLakeSurface();
  // A lake chat cannot search is selected but grounds nothing, so it gets its own group rather than
  // a chip under "Grounded on".
  const groundedLakes = lakes.filter(lake => !isUnsearchable(lake, session, viewerUserId));
  const unsearchableLakes = lakes.filter(lake => isUnsearchable(lake, session, viewerUserId));
  const showGrounded = lakes.length === 0 || groundedLakes.length > 0;
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

  return (
    <Box
      data-testid="datalake-active-scope-strip"
      sx={{ px: '12px', pt: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}
    >
      {showGrounded && (
        <>
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
            Grounded on
          </Typography>
          <Stack
            direction="row"
            alignItems="center"
            gap={0.5}
            flexWrap="wrap"
            data-testid="datalake-active-scope-grounded"
          >
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
            {groundedLakes.map(lake => (
              <Chip
                key={lake.id}
                size="sm"
                variant="soft"
                color="neutral"
                sx={{ fontSize: '11px', maxWidth: '100%' }}
                data-testid={`datalake-active-scope-chip-${lake.id}`}
              >
                {lake.name}
              </Chip>
            ))}
            {unsearchableLakes.length === 0 && clearChip}
          </Stack>
        </>
      )}
      {unsearchableLakes.length > 0 && (
        <>
          <Typography
            level="body-xs"
            sx={{ color: 'warning.400' }}
            data-testid={allUnsearchable ? 'datalake-active-scope-all-unsearchable' : undefined}
          >
            {allUnsearchable ? 'Chat can not search any selected lake' : 'Not searched'}
          </Typography>
          <Stack
            direction="row"
            alignItems="center"
            gap={0.5}
            flexWrap="wrap"
            data-testid="datalake-active-scope-unsearchable-group"
          >
            {unsearchableLakes.map(lake => (
              <Chip
                key={lake.id}
                size="sm"
                variant="soft"
                color="warning"
                startDecorator={<UnsearchableLakeIcon testId={`datalake-active-scope-unsearchable-${lake.id}`} />}
                sx={{ fontSize: '11px', maxWidth: '100%' }}
                data-testid={`datalake-active-scope-chip-${lake.id}`}
              >
                {lake.name}
              </Chip>
            ))}
            {clearChip}
          </Stack>
        </>
      )}
    </Box>
  );
}
