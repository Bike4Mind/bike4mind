import { useState } from 'react';
import Alert from '@mui/joy/Alert';
import Avatar from '@mui/joy/Avatar';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import CircularProgress from '@mui/joy/CircularProgress';
import IconButton from '@mui/joy/IconButton';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { AccountProfile } from '@shared/account';
import type { AuthState } from '@shared/auth';
import type { AccountUsage, UsageWindowId } from '@shared/usage';
import { ArrowLeftIcon, ReloadIcon } from '../chat/icons';
import { columnStackSx, contentColumnSx, scrollingColumnHostSx } from '../chat/layout';
import { UsageBarChart } from './UsageBarChart';
import { UsageBreakdown } from './UsageBreakdown';
import { useAccountProfile } from './useAccountProfile';
import { useAccountUsage } from './useAccountUsage';
import {
  WINDOW_DAYS,
  WINDOW_LABELS,
  formatCount,
  formatCredits,
  formatPeriodEnd,
  formatReadAt,
  runwayDays,
} from './usageView';

const WINDOWS: UsageWindowId[] = ['last-24-hours', 'last-30-days'];

function Stat({ label, value, caption }: { label: string; value: string; caption?: string }) {
  return (
    <Stack sx={{ flex: 1, minWidth: 110 }}>
      <Typography level="body-xs" textColor="text.tertiary" noWrap>
        {label}
      </Typography>
      <Typography level="title-md" noWrap>
        {value}
      </Typography>
      {caption && (
        <Typography level="body-xs" textColor="text.tertiary" noWrap>
          {caption}
        </Typography>
      )}
    </Stack>
  );
}

/** Two letters for the avatar. Falls back to one, then to nothing, rather than to a stray '?'. */
function initials(name: string): string {
  const parts = name.split(/[\s._@-]+/).filter(Boolean);
  if (parts.length === 0) return '';
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2);
  return letters.toUpperCase();
}

/**
 * What the account holds and what it is on.
 *
 * The plan row distinguishes the two ways a plan can be absent: no subscription at all, and a
 * subscription on a price this deployment can no longer name. Collapsing them would tell a
 * paying customer they are on the free plan.
 */
function AccountSummary({
  state,
  profile,
  usage,
  windowId,
}: {
  state: AuthState;
  profile: AccountProfile | null;
  usage: AccountUsage | null;
  windowId: UsageWindowId;
}) {
  const user = state.user;
  const displayName = user?.nickname || user?.username || user?.email || user?.id || 'Signed in';
  const balance = profile?.credits.balance ?? null;
  const runway = usage ? runwayDays(balance, usage.creditsSpent, WINDOW_DAYS[windowId]) : null;

  const planValue = profile?.plan
    ? profile.plan.name
    : profile?.tier === 'free'
      ? 'Free'
      : profile?.tier
        ? 'Subscribed'
        : '-';
  const planCaption = profile?.plan
    ? `${profile.plan.interval}, renews ${formatPeriodEnd(profile.plan.currentPeriodEndsAt)}`
    : profile?.tier === 'other'
      ? 'This server did not name the plan'
      : undefined;

  return (
    <Sheet variant="outlined" sx={{ borderRadius: 'sm', px: 2, py: 1.75, mb: 1.5 }} data-testid="profile-account-card">
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.75 }}>
        <Avatar size="lg" variant="soft" color="primary" src={user?.photoUrl} alt="">
          {initials(displayName)}
        </Avatar>
        <Stack sx={{ minWidth: 0 }}>
          <Typography level="title-md" noWrap data-testid="profile-account-name">
            {displayName}
          </Typography>
          <Typography level="body-xs" textColor="text.tertiary" noWrap>
            {state.environment.label}
          </Typography>
        </Stack>
      </Stack>

      <Stack direction="row" spacing={2} useFlexGap flexWrap="wrap">
        <Stat
          label="Balance"
          value={balance === null ? '-' : formatCredits(balance)}
          caption={profile?.credits.error ?? 'credits'}
        />
        <Stat
          label={`Spent, ${WINDOW_LABELS[windowId].toLowerCase()}`}
          value={usage ? formatCredits(usage.creditsSpent) : '-'}
          caption={usage ? `${formatCount(usage.requests)} requests` : undefined}
        />
        <Stat
          label="At this rate"
          value={runway === null ? '-' : `${formatCount(runway)} days`}
          caption={runway === null ? 'nothing spent in this window' : 'until the balance runs out'}
        />
        <Stat label="Plan" value={planValue} caption={planCaption} />
      </Stack>
    </Sheet>
  );
}

/**
 * The profile screen: where the credits went, and how fast.
 *
 * Built around the burn rate rather than the balance. A single balance figure is what the app
 * had, and it is no warning at all - it falls silently, and the first thing a user learns from
 * it is that it reached zero. The charts and the breakdowns are the warning: how much is going,
 * and what is taking it.
 *
 * Every figure is in CREDITS, which is what the balance is denominated in. The usage API also
 * reports provider cost in USD; showing that beside a credit balance would state a number the
 * user was never charged.
 */
export function ProfileScreen({ state, onClose }: { state: AuthState; onClose: () => void }) {
  const [windowId, setWindowId] = useState<UsageWindowId>('last-24-hours');
  const [reload, setReload] = useState(0);
  const { result, refresh } = useAccountUsage(windowId);
  const profile = useAccountProfile(reload);

  const usage = result?.ok ? result.usage : null;

  const refreshAll = () => {
    refresh();
    setReload(current => current + 1);
  };

  return (
    <Stack sx={{ height: '100vh', bgcolor: 'background.body', ...columnStackSx }} data-testid="profile-screen">
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ ...contentColumnSx, py: 1.25 }}>
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Back to conversations"
            onClick={onClose}
            data-testid="profile-close-btn"
          >
            <ArrowLeftIcon />
          </IconButton>
          <Typography level="title-sm" sx={{ flex: 1 }}>
            Profile
          </Typography>
          {usage && (
            <Typography level="body-xs" textColor="text.tertiary" data-testid="profile-read-at">
              as of {formatReadAt(usage.readAt)}
            </Typography>
          )}
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Refresh usage"
            onClick={refreshAll}
            data-testid="profile-refresh-btn"
          >
            <ReloadIcon />
          </IconButton>
        </Stack>
      </Box>

      <Box sx={{ flex: 1, ...scrollingColumnHostSx }}>
        <Box sx={{ ...contentColumnSx, py: 2 }}>
          <AccountSummary state={state} profile={profile} usage={usage} windowId={windowId} />

          <Stack direction="row" spacing={1} sx={{ mb: 1.5 }} data-testid="profile-window-group">
            {WINDOWS.map(id => (
              <Button
                key={id}
                size="sm"
                variant={id === windowId ? 'solid' : 'soft'}
                color="neutral"
                onClick={() => setWindowId(id)}
                data-testid="profile-window-btn"
                data-window={id}
                aria-pressed={id === windowId}
              >
                {WINDOW_LABELS[id]}
              </Button>
            ))}
          </Stack>

          {result === null ? (
            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ py: 4 }} data-testid="profile-usage-loading">
              <CircularProgress size="sm" />
              <Typography level="body-sm" textColor="text.tertiary">
                Reading your usage...
              </Typography>
            </Stack>
          ) : !result.ok ? (
            <Alert
              color="warning"
              variant="soft"
              size="sm"
              data-testid="profile-usage-error"
              endDecorator={
                <Button size="sm" variant="soft" color="warning" onClick={refresh} data-testid="profile-retry-btn">
                  Try again
                </Button>
              }
            >
              {result.error}
            </Alert>
          ) : (
            <UsageCharts usage={result.usage} />
          )}
        </Box>
      </Box>
    </Stack>
  );
}

function UsageCharts({ usage }: { usage: AccountUsage }) {
  const windowLabel = WINDOW_LABELS[usage.window].toLowerCase();

  return (
    <>
      <UsageBarChart
        title="Credits spent"
        total={formatCredits(usage.creditsSpent)}
        bars={usage.bars}
        granularity={usage.granularity}
        metric="creditsSpent"
        color="primary"
        format={formatCredits}
        emptyMessage={`No credits spent in the ${windowLabel}.`}
        testId="profile-credits-chart"
      />

      <UsageBarChart
        title="Requests"
        total={formatCount(usage.requests)}
        bars={usage.bars}
        granularity={usage.granularity}
        metric="requests"
        color="neutral"
        format={formatCount}
        emptyMessage={`No requests in the ${windowLabel}.`}
        testId="profile-requests-chart"
      />

      <UsageBreakdown
        title="By model"
        caption="Credits charged per provider model."
        rows={usage.byModel}
        testId="profile-model-breakdown"
      />
      <UsageBreakdown
        title="By feature"
        caption="Which part of the product spent them."
        rows={usage.byFeature}
        testId="profile-feature-breakdown"
      />
      <UsageBreakdown
        title="By source"
        caption="Which client the request came from."
        rows={usage.bySource}
        testId="profile-source-breakdown"
      />
    </>
  );
}
