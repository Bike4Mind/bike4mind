import { FC } from 'react';
import { Alert, Box, Button, Stack, Typography } from '@mui/joy';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import HourglassTopIcon from '@mui/icons-material/HourglassTop';
import ErrorIcon from '@mui/icons-material/Error';
import ReplayIcon from '@mui/icons-material/Replay';
import type { ISkillListingVersion, SkillListingVisibility } from '@bike4mind/common';
import { FindingsList, HonestSummaryPanel, MismatchAlert, TierChip } from './parts';

export const SELF_APPROVED_LABEL = 'Self-approved by the author';

const MAX_HOLD_CAUSES = 3;

/** The findings that put a version in its tier, as one sentence fragment; empty when none apply. */
export function heldCauses(findings: { severity: string; message: string }[], tier?: string): string {
  const severity = tier === 'high' ? 'high' : 'medium';
  const messages = [
    ...new Set(findings.filter(f => f.severity === severity).map(f => f.message.replace(/[.\s]+$/, ''))),
  ];
  if (messages.length === 0) return '';
  const extra = messages.length - MAX_HOLD_CAUSES;
  return `${messages.slice(0, MAX_HOLD_CAUSES).join('; ')}${extra > 0 ? `; and ${extra} more` : ''}`;
}

function heldBody(tier: string | undefined, findings: { severity: string; message: string }[]): string {
  const causes = heldCauses(findings, tier);
  if (tier === 'high') {
    return causes
      ? `A reviewer must approve it first because of: ${causes}.`
      : 'It has high-risk findings, so a reviewer must approve it first.';
  }
  return causes
    ? `A person checks it before it goes live because of: ${causes}.`
    : 'Listings with findings are checked by a person before they go live.';
}

/** Plain-language outcome of a version's scan + review state. */

/** Pass the listing's `authorUserId` so a self-approval is not described as a second person's review. */
export function versionOutcome(v: ISkillListingVersion, visibility: SkillListingVisibility, authorUserId?: string) {
  if (v.scanStatus === 'scanning')
    return { color: 'neutral' as const, title: 'Scanning...', body: 'The safety scan is running.' };
  if (v.scanStatus === 'error') {
    return {
      color: 'danger' as const,
      title: 'The safety scan could not finish',
      body: 'Nothing was published. This is usually temporary - retry the scan.',
    };
  }
  if (v.scanStatus === 'failed') {
    return {
      color: 'danger' as const,
      title: 'Not published: the safety scan found problems',
      body: 'Fix the issues below in your skill, then submit a new version.',
    };
  }
  switch (v.reviewStatus) {
    case 'auto_approved':
      return {
        color: 'success' as const,
        title: 'Live on the Skill Market',
        body:
          v.riskTier === 'review'
            ? `Passed the automated scan with a note and is live for your ${visibility === 'organization' ? 'organization' : 'link holders'}.`
            : 'Passed the automated safety scan and is live now.',
      };
    case 'approved':
      return {
        color: 'success' as const,
        title: authorUserId && v.reviewerUserId === authorUserId ? SELF_APPROVED_LABEL : 'Approved by a reviewer',
        body: 'This version is live.',
      };
    case 'pending':
      return {
        color: 'warning' as const,
        title: 'Waiting for a human reviewer',
        body: heldBody(v.riskTier, v.scanFindings),
      };
    case 'rejected':
      return {
        color: 'danger' as const,
        title: 'Not approved',
        body: v.reviewNote ? `Reviewer note: ${v.reviewNote}` : '',
      };
    case 'superseded':
      return { color: 'neutral' as const, title: 'Superseded', body: 'A newer version replaced this one.' };
    default:
      return { color: 'neutral' as const, title: v.reviewStatus, body: '' };
  }
}

const ICON = {
  success: <CheckCircleIcon />,
  warning: <HourglassTopIcon />,
  danger: <ErrorIcon />,
  neutral: <HourglassTopIcon />,
};

/** Scan verdict block: outcome banner, honest summary, findings, and a retry for errored scans. */
const ScanResult: FC<{
  version: ISkillListingVersion;
  visibility: SkillListingVisibility;
  authorUserId?: string;
  onRescan?: () => void;
  rescanning?: boolean;
}> = ({ version, visibility, authorUserId, onRescan, rescanning }) => {
  const outcome = versionOutcome(version, visibility, authorUserId);
  return (
    <Stack spacing={1.5} data-testid="market-scan-result">
      <Alert
        color={outcome.color}
        variant="soft"
        startDecorator={ICON[outcome.color]}
        data-testid={`market-scan-${version.scanStatus}`}
      >
        <Box sx={{ flex: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography level="title-sm">{outcome.title}</Typography>
            <TierChip tier={version.riskTier} />
          </Stack>
          {outcome.body ? <Typography level="body-sm">{outcome.body}</Typography> : null}
        </Box>
        {version.scanStatus === 'error' && onRescan ? (
          <Button
            size="sm"
            variant="solid"
            color="danger"
            startDecorator={<ReplayIcon />}
            loading={rescanning}
            onClick={onRescan}
            data-testid="market-rescan-btn"
          >
            Retry scan
          </Button>
        ) : null}
      </Alert>

      {version.honestSummary?.descriptionMatches === false ? (
        <MismatchAlert note={version.honestSummary.mismatchNote} />
      ) : null}
      {version.honestSummary ? (
        <HonestSummaryPanel summary={version.honestSummary} tools={version.snapshot?.allowedTools} />
      ) : null}

      {version.scanFindings.length ? (
        <Box>
          <Typography level="title-sm" sx={{ mb: 0.5 }}>
            What the scan found
          </Typography>
          <FindingsList findings={version.scanFindings} />
        </Box>
      ) : null}
    </Stack>
  );
};

export default ScanResult;
