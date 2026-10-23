import { useState } from 'react';
import Box from '@mui/joy/Box';
import Chip from '@mui/joy/Chip';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import { useTheme } from '@mui/joy/styles';
import { prDisplayState, type PrActionResult, type PrBarState, type PrOption } from '@shared/pullRequest';
import { DiffCount } from './DiffCount';
import { CloseIcon, ExternalLinkIcon, PullRequestIcon, ReloadIcon } from './icons';
import { ghFixLine, lifecycleLabel, middleTruncate, timeAgo } from './prBarModel';
import { PrAutomations, autoFixDescription, autoMergeDescription } from './PrAutomations';
import { PrCiMenu } from './PrCiMenu';
import { PrStateIcon, prStateColor } from './prStateStyle';
import { SYSTEM_BROWSER_HINT, openInSystemBrowser, routePrLink, type BuiltInBrowserOpener } from './prLinks';

const BRANCH_MAX_CHARS = 36;

function StateIcon({ state }: { state: PrBarState }) {
  const snapshot = state.snapshot;
  if (!snapshot) {
    return (
      <Box sx={{ display: 'flex', color: 'text.tertiary', flexShrink: 0 }} data-testid="pr-bar-reading-icon">
        <PullRequestIcon />
      </Box>
    );
  }
  const display = prDisplayState(snapshot.state, snapshot.isDraft, !!state.autoMerge.queued);
  return <PrStateIcon state={display} testId={`pr-bar-${display}-icon`} />;
}

/**
 * State, number and diff on one line: what the session panel's collapsed Pull request header
 * says, so the figures are still on screen with the section shut.
 */
export function PrHeadline({ state }: { state: PrBarState }) {
  const binding = state.binding;
  if (!binding) return null;
  const snapshot = state.snapshot;
  return (
    <Stack direction="row" alignItems="center" spacing={0.75} sx={{ minWidth: 0 }} data-testid="pr-bar-headline">
      <StateIcon state={state} />
      <Typography level="body-xs" fontWeight="lg" noWrap>{`#${binding.number}`}</Typography>
      {snapshot && (
        <DiffCount
          added={snapshot.additions}
          removed={snapshot.deletions}
          muted={snapshot.state !== 'OPEN'}
          testId="pr-bar-headline-diff"
        />
      )}
    </Stack>
  );
}

/**
 * The session panel's Pull request section, for a conversation that has one.
 *
 * Every string from GitHub - the title, the branch, check names - is drawn as React text, which
 * escapes it; nothing here takes markup from it.
 */
export function PrStatusBar({
  state,
  onDismiss,
  onRefresh,
  onSetOption,
  onOpenLink,
}: {
  state: PrBarState | null;
  onDismiss: () => Promise<PrActionResult>;
  onRefresh: () => void;
  onSetOption: (option: PrOption, enabled: boolean) => Promise<PrActionResult>;
  /** Opens a link in this conversation's built-in browser; without it, links go to the system browser. */
  onOpenLink?: BuiltInBrowserOpener;
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  const theme = useTheme();
  const binding = state?.binding;
  if (!state || !binding) return null;
  const snapshot = state.snapshot;
  const fix = ghFixLine(state.gh);
  const lifecycle = lifecycleLabel(state);
  const merged = snapshot?.state === 'MERGED';
  const closed = snapshot?.state === 'CLOSED';
  const finished = merged || closed;
  const open = snapshot?.state === 'OPEN';
  const mergedColor = prStateColor('merged', theme.palette.mode === 'dark' ? 'dark' : 'light');
  const mergedAgo = merged && snapshot.mergedAt ? timeAgo(snapshot.mergedAt, Date.now()) : null;

  return (
    <Stack spacing={0.75} sx={{ minWidth: 0 }} data-testid="pr-bar" data-state={snapshot?.state}>
      <Stack direction="row" alignItems="center" spacing={0.75} sx={{ minWidth: 0 }}>
        <StateIcon state={state} />

        <Tooltip title={snapshot?.title || binding.url} size="sm" variant="soft" placement="left">
          <Typography
            level="body-sm"
            component="button"
            type="button"
            onClick={() => openInSystemBrowser(binding.url)}
            sx={{
              all: 'unset',
              cursor: 'pointer',
              fontWeight: 'lg',
              whiteSpace: 'nowrap',
              '&:hover': { textDecoration: 'underline' },
              '&:focus-visible': { outline: '2px solid var(--joy-palette-focusVisible)', borderRadius: '2px' },
            }}
            data-testid="pr-bar-number-btn"
          >
            {`#${binding.number}`}
          </Typography>
        </Tooltip>

        <Typography level="body-xs" textColor="text.secondary" noWrap sx={{ flex: 1, minWidth: 0 }}>
          {binding.repo}
        </Typography>

        {/* A merged PR cannot change again; a closed one can be reopened, and only this notices. The
          fix line's "then refresh" needs the button whatever the PR's state. */}
        {(!merged || fix) && (
          <Tooltip title="Refresh" size="sm" variant="soft">
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              loading={state.refreshing}
              onClick={onRefresh}
              aria-label="Refresh pull request"
              data-testid="pr-bar-refresh-btn"
            >
              <ReloadIcon />
            </IconButton>
          </Tooltip>
        )}

        <Tooltip title={`Open in built-in browser. ${SYSTEM_BROWSER_HINT}.`} size="sm" variant="soft">
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            onClick={event => routePrLink(binding.url, event, onOpenLink)}
            aria-label="Open pull request in built-in browser"
            data-testid="pr-bar-open-btn"
          >
            <ExternalLinkIcon />
          </IconButton>
        </Tooltip>

        <Tooltip title="Hide for this conversation" size="sm" variant="soft">
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => void onDismiss().then(result => setActionError(result.ok ? null : result.error))}
            aria-label="Hide pull request"
            data-testid="pr-bar-dismiss-btn"
          >
            <CloseIcon />
          </IconButton>
        </Tooltip>
      </Stack>

      {fix ? (
        <Typography level="body-xs" textColor="warning.plainColor" data-testid="pr-bar-gh-fix">
          {fix}
        </Typography>
      ) : (
        <>
          {snapshot && (
            <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0 }}>
              <Tooltip title={snapshot.headRefName} size="sm" variant="soft" placement="left">
                <Typography
                  level="body-xs"
                  textColor="text.tertiary"
                  noWrap
                  sx={{ fontFamily: 'code', flex: 1, minWidth: 0, opacity: finished ? 0.7 : 1 }}
                  data-testid="pr-bar-branch"
                >
                  {middleTruncate(snapshot.headRefName, BRANCH_MAX_CHARS)}
                </Typography>
              </Tooltip>
              <DiffCount
                added={snapshot.additions}
                removed={snapshot.deletions}
                muted={finished}
                testId="pr-bar-diff"
              />
            </Stack>
          )}
          {!snapshot && !state.error && (
            <Typography level="body-xs" textColor="text.tertiary">
              {'Reading...'}
            </Typography>
          )}
          {state.error && (
            <Tooltip title={state.error} size="sm" variant="soft" placement="left">
              <Typography level="body-xs" textColor="danger.plainColor" noWrap data-testid="pr-bar-error">
                {state.error}
              </Typography>
            </Tooltip>
          )}
        </>
      )}

      <Stack
        direction="row"
        alignItems="center"
        sx={{ flexWrap: 'wrap', gap: 0.75, minWidth: 0, '&:empty': { display: 'none' } }}
      >
        {!fix && lifecycle && (
          <Chip
            size="sm"
            variant={closed ? 'outlined' : 'soft'}
            color="neutral"
            sx={
              merged
                ? { color: mergedColor, bgcolor: `color-mix(in srgb, ${mergedColor} 14%, transparent)` }
                : closed
                  ? { color: 'text.tertiary' }
                  : undefined
            }
            data-testid="pr-bar-lifecycle"
            data-state={snapshot?.state}
          >
            {lifecycle}
          </Chip>
        )}
        {!fix && mergedAgo && snapshot?.mergedAt && (
          <Tooltip title={new Date(snapshot.mergedAt).toLocaleString()} size="sm" variant="soft" placement="left">
            <Typography level="body-xs" textColor="text.tertiary" noWrap data-testid="pr-bar-merged-at">
              {`merged ${mergedAgo}`}
            </Typography>
          </Tooltip>
        )}

        {snapshot && !fix && open && (
          <PrCiMenu state={state} onOpenLink={onOpenLink}>
            <PrAutomations state={state} onSetOption={onSetOption} />
          </PrCiMenu>
        )}

        {snapshot?.mergeable === 'CONFLICTING' && open && (
          <Chip size="sm" variant="soft" color="danger" data-testid="pr-bar-conflicts">
            {state.autoFix.status === 'started' && state.autoFix.conflicts ? 'Fixing conflicts...' : 'Conflicts'}
          </Chip>
        )}

        {binding.autoFix && open && (
          <Tooltip title={autoFixDescription(state)} size="sm" variant="soft" placement="left">
            <Chip
              size="sm"
              variant="soft"
              color={state.autoFix.status === 'exhausted' ? 'warning' : 'neutral'}
              data-testid="pr-bar-autofix-status"
              data-status={state.autoFix.status}
            >
              {state.autoFix.status === 'exhausted'
                ? 'Auto-fix gave up'
                : `Auto-fix ${state.autoFix.attempts}/${state.autoFix.max}`}
            </Chip>
          </Tooltip>
        )}

        {(binding.autoMerge || state.autoMerge.queued) && open && (
          <Tooltip title={autoMergeDescription(state)} size="sm" variant="soft" placement="left">
            <Chip
              size="sm"
              variant="soft"
              color={state.autoMerge.queued ? 'warning' : 'primary'}
              data-testid="pr-bar-automerge-armed"
              data-queued={state.autoMerge.queued ? 'true' : undefined}
            >
              {state.autoMerge.queued ? 'Queued to merge' : 'Auto-merge'}
            </Chip>
          </Tooltip>
        )}

        {!binding.autoMerge && state.autoMerge.error && open && (
          <Tooltip title={state.autoMerge.error} size="sm" variant="soft" placement="left">
            <Chip size="sm" variant="soft" color="danger" data-testid="pr-bar-automerge-stopped">
              Auto-merge stopped
            </Chip>
          </Tooltip>
        )}
      </Stack>

      {actionError && (
        <Typography
          level="body-xs"
          textColor="danger.plainColor"
          sx={{ cursor: 'pointer' }}
          onClick={() => setActionError(null)}
          data-testid="pr-bar-action-error"
        >
          {actionError}
        </Typography>
      )}
    </Stack>
  );
}
