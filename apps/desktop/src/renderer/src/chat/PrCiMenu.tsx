import { useState } from 'react';
import Box from '@mui/joy/Box';
import Divider from '@mui/joy/Divider';
import Dropdown from '@mui/joy/Dropdown';
import IconButton from '@mui/joy/IconButton';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ReactNode } from 'react';
import type { PrBarState } from '@shared/pullRequest';
import { CaretDownIcon, ChevronIcon, ExternalLinkIcon } from './icons';
import { BUCKET_DOT, CI_DOT_COLOR, checkRows, ciDot, mergeLabel, reviewLabel, sortedChecks } from './prBarModel';

function openExternally(url: string): void {
  void window.b4m.shell.openExternal(url);
}

function Dot({ color }: { color: string }) {
  return <Box aria-hidden sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: color, flexShrink: 0 }} />;
}

function CiDotMark({ state }: { state: PrBarState }) {
  const dot = ciDot(state);
  return (
    <Box
      aria-hidden
      data-ci={dot}
      sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: CI_DOT_COLOR[dot], flexShrink: 0 }}
    />
  );
}

const TONE_COLOR = {
  neutral: 'text.secondary',
  success: 'success.plainColor',
  warning: 'warning.plainColor',
  danger: 'danger.plainColor',
} as const;

/**
 * The CI button and its "CI monitoring" popover: check counts, review and merge state, and the
 * expandable list of checks, each linking out. `children` is the automation section below the
 * divider.
 */
export function PrCiMenu({ state, children }: { state: PrBarState; children?: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const snapshot = state.snapshot;
  if (!snapshot) return null;
  const merge = mergeLabel(snapshot);

  return (
    <Dropdown>
      <MenuButton
        size="sm"
        variant="plain"
        color="neutral"
        startDecorator={<CiDotMark state={state} />}
        endDecorator={<CaretDownIcon />}
        sx={{ fontWeight: 'md', minHeight: 26, px: 1, '--Button-gap': '6px' }}
        slotProps={{ root: { 'data-testid': 'pr-bar-ci-btn' } }}
      >
        CI
      </MenuButton>
      <Menu
        size="sm"
        placement="top-end"
        sx={{ minWidth: 300, maxWidth: 420, p: 1.25, gap: 0.75 }}
        data-testid="pr-ci-menu"
      >
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <Typography level="title-sm">CI monitoring</Typography>
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Open checks in browser"
            onClick={() => openExternally(`${snapshot.url}/checks`)}
            data-testid="pr-ci-open-btn"
          >
            <ExternalLinkIcon />
          </IconButton>
        </Stack>

        {snapshot.checks.length === 0 ? (
          <Typography level="body-xs" textColor="text.tertiary">
            No checks reported for the latest commit.
          </Typography>
        ) : (
          <Stack spacing={0.5} data-testid="pr-ci-counts">
            {checkRows(snapshot).map(row => (
              <Stack key={row.bucket} direction="row" alignItems="center" spacing={1}>
                <Dot color={BUCKET_DOT[row.bucket]} />
                <Typography level="body-sm" sx={{ flex: 1 }}>
                  {row.label}
                </Typography>
                <Typography level="body-sm" textColor="text.secondary" data-testid={`pr-ci-count-${row.bucket}`}>
                  {row.count}
                </Typography>
              </Stack>
            ))}
          </Stack>
        )}

        {snapshot.checks.length > 0 && (
          <Box>
            <Box
              component="button"
              type="button"
              onClick={() => setExpanded(open => !open)}
              aria-expanded={expanded}
              data-testid="pr-ci-checks-toggle"
              sx={{
                all: 'unset',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                color: 'text.tertiary',
                '&:hover': { color: 'text.secondary' },
              }}
            >
              <ChevronIcon open={expanded} />
              <Typography level="body-xs" textColor="inherit">
                {expanded ? 'Hide checks' : `Show ${snapshot.checks.length} checks`}
              </Typography>
            </Box>
            {expanded && (
              <Stack
                component="ul"
                spacing={0.25}
                sx={{ m: 0, mt: 0.5, p: 0, listStyle: 'none', maxHeight: 220, overflowY: 'auto' }}
              >
                {sortedChecks(snapshot).map((check, index) => (
                  <Stack
                    component="li"
                    key={`${index}-${check.name}`}
                    direction="row"
                    alignItems="center"
                    spacing={1}
                    data-testid={`pr-ci-check-${check.bucket}`}
                  >
                    <Dot color={BUCKET_DOT[check.bucket]} />
                    <Typography
                      level="body-xs"
                      noWrap
                      component={check.url ? 'button' : 'span'}
                      onClick={check.url ? () => openExternally(check.url!) : undefined}
                      sx={{
                        all: check.url ? 'unset' : undefined,
                        cursor: check.url ? 'pointer' : 'default',
                        minWidth: 0,
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        '&:hover': check.url ? { textDecoration: 'underline' } : undefined,
                      }}
                    >
                      {check.workflow ? `${check.workflow} / ${check.name}` : check.name}
                    </Typography>
                    {check.required && (
                      <Typography level="body-xs" textColor="text.tertiary">
                        required
                      </Typography>
                    )}
                  </Stack>
                ))}
              </Stack>
            )}
          </Box>
        )}

        <Divider />
        <Stack spacing={0.25}>
          <Typography level="body-xs" textColor="text.secondary" data-testid="pr-ci-review">
            {`Review: ${reviewLabel(snapshot)}`}
          </Typography>
          <Typography level="body-xs" textColor={TONE_COLOR[merge.tone]} data-testid="pr-ci-merge">
            {merge.text}
          </Typography>
        </Stack>

        {children && (
          <>
            <Divider />
            {children}
          </>
        )}
      </Menu>
    </Dropdown>
  );
}
