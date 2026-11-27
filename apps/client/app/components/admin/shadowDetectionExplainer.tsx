import { useState, type ReactNode } from 'react';
import { Alert, Box, Button, IconButton, LinearProgress, Stack, Typography } from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import {
  REVERSIBLE_TIER_ENFORCE_BAR,
  SHADOW_DETECTION_ENFORCE_BAR,
  isReviewOnlyCompletionDetector,
  shadowDetectionReadiness,
  type ShadowDetectionBar,
  type ShadowDetectionSummaryRow,
  type ShadowDetectionVerdict,
} from '@bike4mind/common';
import { AnalyticsTermHelp } from './EventMetrics/components/AnalyticsTermHelp';
import { StatTile } from './shared';

/**
 * The Detections page's explanations: what shadow mode is, what each term and verdict means, and how
 * far each detector version is from the enforce bars (SHADOW_DETECTION_ENFORCE_BAR and
 * REVERSIBLE_TIER_ENFORCE_BAR in common).
 */

export const DETECTIONS_INTRO_DISMISSED_KEY = 'admin-shadow-detections-intro-dismissed';

const readDismissed = (): boolean => {
  try {
    return window.localStorage.getItem(DETECTIONS_INTRO_DISMISSED_KEY) === 'true';
  } catch {
    return false;
  }
};

const writeDismissed = (dismissed: boolean) => {
  try {
    if (dismissed) window.localStorage.setItem(DETECTIONS_INTRO_DISMISSED_KEY, 'true');
    else window.localStorage.removeItem(DETECTIONS_INTRO_DISMISSED_KEY);
  } catch {
    // Best effort: the banner just shows again on the next visit.
  }
};

const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;

/** How the page works; dismissed per browser, and reopened from a small link. */
export function DetectionsIntro() {
  const [dismissed, setDismissed] = useState(readDismissed);
  const update = (next: boolean) => {
    writeDismissed(next);
    setDismissed(next);
  };

  if (dismissed) {
    return (
      <Box>
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          data-testid="shadow-detection-intro-show-btn"
          onClick={() => update(false)}
        >
          How this page works
        </Button>
      </Box>
    );
  }
  return (
    <Alert
      color="neutral"
      variant="soft"
      data-testid="shadow-detection-intro"
      endDecorator={
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label="Hide how this page works"
          data-testid="shadow-detection-intro-dismiss-btn"
          onClick={() => update(true)}
        >
          <CloseIcon />
        </IconButton>
      }
      sx={{ alignItems: 'flex-start' }}
    >
      <Stack gap={0.75}>
        <Typography level="title-sm">How this page works</Typography>
        <Typography level="body-sm">
          1. Open Review evidence, then inspect the linked accounts and their activity.
        </Typography>
        <Typography level="body-sm">
          2. If you need more time, watch the campaign. Its fixed account list stays available after the advisory
          expires. Watches record manual follow-up; they do not enable automatic alerts or enforcement.
        </Typography>
        <Typography level="body-sm">
          3. Record a judgment when the evidence supports one. Recording a judgment does not change account access;
          suggested responses are not actions applied by this table.
        </Typography>
        <Typography level="body-sm">
          In shadow mode, detectors record suggested responses without applying them. Separate account controls can act
          when enforcement is enabled; reviewing this table does not change that configuration.
        </Typography>
        <Typography level="body-sm">
          Grade each detection to measure its detector. A verdict changes nothing on the account. Once a detector
          version has {SHADOW_DETECTION_ENFORCE_BAR.minConclusive} conclusive verdicts at{' '}
          {percent(SHADOW_DETECTION_ENFORCE_BAR.minPrecision)} precision or better, an eligible detector can be
          considered for enforcement. The reversible, auto-expiring responses (limiting spend or holding the signup
          grant) have a lower bar: {REVERSIBLE_TIER_ENFORCE_BAR.minConclusive} conclusive verdicts at{' '}
          {percent(REVERSIBLE_TIER_ENFORCE_BAR.minPrecision)}. Review-only coordination detectors cannot trigger
          automatic containment.
        </Typography>
        <Typography level="body-sm">
          Found real abuse? Act on the account&apos;s user page. Suspending it there with an abuse reason also grades
          its open detections here.
        </Typography>
      </Stack>
    </Alert>
  );
}

const TERM_HELP = {
  would: {
    term: 'Suggested response',
    description:
      'What the detector would have done on its own. Contain suspends the account, cancels subscriptions, removes credits and revokes keys and sessions. In shadow mode nothing is applied; None means it only logged the pattern.',
  },
  policy: {
    term: 'Policy version',
    description:
      "The version of the detector's rules. Precision is counted per version, so a rule change starts a fresh count.",
  },
  recorded: {
    term: 'Recorded',
    description: 'Every detection this detector version logged, including the ones where it would not act.',
  },
  graded: {
    term: 'Graded',
    description:
      'Detections with a verdict that would have acted, or that come from a review-only detector. Unreviewed ones still need one.',
  },
  precision: {
    term: 'Precision',
    description:
      'Confirmed abuse divided by conclusive verdicts. Conclusive means confirmed abuse or either legitimate verdict; insufficient evidence is left out because it says the reviewer could not tell.',
  },
  falsePositives: {
    term: 'False positives',
    description:
      'Detections graded legitimate: a real person (human) or sanctioned scripts and integrations (automation). Each is a case the detector would have acted on wrongly.',
  },
  enforceBar: {
    term: 'Enforce bar',
    description: `Guidance, not a switch: ${SHADOW_DETECTION_ENFORCE_BAR.minConclusive} conclusive verdicts at ${percent(
      SHADOW_DETECTION_ENFORCE_BAR.minPrecision
    )} precision or better. Automatic containment moves from shadow to enforce only when an admin changes its mode in admin settings, and that mode covers eligible detectors. Review-only coordination detectors remain excluded.`,
  },
  reversibleTierBar: {
    term: 'Reversible bar',
    description: `Guidance, not a switch: ${REVERSIBLE_TIER_ENFORCE_BAR.minConclusive} conclusive verdicts at ${percent(
      REVERSIBLE_TIER_ENFORCE_BAR.minPrecision
    )} precision or better before a reversible response (such as limiting spend or holding the signup grant) moves from shadow to enforce. These responses expire on their own and an admin can release them, so the bar is lower than for full containment. Each one has its own mode in the automatic containment settings.`,
  },
} as const;

export type DetectionTerm = keyof typeof TERM_HELP;

export function TermHelp({ term }: { term: DetectionTerm }) {
  const { term: name, description } = TERM_HELP[term];
  return <AnalyticsTermHelp term={name} description={description} testId={`shadow-detection-help-${term}`} />;
}

/** One line per verdict, with a concrete case, shown under each option in the verdict picker. */
export const VERDICT_GUIDES: Record<ShadowDetectionVerdict, string> = {
  confirmed_abuse: 'The account is part of abuse. For example, a signup-farm account that is already suspended.',
  legitimate_human:
    'A real person using the service as intended. For example, an OAuth signup who chatted and spent credits.',
  legitimate_automation:
    "Sanctioned automation on the owner's behalf. For example, a customer's API script running from a cloud host.",
  insufficient_evidence:
    'You cannot tell either way; it does not count toward precision. For example, two signups from one home IP with no spend yet.',
};

const READINESS_COPY = {
  collecting: (remaining: number) => `${remaining.toLocaleString()} more conclusive to go`,
  below_bar: (_remaining: number, bar: ShadowDetectionBar) => `Below the ${percent(bar.minPrecision)} precision bar`,
  ready: (_remaining: number, bar: ShadowDetectionBar) => `Meets the ${percent(bar.minPrecision)} precision bar`,
} as const;

type BarTileProps = {
  row: ShadowDetectionSummaryRow;
  bar: ShadowDetectionBar;
  label: string;
  term: DetectionTerm;
  testId: string;
  progressLabel: string;
};

function BarTile({ row, bar, label, term, testId, progressLabel }: BarTileProps) {
  const readiness = shadowDetectionReadiness(row, bar);
  const { minConclusive } = bar;
  const comparison: ReactNode = READINESS_COPY[readiness.status](
    Math.max(0, minConclusive - readiness.conclusive),
    bar
  );
  return (
    <StatTile
      label={label}
      help={<TermHelp term={term} />}
      value={
        <Box component="span" data-testid={testId} data-status={readiness.status}>
          {Math.min(readiness.conclusive, minConclusive).toLocaleString()} / {minConclusive.toLocaleString()}
        </Box>
      }
      comparison={comparison}
      sparkline={
        <LinearProgress
          determinate
          value={Math.min(100, (readiness.conclusive / minConclusive) * 100)}
          color="neutral"
          aria-label={progressLabel}
          sx={{ '--LinearProgress-thickness': '4px' }}
        />
      }
    />
  );
}

/** Conclusive verdicts toward the enforce bar, and whether precision clears it once there are enough. */
export function EnforceBarTile({ row, testId }: { row: ShadowDetectionSummaryRow; testId: string }) {
  if (isReviewOnlyCompletionDetector(row.detector)) {
    return (
      <StatTile
        label="Enforcement"
        value={
          <Box component="span" data-testid={`${testId}-enforce-bar`} data-status="review_only">
            Review only
          </Box>
        }
        comparison="No automatic containment"
      />
    );
  }
  return (
    <BarTile
      row={row}
      bar={SHADOW_DETECTION_ENFORCE_BAR}
      label="Enforce bar"
      term="enforceBar"
      testId={`${testId}-enforce-bar`}
      progressLabel="Conclusive verdicts toward the enforce bar"
    />
  );
}

/**
 * Conclusive verdicts toward the reversible-tier bar. Nothing for review-only detectors: the tiers skip
 * them as they skip Contain, and EnforceBarTile already says so.
 */
export function ReversibleTierBarTile({ row, testId }: { row: ShadowDetectionSummaryRow; testId: string }) {
  if (isReviewOnlyCompletionDetector(row.detector)) return null;
  return (
    <BarTile
      row={row}
      bar={REVERSIBLE_TIER_ENFORCE_BAR}
      label="Reversible bar"
      term="reversibleTierBar"
      testId={`${testId}-reversible-bar`}
      progressLabel="Conclusive verdicts toward the reversible-tier bar"
    />
  );
}
