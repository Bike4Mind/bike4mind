import Box from '@mui/joy/Box';
import Link from '@mui/joy/Link';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import type { AccountTier, BillingAccount } from '@shared/account';
import { HourglassIcon } from '../chat/icons';
import {
  FULL_RUNWAY_DAYS,
  formatRunway,
  refillMarker,
  runwayBeyondStatedHorizon,
  upcomingExpiry,
  type CreditOutlook,
  type CreditTone,
} from './creditOutlook';
import type { CreditsGlance } from './useCreditsGlance';

const TONE_COLOR: Record<CreditTone, 'success' | 'warning' | 'danger'> = {
  ok: 'success',
  low: 'warning',
  critical: 'danger',
};

/** Named in every projection, so the estimate never reads as a promise. */
const PACE = "at last week's pace";

const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';

export function formatCredits(value: number): string {
  return Math.round(value).toLocaleString();
}

/** "Dec 2", or "Dec 2, 2027" outside the current year: a runway can now reach past New Year. */
function formatDay(at: number): string {
  const date = new Date(at);
  const otherYear = date.getFullYear() !== new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(otherYear ? { year: 'numeric' } : {}),
  });
}

/**
 * Runway ring: the fill is days of runway out of a 30-day period, the dot is where the refill
 * lands on that same scale. Fill reaching past the dot means the balance outlasts the period.
 */
export function CreditRing({
  fill,
  marker,
  tone,
  size = 36,
}: {
  fill: number;
  marker: number | null;
  tone: CreditTone;
  size?: number;
}) {
  const stroke = 2.5;
  const center = size / 2;
  const radius = center - stroke - 1;
  const circumference = 2 * Math.PI * radius;
  const angle = marker === null ? null : marker * 2 * Math.PI;
  return (
    <Box
      component="svg"
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      aria-hidden
      sx={{ flexShrink: 0, overflow: 'visible' }}
      data-testid="credits-ring"
    >
      <circle cx={center} cy={center} r={radius} fill="none" strokeWidth={stroke} stroke="var(--joy-palette-divider)" />
      <Box
        component="circle"
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        stroke={`var(--joy-palette-${TONE_COLOR[tone]}-500)`}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - fill)}
        transform={`rotate(-90 ${center} ${center})`}
        sx={{ transition: 'stroke-dashoffset 0.9s cubic-bezier(.2,.8,.2,1)', [REDUCED_MOTION]: { transition: 'none' } }}
      />
      {angle !== null && (
        <circle
          cx={center + radius * Math.sin(angle)}
          cy={center - radius * Math.cos(angle)}
          r={stroke + 0.5}
          fill="var(--joy-palette-text-primary)"
          stroke="var(--joy-palette-background-surface)"
          strokeWidth={1}
          data-testid="credits-refill-marker"
        />
      )}
    </Box>
  );
}

function outlookRefillAt(outlook: CreditOutlook): number | null {
  return 'refillAt' in outlook ? outlook.refillAt : null;
}

/** The line under the balance: when the refill lands and how fast credits are going. */
export function creditsSubline(outlook: CreditOutlook, tier: AccountTier | null): string {
  if (outlook.kind === 'unknown') return '';
  const plan = tier === 'free' ? 'Free plan' : null;
  const refillAt = outlookRefillAt(outlook);
  const refill = refillAt === null ? null : `Renews ${formatDay(refillAt)}`;
  if (outlook.kind === 'empty') return refill ?? plan ?? 'No refill scheduled';
  if (outlook.kind === 'idle') return refill ?? plan ?? 'No refill scheduled';
  return [refill ?? plan, `${formatCredits(outlook.burnPerDay)}/day`].filter(Boolean).join(' \u00b7 ');
}

/**
 * One plain sentence on whether the balance lasts. Null when the balance is unknown.
 *
 * Every projection names its basis. A long runway is stated as "more than" past the horizon
 * `formatRunway` can vouch for: a month without an expiry schedule, a year with one.
 */
export function creditsVerdict(outlook: CreditOutlook): string | null {
  switch (outlook.kind) {
    case 'unknown':
      return null;
    case 'idle':
      return 'No spend in the last 7 days, so nothing to project.';
    case 'empty':
      return 'Out of credits.';
    case 'covered':
      return runwayBeyondStatedHorizon(outlook.runwayDays, outlook.expiryKnown)
        ? `More than ${outlook.expiryKnown ? 'a year' : 'a month'} left ${PACE}.`
        : `Lasts to about ${formatDay(outlook.runsOutAt)} ${PACE}, past the renewal on ${formatDay(outlook.refillAt)}.`;
    case 'short':
      return `Runs out about ${formatDay(outlook.runsOutAt)} ${PACE}, ${outlook.daysShort} day${outlook.daysShort === 1 ? '' : 's'} before the renewal on ${formatDay(outlook.refillAt)}.`;
    case 'no-refill':
      return runwayBeyondStatedHorizon(outlook.runwayDays, outlook.expiryKnown)
        ? `More than ${outlook.expiryKnown ? 'a year' : 'a month'} left ${PACE}.`
        : `Lasts to about ${formatDay(outlook.runsOutAt)} ${PACE}.`;
  }
}

/** What the ring shows, in words: its tooltip and its accessible name. */
export function creditsRingLabel(outlook: CreditOutlook): string {
  const refill = outlookRefillAt(outlook) === null ? '' : ' The dot marks the renewal.';
  switch (outlook.kind) {
    case 'unknown':
      return 'Balance unavailable.';
    case 'idle':
      return `No spend in the last 7 days, so nothing to project.${refill}`;
    case 'empty':
      return `No credits left.${refill}`;
    default:
      return `About ${formatRunway(outlook.runwayDays, outlook.expiryKnown)} left ${PACE}. A full ring is ${FULL_RUNWAY_DAYS} days or more.${refill}`;
  }
}

function PayerCaption({ organization }: { organization: BillingAccount | null }) {
  return (
    <Typography level="body-xs" textColor="text.tertiary" noWrap data-testid="credits-payer">
      {organization ? `Paid by ${organization.name}` : 'Personal'}
    </Typography>
  );
}

/**
 * An organization pool: its balance and nothing projected. The personal burn rate and renewal
 * describe a different ledger, and the pool's own spend is not readable from here.
 */
function OrganizationCreditsHeader({
  organization,
  outlook,
}: {
  organization: BillingAccount;
  outlook: CreditOutlook;
}) {
  return (
    <Stack spacing={0.5} sx={{ px: 1, pt: 0.5, pb: 1 }} data-testid="credits-glance" data-payer="organization">
      <PayerCaption organization={organization} />
      {organization.credits === null ? (
        <Typography level="body-sm" textColor="text.tertiary" data-testid="credits-glance-unavailable">
          Pool balance unavailable.
        </Typography>
      ) : (
        <Typography
          level="body-sm"
          fontWeight="lg"
          sx={{ fontVariantNumeric: 'tabular-nums' }}
          data-testid="credits-balance"
        >
          {formatCredits(organization.credits)} credits
        </Typography>
      )}
      <Typography level="body-xs" textColor="text.tertiary" noWrap>
        {organization.seats ? `Organization pool \u00b7 ${organization.seats} seats` : 'Organization pool'}
      </Typography>
      {outlook.kind === 'empty' && (
        <Typography
          level="body-xs"
          sx={{ px: 1, py: 0.75, borderRadius: 'sm', bgcolor: 'danger.softBg', color: 'danger.softColor' }}
          data-testid="credits-verdict"
        >
          Out of credits.
        </Typography>
      )}
    </Stack>
  );
}

/** "1,800 credits expire Nov 27": the next grant to expire within two weeks, as it stands now. */
export function creditsExpiryNotice(expiry: { amount: number; expiresAt: number }): string {
  const amount = formatCredits(expiry.amount);
  return `${amount} credit${amount === '1' ? '' : 's'} expire${amount === '1' ? 's' : ''} ${formatDay(expiry.expiresAt)}`;
}

/** The credits block at the top of the account menu. */
export function CreditsMenuHeader({ glance, onTopUp }: { glance: CreditsGlance; onTopUp?: () => void }) {
  const { outlook, profile, organization } = glance;
  if (organization) return <OrganizationCreditsHeader organization={organization} outlook={outlook} />;
  if (outlook.kind === 'unknown') {
    if (!profile) return null;
    return (
      <Typography
        level="body-xs"
        textColor="text.tertiary"
        sx={{ px: 1, pb: 0.5 }}
        data-testid="credits-glance-unavailable"
      >
        {profile.credits.error ?? 'Balance unavailable.'}
      </Typography>
    );
  }

  const balance = profile?.credits.balance ?? 0;
  const color = outlook.kind === 'idle' ? 'neutral' : TONE_COLOR[outlook.tone];
  const verdict = creditsVerdict(outlook);
  const at = glance.readAt ?? Date.now();
  const marker = refillMarker(outlookRefillAt(outlook), at);
  const expiry = upcomingExpiry(profile?.credits.expiring, at);

  return (
    <Stack spacing={1} sx={{ px: 1, pt: 0.5, pb: 1 }} data-testid="credits-glance" data-payer="personal">
      <PayerCaption organization={null} />
      <Stack direction="row" spacing={1.25} alignItems="center">
        <Tooltip title={creditsRingLabel(outlook)} size="sm" placement="bottom-start" variant="soft">
          <Box role="img" aria-label={creditsRingLabel(outlook)} sx={{ display: 'inline-flex', flexShrink: 0 }}>
            <CreditRing fill={outlook.ringFill} marker={marker} tone={outlook.tone} />
          </Box>
        </Tooltip>
        <Stack sx={{ minWidth: 0, flex: 1 }}>
          <Typography
            level="body-sm"
            fontWeight="lg"
            sx={{ fontVariantNumeric: 'tabular-nums' }}
            data-testid="credits-balance"
          >
            {formatCredits(balance)} credits
          </Typography>
          <Typography level="body-xs" textColor="text.tertiary" noWrap>
            {creditsSubline(outlook, profile?.tier ?? null)}
          </Typography>
          {expiry && (
            <Typography
              level="body-xs"
              color="warning"
              noWrap
              startDecorator={<HourglassIcon size={12} />}
              sx={{ fontVariantNumeric: 'tabular-nums' }}
              data-testid="credits-expiry-notice"
            >
              {creditsExpiryNotice(expiry)}
            </Typography>
          )}
        </Stack>
      </Stack>
      {verdict && (
        <Typography
          level="body-xs"
          sx={{ px: 1, py: 0.75, borderRadius: 'sm', bgcolor: `${color}.softBg`, color: `${color}.softColor` }}
          data-testid="credits-verdict"
        >
          {verdict}
        </Typography>
      )}
      {outlook.tone !== 'ok' && onTopUp && (
        <Link
          level="body-xs"
          component="button"
          onClick={onTopUp}
          sx={{ alignSelf: 'flex-start' }}
          data-testid="credits-top-up-btn"
        >
          Top up
        </Link>
      )}
    </Stack>
  );
}
