import { useState } from 'react';
import Box from '@mui/joy/Box';
import Chip from '@mui/joy/Chip';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import { useTheme } from '@mui/joy/styles';
import type { PrActionResult, PrBarState, PrOption } from '@shared/pullRequest';
import { CloseIcon, ExternalLinkIcon, MergedIcon, PullRequestClosedIcon, PullRequestIcon, ReloadIcon } from './icons';
import { contentColumnSx } from './layout';
import { MERGED_COLOR, ghFixLine, lifecycleLabel, middleTruncate, timeAgo } from './prBarModel';
import { PrAutomations, autoFixDescription, autoMergeDescription } from './PrAutomations';
import { PrCiMenu } from './PrCiMenu';

const BRANCH_MAX_CHARS = 44;

function openExternally(url: string): void {
  void window.b4m.shell.openExternal(url);
}

/** The +adds -dels pair, green and red like a diff gutter; grey once the PR is finished. */
function DiffChip({ additions, deletions, muted }: { additions: number; deletions: number; muted: boolean }) {
  return (
    <Typography level="body-xs" sx={{ fontFamily: 'code', whiteSpace: 'nowrap' }} data-testid="pr-bar-diff">
      <Box component="span" sx={{ color: muted ? 'text.tertiary' : 'success.plainColor' }}>{`+${additions}`}</Box>{' '}
      <Box component="span" sx={{ color: muted ? 'text.tertiary' : 'danger.plainColor' }}>{`-${deletions}`}</Box>
    </Typography>
  );
}

/**
 * A slim bar above the composer for a conversation that has a pull request.
 *
 * Every string from GitHub - the title, the branch, check names - is drawn as React text, which
 * escapes it; nothing here takes markup from it.
 */
export function PrStatusBar({
  state,
  onDismiss,
  onRefresh,
  onSetOption,
}: {
  state: PrBarState | null;
  onDismiss: () => Promise<PrActionResult>;
  onRefresh: () => void;
  onSetOption: (option: PrOption, enabled: boolean) => Promise<PrActionResult>;
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
  const mergedColor = MERGED_COLOR[theme.palette.mode === 'dark' ? 'dark' : 'light'];
  const mergedAgo = merged && snapshot.mergedAt ? timeAgo(snapshot.mergedAt, Date.now()) : null;

  return (
    <Box sx={{ ...contentColumnSx, pt: 1 }} data-testid="pr-bar" data-state={snapshot?.state}>
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{
          minHeight: 32,
          px: 1.25,
          border: '1px solid',
          borderColor: merged ? `color-mix(in srgb, ${mergedColor} 40%, transparent)` : 'neutral.outlinedBorder',
          borderRadius: 'md',
          bgcolor: merged
            ? `color-mix(in srgb, ${mergedColor} 6%, ${theme.vars.palette.background.surface})`
            : closed
              ? 'background.level1'
              : 'background.surface',
          minWidth: 0,
        }}
      >
        {merged ? (
          <Box sx={{ display: 'flex', color: mergedColor, flexShrink: 0 }} data-testid="pr-bar-merged-icon">
            <MergedIcon />
          </Box>
        ) : closed ? (
          <Box
            sx={{ display: 'flex', color: 'danger.plainColor', opacity: 0.7, flexShrink: 0 }}
            data-testid="pr-bar-closed-icon"
          >
            <PullRequestClosedIcon />
          </Box>
        ) : (
          <Box sx={{ display: 'flex', color: 'text.tertiary', flexShrink: 0 }}>
            <PullRequestIcon />
          </Box>
        )}

        <Tooltip title={snapshot?.title || binding.url} size="sm" variant="soft" placement="top-start">
          <Typography
            level="body-sm"
            component="button"
            type="button"
            onClick={() => openExternally(binding.url)}
            sx={{
              all: 'unset',
              cursor: 'pointer',
              fontWeight: 'lg',
              whiteSpace: 'nowrap',
              '&:hover': { textDecoration: 'underline' },
            }}
            data-testid="pr-bar-number-btn"
          >
            {`#${binding.number}`}
          </Typography>
        </Tooltip>

        <Typography level="body-xs" textColor="text.secondary" noWrap sx={{ flexShrink: 0 }}>
          {binding.repo}
        </Typography>

        {fix ? (
          <Typography level="body-xs" textColor="warning.plainColor" sx={{ minWidth: 0 }} data-testid="pr-bar-gh-fix">
            {fix}
          </Typography>
        ) : (
          <>
            {snapshot && (
              <Tooltip title={snapshot.headRefName} size="sm" variant="soft" placement="top">
                <Typography
                  level="body-xs"
                  textColor="text.tertiary"
                  noWrap
                  sx={{ fontFamily: 'code', minWidth: 0, opacity: finished ? 0.7 : 1 }}
                  data-testid="pr-bar-branch"
                >
                  {middleTruncate(snapshot.headRefName, BRANCH_MAX_CHARS)}
                </Typography>
              </Tooltip>
            )}
            {snapshot && <DiffChip additions={snapshot.additions} deletions={snapshot.deletions} muted={finished} />}
            {lifecycle && (
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
            {mergedAgo && snapshot?.mergedAt && (
              <Tooltip title={new Date(snapshot.mergedAt).toLocaleString()} size="sm" variant="soft" placement="top">
                <Typography level="body-xs" textColor="text.tertiary" noWrap data-testid="pr-bar-merged-at">
                  {`merged ${mergedAgo}`}
                </Typography>
              </Tooltip>
            )}
            {!snapshot && !state.error && (
              <Typography level="body-xs" textColor="text.tertiary">
                {'Reading...'}
              </Typography>
            )}
            {state.error && !fix && (
              <Tooltip title={state.error} size="sm" variant="soft" placement="top">
                <Typography
                  level="body-xs"
                  textColor="danger.plainColor"
                  noWrap
                  sx={{ minWidth: 0 }}
                  data-testid="pr-bar-error"
                >
                  {state.error}
                </Typography>
              </Tooltip>
            )}
          </>
        )}

        <Box sx={{ flex: 1 }} />

        {snapshot?.mergeable === 'CONFLICTING' && snapshot.state === 'OPEN' && (
          <Chip size="sm" variant="soft" color="danger" data-testid="pr-bar-conflicts">
            Conflicts
          </Chip>
        )}

        {binding.autoFix && snapshot?.state === 'OPEN' && (
          <Tooltip title={autoFixDescription(state)} size="sm" variant="soft" placement="top">
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

        {binding.autoMerge && snapshot?.state === 'OPEN' && (
          <Tooltip title={autoMergeDescription(state)} size="sm" variant="soft" placement="top">
            <Chip size="sm" variant="soft" color="primary" data-testid="pr-bar-automerge-armed">
              Auto-merge
            </Chip>
          </Tooltip>
        )}

        {snapshot && !fix && snapshot.state === 'OPEN' && (
          <PrCiMenu state={state}>
            <PrAutomations state={state} onSetOption={onSetOption} />
          </PrCiMenu>
        )}

        {/* A merged PR cannot change again. A closed one can be reopened, but only a manual refresh will notice. */}
        {!merged && (
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

        <Tooltip title="Open in browser" size="sm" variant="soft">
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => openExternally(binding.url)}
            aria-label="Open pull request in browser"
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
            aria-label="Hide pull request bar"
            data-testid="pr-bar-dismiss-btn"
          >
            <CloseIcon />
          </IconButton>
        </Tooltip>
      </Stack>
      {actionError && (
        <Typography
          level="body-xs"
          textColor="danger.plainColor"
          sx={{ pt: 0.5, cursor: 'pointer' }}
          onClick={() => setActionError(null)}
          data-testid="pr-bar-action-error"
        >
          {actionError}
        </Typography>
      )}
    </Box>
  );
}
