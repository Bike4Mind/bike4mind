import Box from '@mui/joy/Box';
import Link from '@mui/joy/Link';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { AccountTier } from '@shared/account';
import { formatRunway, refillMarker, type CreditOutlook, type CreditTone } from './creditOutlook';
import type { CreditsGlance } from './useCreditsGlance';

const TONE_COLOR: Record<CreditTone, 'success' | 'warning' | 'danger'> = {
  ok: 'success',
  low: 'warning',
  critical: 'danger',
};

/** Past this much runway the verdict names a duration; inside it, a date reads better. */
const DATE_HORIZON_DAYS = 45;

const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';

function formatCredits(value: number): string {
  return Math.round(value).toLocaleString();
}

function formatDay(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
  const refill = refillAt === null ? null : `Refill ${formatDay(refillAt)}`;
  if (outlook.kind === 'empty') return refill ?? plan ?? 'No refill scheduled';
  if (outlook.kind === 'idle') return [refill ?? plan, 'no spend in 7 days'].filter(Boolean).join(' \u00b7 ');
  return [refill ?? plan, `${formatCredits(outlook.burnPerDay)}/day`].filter(Boolean).join(' \u00b7 ');
}

/** One plain sentence on whether the balance lasts. Null when there is nothing to project. */
export function creditsVerdict(outlook: CreditOutlook): string | null {
  switch (outlook.kind) {
    case 'unknown':
    case 'idle':
      return null;
    case 'empty':
      return 'Out of credits.';
    case 'covered':
      return outlook.runwayDays > DATE_HORIZON_DAYS
        ? `About ${formatRunway(outlook.runwayDays)} at this pace. You're fine.`
        : `Lasts until ${formatDay(outlook.runsOutAt)}, refill ${formatDay(outlook.refillAt)}. You're fine.`;
    case 'short':
      return `Runs out ${formatDay(outlook.runsOutAt)}, ${outlook.daysShort} day${outlook.daysShort === 1 ? '' : 's'} before the refill on ${formatDay(outlook.refillAt)}.`;
    case 'no-refill':
      return outlook.runwayDays > DATE_HORIZON_DAYS
        ? `About ${formatRunway(outlook.runwayDays)} at this pace.`
        : `At this pace, lasts until ${formatDay(outlook.runsOutAt)}.`;
  }
}

/** The credits block at the top of the account menu. */
export function CreditsMenuHeader({ glance, onTopUp }: { glance: CreditsGlance; onTopUp?: () => void }) {
  const { outlook, profile } = glance;
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
  const color = TONE_COLOR[outlook.tone];
  const verdict = creditsVerdict(outlook);
  const marker = refillMarker(outlookRefillAt(outlook), glance.readAt ?? Date.now());

  return (
    <Stack spacing={1} sx={{ px: 1, pt: 0.5, pb: 1 }} data-testid="credits-glance">
      <Stack direction="row" spacing={1.25} alignItems="center">
        <CreditRing fill={outlook.ringFill} marker={marker} tone={outlook.tone} />
        <Stack sx={{ minWidth: 0 }}>
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

/** A soft dot on the avatar, shown only when credits need attention. No modal, no sound. */
export function CreditsAvatarDot({ outlook }: { outlook: CreditOutlook }) {
  if (outlook.kind === 'unknown' || outlook.tone === 'ok') return null;
  const color = `var(--joy-palette-${TONE_COLOR[outlook.tone]}-500)`;
  return (
    <Box
      component="span"
      role="img"
      aria-label={outlook.tone === 'critical' ? 'Credits almost out' : 'Credits running low'}
      data-testid="credits-avatar-dot"
      sx={{
        position: 'absolute',
        top: -1,
        right: -1,
        width: 9,
        height: 9,
        borderRadius: '50%',
        bgcolor: color,
        boxShadow: '0 0 0 2px var(--joy-palette-background-body)',
        '@keyframes creditsPulse': {
          '50%': {
            boxShadow: `0 0 0 2px var(--joy-palette-background-body), 0 0 0 5px color-mix(in srgb, ${color} 30%, transparent)`,
          },
        },
        animation: 'creditsPulse 2.4s ease-in-out infinite',
        [REDUCED_MOTION]: { animation: 'none' },
      }}
    />
  );
}
