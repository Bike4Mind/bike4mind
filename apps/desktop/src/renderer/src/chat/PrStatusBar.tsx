import { useState } from 'react';
import Box from '@mui/joy/Box';
import Chip from '@mui/joy/Chip';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import type { PrActionResult, PrBarState, PrOption } from '@shared/pullRequest';
import { CloseIcon, ExternalLinkIcon, PullRequestIcon, ReloadIcon } from './icons';
import { contentColumnSx } from './layout';
import { ghFixLine, lifecycleLabel, middleTruncate } from './prBarModel';
import { PrAutomations, autoMergeDescription } from './PrAutomations';
import { PrCiMenu } from './PrCiMenu';

const BRANCH_MAX_CHARS = 44;

function openExternally(url: string): void {
  void window.b4m.shell.openExternal(url);
}

/** The +adds -dels pair, green and red like a diff gutter. */
function DiffChip({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <Typography level="body-xs" sx={{ fontFamily: 'code', whiteSpace: 'nowrap' }} data-testid="pr-bar-diff">
      <Box component="span" sx={{ color: 'success.plainColor' }}>{`+${additions}`}</Box>{' '}
      <Box component="span" sx={{ color: 'danger.plainColor' }}>{`-${deletions}`}</Box>
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
  const binding = state?.binding;
  if (!state || !binding) return null;
  const snapshot = state.snapshot;
  const fix = ghFixLine(state.gh);
  const lifecycle = lifecycleLabel(state);

  return (
    <Box sx={{ ...contentColumnSx, pt: 1 }} data-testid="pr-bar">
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{
          minHeight: 32,
          px: 1.25,
          border: '1px solid',
          borderColor: 'neutral.outlinedBorder',
          borderRadius: 'md',
          bgcolor: 'background.surface',
          minWidth: 0,
        }}
      >
        <Box sx={{ display: 'flex', color: 'text.tertiary', flexShrink: 0 }}>
          <PullRequestIcon />
        </Box>

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
                  sx={{ fontFamily: 'code', minWidth: 0 }}
                  data-testid="pr-bar-branch"
                >
                  {middleTruncate(snapshot.headRefName, BRANCH_MAX_CHARS)}
                </Typography>
              </Tooltip>
            )}
            {snapshot && <DiffChip additions={snapshot.additions} deletions={snapshot.deletions} />}
            {lifecycle && (
              <Chip
                size="sm"
                variant="soft"
                color={lifecycle === 'Merged' ? 'primary' : 'neutral'}
                data-testid="pr-bar-lifecycle"
              >
                {lifecycle}
              </Chip>
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
