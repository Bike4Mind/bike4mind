import React, { useState } from 'react';
import { Alert, Button, ButtonGroup, Stack, Typography } from '@mui/joy';
import { useVerdictEval } from '@client/app/hooks/data/shadowDetections';
import {
  VERDICT_EVAL_WINDOWS,
  type VerdictEvalDisagreement,
  type VerdictEvalGrader,
  type VerdictEvalLabelSource,
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
