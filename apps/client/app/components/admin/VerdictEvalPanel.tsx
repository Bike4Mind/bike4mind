import React, { useState } from 'react';
import { Alert, Button, ButtonGroup, Stack, Typography } from '@mui/joy';
import { useVerdictEval } from '@client/app/hooks/data/shadowDetections';
import {
  VERDICT_EVAL_WINDOWS,
  type EvalCohort,
  type VerdictEvalCohortRow,
  type VerdictEvalDisagreement,
  type VerdictEvalGrader,
  type VerdictEvalLabelSource,
  type VerdictEvalOperationsRow,
  type VerdictEvalScore,
  type VerdictEvalWindowDays,
} from '@client/app/utils/verdictEval';
import { DataTable, StatStrip, StatTile, formatUtc, type DataColumn } from './shared';

const GRADER_LABELS: Record<VerdictEvalGrader, string> = {
  assessment: 'AI assessment',
  containment: 'Auto-containment',
  signupVerdict: 'Signup verdict',
};

const SOURCE_LABELS: Record<VerdictEvalLabelSource, string> = {
  adminVerdict: 'Detection verdict',
  reinstated: 'Reinstated',
  adminSuspended: 'Suspended by an admin',
  riskReview: 'Risk review',
};

const COHORT_LABELS: Record<EvalCohort, string> = {
  mobile: 'Mobile or tablet',
  sharedNetwork: 'Shared signup network',
  apiAgent: 'API, agent or CLI use',
  assistive: 'Assistive technology',
};

const hours = (value: number) => `${value.toLocaleString()} h`;
const credits = (value: number) => `${value.toLocaleString()} credits`;

const operationsColumns: readonly DataColumn<VerdictEvalOperationsRow>[] = [
  { id: 'detector', label: 'Detector', render: row => row.detector },
  { id: 'detections', label: 'Detections', render: row => row.detections.toLocaleString(), numeric: true },
  {
    id: 'reviewed',
    label: 'Reviewed (of detections)',
    render: row => `${row.reviewed.toLocaleString()} of ${row.detections.toLocaleString()}`,
    numeric: true,
  },
  {
    id: 'yield',
    label: 'Review yield (abuse of conclusive)',
    render: row =>
      row.reviewYield === null ? '-' : `${percent(row.reviewYield)} of ${row.conclusive.toLocaleString()}`,
    numeric: true,
  },
  {
    id: 'time',
    label: 'Time to detection (abuse, median / p90)',
    render: row =>
      row.timeToDetection
        ? `${hours(row.timeToDetection.medianHours)} / ${hours(row.timeToDetection.p90Hours)} (${row.timeToDetection.n.toLocaleString()})`
        : '-',
    numeric: true,
  },
  {
    id: 'spend',
    label: 'Spend before / after detection (abuse accounts)',
    render: row =>
      row.spend
        ? `${credits(row.spend.creditsBeforeDetection)} / ${credits(row.spend.creditsAfterDetection)} (${row.spend.accounts.toLocaleString()} accounts)`
        : '-',
    numeric: true,
  },
];

const cohortColumns: readonly DataColumn<VerdictEvalCohortRow>[] = [
  { id: 'cohort', label: 'Cohort', render: row => COHORT_LABELS[row.cohort] },
  {
    id: 'flagged',
    label: 'Flagged accounts',
    render: row => (row.measurable ? row.flaggedAccounts.toLocaleString() : 'Not measurable: no stored signal'),
    numeric: true,
  },
  {
    id: 'labelled',
    label: 'Labelled (of flagged)',
    render: row =>
      row.measurable ? `${row.labelledAccounts.toLocaleString()} of ${row.flaggedAccounts.toLocaleString()}` : '-',
    numeric: true,
  },
  { id: 'abuse', label: 'Abuse', render: row => (row.measurable ? row.abuse.toLocaleString() : '-'), numeric: true },
  { id: 'legit', label: 'Legit', render: row => (row.measurable ? row.legit.toLocaleString() : '-'), numeric: true },
  {
    id: 'share',
    label: 'False positive share (legit of labelled)',
    render: row =>
      row.falsePositiveShare === null
        ? '-'
        : `${percent(row.falsePositiveShare)} of ${row.labelledAccounts.toLocaleString()}`,
    numeric: true,
  },
];

const percent = (value: number | null) => (value === null ? '-' : `${Math.round(value * 100)}%`);

const ScoreStrip: React.FC<{ score: VerdictEvalScore }> = ({ score }) => {
  const labelled = score.truePositive + score.falsePositive + score.falseNegative + score.trueNegative;
  const name = `${GRADER_LABELS[score.grader]}, ${score.variant}`;
  return (
    <Stack gap={1} data-testid={`verdict-eval-score-${score.grader}-${score.variant}`}>
      <Typography level="title-sm" sx={{ color: 'admin.ink' }}>
        {name}
      </Typography>
      <StatStrip aria-label={name}>
        <StatTile label="Graded" value={labelled} comparison={`${score.abstained.toLocaleString()} abstained`} />
        <StatTile
          label="Precision"
          value={percent(score.precision)}
          comparison={`${score.truePositive.toLocaleString()} of ${(score.truePositive + score.falsePositive).toLocaleString()} called abuse`}
        />
        <StatTile
          label="Hit rate"
          value={percent(score.hitRate)}
          comparison={`${score.falseNegative.toLocaleString()} abuse missed`}
        />
        <StatTile
          label="False positive rate"
          value={percent(score.falsePositiveRate)}
          comparison={`${score.falsePositive.toLocaleString()} of ${(score.falsePositive + score.trueNegative).toLocaleString()} legit`}
        />
      </StatStrip>
    </Stack>
  );
};

const columns: readonly DataColumn<VerdictEvalDisagreement>[] = [
  { id: 'at', label: 'When', render: row => formatUtc(row.at), width: '10rem' },
  { id: 'grader', label: 'Grader', render: row => `${GRADER_LABELS[row.grader]}, ${row.variant}` },
  { id: 'kind', label: 'Kind', render: row => (row.kind === 'falseNegative' ? 'Missed abuse' : 'False positive') },
  { id: 'predicted', label: 'Said', render: row => row.predicted },
  { id: 'label', label: 'Admins said', render: row => `${row.label} (${SOURCE_LABELS[row.labelSource]})` },
  { id: 'subject', label: 'Detection or account', render: row => row.detectionId ?? row.userId ?? '-' },
];

const rowId = (row: VerdictEvalDisagreement) =>
  `${row.grader}-${row.variant}-${row.detectionId ?? row.userId}-${row.at.toISOString()}`;

/**
 * How the automated verdicts agree with admin labels over a window: the evidence for moving
 * auto-containment from shadow to enforce.
 */
export const VerdictEvalPanel: React.FC = () => {
  const [days, setDays] = useState<VerdictEvalWindowDays>(30);
  const evaluation = useVerdictEval(days);
  const report = evaluation.data;
  return (
    <Stack gap={2} data-testid="verdict-eval-panel">
      <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1} flexWrap="wrap">
        <Typography level="title-md" sx={{ color: 'admin.ink' }}>
          Verdict accuracy
        </Typography>
        <ButtonGroup size="sm" aria-label="Window">
          {VERDICT_EVAL_WINDOWS.map(option => (
            <Button
              key={option}
              variant={option === days ? 'solid' : 'outlined'}
              onClick={() => setDays(option)}
              data-testid={`verdict-eval-window-${option}`}
            >
              {option} days
            </Button>
          ))}
        </ButtonGroup>
      </Stack>
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
        Each automated verdict against what admins decided: the detection verdict, a reinstatement, a suspension by an
        admin or the closed risk review. Bans made by auto-containment alone are not labels.
      </Typography>
      {evaluation.error && (
        <Alert color="danger" data-testid="verdict-eval-error">
          Couldn&apos;t load the verdict eval.
        </Alert>
      )}
      {report?.truncated && (
        <Alert color="warning" data-testid="verdict-eval-truncated">
          The window holds more rows than one read covers; these counts are for the newest part of it.
        </Alert>
      )}
      {report && report.scores.length === 0 && (
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="verdict-eval-empty">
          No labelled verdicts in the last {days} days.
        </Typography>
      )}
      {report?.scores.map(score => (
        <ScoreStrip key={`${score.grader}-${score.variant}`} score={score} />
      ))}
      {report && report.excludedAutoApprovals > 0 && (
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="verdict-eval-auto-approvals">
          {report.excludedAutoApprovals.toLocaleString()} accounts approved by the auto-approval policy are not counted
          as labels.
        </Typography>
      )}
      {report && report.operations.length > 0 && (
        <DataTable
          rows={report.operations}
          columns={operationsColumns}
          label="Operations"
          getRowId={row => row.detector}
          testId="verdict-eval-operations"
          onRetry={() => void evaluation.refetch()}
          pageResetKey={String(days)}
        />
      )}
      {report && (
        <DataTable
          rows={report.cohorts}
          columns={cohortColumns}
          label="Cohorts"
          getRowId={row => row.cohort}
          testId="verdict-eval-cohorts"
          onRetry={() => void evaluation.refetch()}
          pageResetKey={String(days)}
        />
      )}
      {report && report.disagreements.length > 0 && (
        <DataTable
          rows={report.disagreements}
          columns={columns}
          label="Disagreements"
          getRowId={rowId}
          testId="verdict-eval-disagreements"
          onRetry={() => void evaluation.refetch()}
          pageResetKey={String(days)}
        />
      )}
    </Stack>
  );
};
