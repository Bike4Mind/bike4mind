import React, { useRef, useState } from 'react';
import {
  Alert,
  Button,
  FormControl,
  FormLabel,
  Input,
  Option,
  Radio,
  RadioGroup,
  Select,
  Stack,
  Typography,
} from '@mui/joy';
import { SHADOW_DETECTION_VERDICTS, isValidAdminActionReason, type ShadowDetectionVerdict } from '@bike4mind/common';
import { Link } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import { getErrorMessage } from '@client/app/utils/error';
import {
  useCreateEvalSet,
  useEvalSet,
  useEvalSets,
  useEvalSetVerdict,
  useRunEvalSet,
} from '@client/app/hooks/data/verdictEvalSets';
import {
  EVAL_SET_CALIBRATION_BUCKETS,
  EVAL_SET_HELD_OUT_SHARE_MAX,
  EVAL_SET_HELD_OUT_SHARE_MIN,
  EVAL_SET_MIN_REVIEWED,
  EVAL_SET_UNFLAGGED_SAMPLE_MAX,
  EVAL_SET_UNFLAGGED_SAMPLE_MIN,
  compareEvalSetRuns,
  countsTowardRecall,
  evalSetScoreKey,
  riskReviewShare,
  type EvalSetCalibration,
  type EvalSetDetail,
  type EvalSetExample,
  type EvalSetRun,
  type EvalSetRunReport,
  type EvalSetScore,
  type EvalSetScoreComparison,
  type EvalSetScoreComparisonField,
  type EvalSetSummary,
} from '@client/app/utils/verdictEvalSets';
import {
  VERDICT_EVAL_LABEL_SOURCES,
  VERDICT_EVAL_WINDOWS,
  type VerdictEvalCohortRow,
  type VerdictEvalLabelSource,
  type VerdictEvalWindowDays,
} from '@client/app/utils/verdictEval';
import {
  ActionDialog,
  ADMIN_REASON_PRESETS,
  AdminPermissionAction,
  DataTable,
  EmptyState,
  StatStrip,
  StatTile,
  formatUtc,
  useMissingAdminPermission,
  type DataColumn,
} from './shared';
import { COHORT_LABELS, GRADER_LABELS, LABEL_SOURCE_LABELS } from './verdictEvalLabels';

const VERDICT_LABELS: Record<ShadowDetectionVerdict, string> = {
  confirmed_abuse: 'Confirmed abuse',
  legitimate_human: 'Legitimate human',
  legitimate_automation: 'Legitimate automation',
  insufficient_evidence: 'Insufficient evidence',
};

const count = (value: number) => value.toLocaleString();
const percent = (value: number | null) => (value === null ? '-' : `${Math.round(value * 100)}%`);

/** Percentage points from the previous run, signed; empty when either run has no value. */
const delta = (current: number | null, previous: number | null | undefined) =>
  current === null || previous === null || previous === undefined
    ? ''
    : ` (${current - previous >= 0 ? '+' : ''}${Math.round((current - previous) * 100)} pts)`;

/** A signed count change (+2, -1, 0); a dash when either run lacks the value. */
const signedCount = (change: number | null) =>
  change === null ? '-' : `${change > 0 ? '+' : ''}${change.toLocaleString()}`;
/** A signed rate change in percentage points; a dash when either run lacks the value. */
const signedPoints = (change: number | null) => {
  if (change === null) return '-';
  const points = Math.round(change * 100);
  return `${points > 0 ? '+' : ''}${points} pts`;
};
const brierText = (value: number | null) => (value === null ? '-' : value.toFixed(3));
const signedBrier = (change: number | null) => (change === null ? '-' : `${change > 0 ? '+' : ''}${change.toFixed(3)}`);

const isLabelSource = (source: string): source is VerdictEvalLabelSource =>
  (VERDICT_EVAL_LABEL_SOURCES as readonly string[]).includes(source);
const labelSourceName = (source: string) => (isLabelSource(source) ? LABEL_SOURCE_LABELS[source] : source);

const UserLink: React.FC<{ userId: string }> = ({ userId }) => (
  <Link
    to="/admin/users/$userId"
    params={{ userId }}
    data-testid={`eval-sets-user-link-${userId}`}
    style={{ textDecoration: 'none' }}
  >
    <Typography level="body-xs" fontFamily="code" noWrap sx={{ color: 'admin.link' }}>
      {userId}
    </Typography>
  </Link>
);

const setColumns: readonly DataColumn<EvalSetSummary>[] = [
  { id: 'name', label: 'Name', render: row => row.name },
  { id: 'created', label: 'Drawn', render: row => formatUtc(row.createdAt), width: '10rem' },
  {
    id: 'population',
    label: 'Accounts in window (flagged / unflagged)',
    render: row => `${count(row.population.flagged)} / ${count(row.population.unflagged)}`,
    numeric: true,
  },
  {
    id: 'examples',
    label: 'Examples (held out of total)',
    render: row => `${count(row.heldOutExamples)} of ${count(row.examples)}`,
    numeric: true,
  },
  {
    id: 'runs',
    label: 'Runs (last)',
    render: row => (row.lastRunAt ? `${count(row.runs)} (${formatUtc(row.lastRunAt)})` : count(row.runs)),
    numeric: true,
  },
];

const cohortColumns: readonly DataColumn<VerdictEvalCohortRow>[] = [
  { id: 'cohort', label: 'Cohort', render: row => COHORT_LABELS[row.cohort] },
  {
    id: 'flagged',
    label: 'Flagged held-out accounts',
    render: row => (row.measurable ? count(row.flaggedAccounts) : 'Not measurable: no stored signal'),
    numeric: true,
  },
  {
    id: 'labelled',
    label: 'Labelled (of flagged)',
    render: row => (row.measurable ? `${count(row.labelledAccounts)} of ${count(row.flaggedAccounts)}` : '-'),
    numeric: true,
  },
  {
    id: 'share',
    label: 'False positive share (legit of labelled)',
    render: row =>
      row.falsePositiveShare === null ? '-' : `${percent(row.falsePositiveShare)} of ${count(row.labelledAccounts)}`,
    numeric: true,
  },
];

function scoreColumns(previous: EvalSetRun | null): readonly DataColumn<EvalSetScore>[] {
  const before = (score: EvalSetScore) =>
    previous?.report.scores.find(candidate => evalSetScoreKey(candidate) === evalSetScoreKey(score));
  return [
    { id: 'grader', label: 'Grader', render: score => `${GRADER_LABELS[score.grader]}, ${score.variant}` },
    {
      id: 'graded',
      label: 'Graded (abstained)',
      render: score =>
        `${count(score.truePositive + score.falsePositive + score.falseNegative + score.trueNegative)} (${count(score.abstained)})`,
      numeric: true,
    },
    {
      id: 'called',
      label: 'Called abuse (right of called)',
      render: score => `${count(score.truePositive)} of ${count(score.truePositive + score.falsePositive)}`,
      numeric: true,
    },
    {
      id: 'precision',
      label: 'Precision (95% lower bound)',
      render: score =>
        score.precision === null
          ? '-'
          : `${percent(score.precision)} (${percent(score.precisionLowerBound)})${delta(score.precision, before(score)?.precision)}`,
      numeric: true,
    },
  ];
}

const bucketLabel = (index: number) =>
  `${Math.round((index / EVAL_SET_CALIBRATION_BUCKETS) * 100)}-${Math.round(((index + 1) / EVAL_SET_CALIBRATION_BUCKETS) * 100)}%`;

const calibrationColumns: readonly DataColumn<EvalSetCalibration>[] = [
  { id: 'model', label: 'Model', render: row => row.model },
  {
    id: 'assessed',
    label: 'Assessed (of labelled flagged)',
    render: row =>
      row.n === 0
        ? `Not enough assessed examples (0 of ${count(row.flaggedLabelled)})`
        : `${count(row.n)} of ${count(row.flaggedLabelled)}`,
    wrap: true,
  },
  { id: 'brier', label: 'Brier score', render: row => brierText(row.brier), numeric: true, width: '6rem' },
  ...Array.from({ length: EVAL_SET_CALIBRATION_BUCKETS }, (_, index): DataColumn<EvalSetCalibration> => ({
    id: `bucket-${index}`,
    label: bucketLabel(index),
    render: row => {
      const bucket = row.buckets[index];
      return !bucket || bucket.n === 0
        ? '-'
        : `${percent(bucket.meanPredicted)} vs ${percent(bucket.observedAbuseRate)} (${count(bucket.n)})`;
    },
    numeric: true,
    width: '8.5rem',
  })),
];

const COMPARISON_COUNT_FIELDS: readonly { field: EvalSetScoreComparisonField; label: string }[] = [
  { field: 'truePositive', label: 'TP' },
  { field: 'falsePositive', label: 'FP' },
  { field: 'falseNegative', label: 'FN' },
  { field: 'trueNegative', label: 'TN' },
  { field: 'abstained', label: 'Abstained' },
];
const COMPARISON_RATE_FIELDS: readonly { field: EvalSetScoreComparisonField; label: string }[] = [
  { field: 'precision', label: 'Precision' },
  { field: 'precisionLowerBound', label: '95% lower bound' },
];

const PRESENCE_SUFFIX: Record<EvalSetScoreComparison['presence'], string> = {
  both: '',
  added: ' (new in this run)',
  removed: ' (not in this run)',
};

const comparisonColumns: readonly DataColumn<EvalSetScoreComparison>[] = [
  {
    id: 'grader',
    label: 'Grader',
    render: row => `${GRADER_LABELS[row.grader]}, ${row.variant}${PRESENCE_SUFFIX[row.presence]}`,
    wrap: true,
  },
  ...COMPARISON_COUNT_FIELDS.map(({ field, label }): DataColumn<EvalSetScoreComparison> => ({
    id: field,
    label,
    render: row => signedCount(row[field].change),
    numeric: true,
    width: '5.5rem',
  })),
  ...COMPARISON_RATE_FIELDS.map(({ field, label }): DataColumn<EvalSetScoreComparison> => ({
    id: field,
    label,
    render: row => signedPoints(row[field].change),
    numeric: true,
    width: '8rem',
  })),
];

const LabelSources: React.FC<{ labelSources: Record<string, number> }> = ({ labelSources }) => {
  const sources = Object.entries(labelSources).filter(([, total]) => total > 0);
  if (sources.length === 0) return null;
  const riskReview = riskReviewShare(labelSources);
  return (
    <Stack gap={1} data-testid="eval-sets-label-sources">
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
        Labels by source: {sources.map(([source, total]) => `${labelSourceName(source)} ${count(total)}`).join(', ')}.
      </Typography>
      {riskReview && (
        <Alert color="warning" size="sm" data-testid="eval-sets-risk-review-caveat">
          {percent(riskReview.share)} of labels ({count(riskReview.count)} of {count(riskReview.total)}) come from risk
          review, which only covers accounts the signup-risk queue flagged before, so they cannot speak to accounts it
          never flagged.
        </Alert>
      )}
    </Stack>
  );
};

const Calibration: React.FC<{ calibration: readonly EvalSetCalibration[]; onRetry: () => void }> = ({
  calibration,
  onRetry,
}) => (
  <Stack gap={1}>
    <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="eval-sets-calibration-note">
      AI assessment calibration: the model&apos;s p(abuse) against the labels of held-out flagged examples. Each bucket
      shows mean predicted vs observed abuse rate (examples). Unflagged examples have no assessment.
    </Typography>
    <DataTable
      rows={calibration}
      columns={calibrationColumns}
      label="AI assessment calibration"
      getRowId={row => row.model}
      testId="eval-sets-calibration-table"
      onRetry={onRetry}
      minWidth="64rem"
      empty={<Typography level="body-sm">No assessment calibration in this run.</Typography>}
    />
  </Stack>
);

const RunComparison: React.FC<{ run: EvalSetRunReport; previous: EvalSetRun; onRetry: () => void }> = ({
  run,
  previous,
  onRetry,
}) => {
  const comparison = compareEvalSetRuns(run, previous.report);
  const summary = [
    `Labelled examples: ${count(run.labelled)} (${signedCount(comparison.labelled.change)})`,
    `estimated recall: ${percent(run.recall.estimatedRecall)} (${signedPoints(comparison.estimatedRecall.change)})`,
    ...comparison.brier.map(
      ({ model, brier }) => `Brier, ${model}: ${brierText(brier.current)} (${signedBrier(brier.change)})`
    ),
  ];
  return (
    <Stack gap={1} data-testid="eval-sets-run-comparison">
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="eval-sets-run-comparison-summary">
        Against the run of {formatUtc(previous.ranAt)}: {summary.join('; ')}.
      </Typography>
      <DataTable
        rows={comparison.scores}
        columns={comparisonColumns}
        label="Change from the previous run"
        getRowId={row => row.key}
        testId="eval-sets-run-comparison-scores"
        onRetry={onRetry}
        minWidth="56rem"
        empty={<Typography level="body-sm">Neither run has scores.</Typography>}
      />
    </Stack>
  );
};

type RunRecall = EvalSetRun['report']['recall'];

const withheldMessage = (recall: RunRecall): string | null => {
  const minimum = count(recall.minimumReviewed || EVAL_SET_MIN_REVIEWED);
  if (recall.recallWithheld === 'too_few_unflagged_reviews') {
    return `Needs at least ${minimum} reviewed unflagged held-out examples; ${count(recall.unflaggedReviewed)} so far.`;
  }
  if (recall.recallWithheld === 'too_few_flagged_reviews') {
    return `Needs at least ${minimum} reviewed flagged held-out examples; ${count(recall.flaggedReviewed)} so far.`;
  }
  return null;
};

type Draft = { verdict: ShadowDetectionVerdict | null };

/** The latest evaluation-set verdict settles an example; insufficient evidence leaves it open. */
const hasConclusiveVerdict = (example: EvalSetExample) =>
  example.latestVerdict !== null && example.latestVerdict.verdict !== 'insufficient_evidence';

/**
 * Examples that drive the recall estimate (flagged and unflagged) without a conclusive
 * evaluation-set verdict first, then the other unlabelled ones.
 */
const reviewPriority = (window: EvalSetDetail['window']) => (example: EvalSetExample) => {
  if (countsTowardRecall(example, window) && !hasConclusiveVerdict(example)) return 0;
  return example.currentLabel === null ? 1 : 2;
};

const CreateForm: React.FC<{
  onCreated: (id: string) => void;
  nameRef: React.RefObject<HTMLInputElement | null>;
  primary: boolean;
}> = ({ onCreated, nameRef, primary }) => {
  const create = useCreateEvalSet();
  const missingPermission = useMissingAdminPermission('users:moderate');
  const [name, setName] = useState('');
  const [days, setDays] = useState<VerdictEvalWindowDays>(30);
  const [unflaggedSample, setUnflaggedSample] = useState(200);
  const [heldOutShare, setHeldOutShare] = useState(0.5);
  const valid =
    name.trim().length > 0 &&
    Number.isInteger(unflaggedSample) &&
    unflaggedSample >= EVAL_SET_UNFLAGGED_SAMPLE_MIN &&
    unflaggedSample <= EVAL_SET_UNFLAGGED_SAMPLE_MAX &&
    heldOutShare >= EVAL_SET_HELD_OUT_SHARE_MIN &&
    heldOutShare <= EVAL_SET_HELD_OUT_SHARE_MAX;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid || missingPermission) return;
    try {
      const id = await create.mutateAsync({ name: name.trim(), days, unflaggedSample, heldOutShare });
      setName('');
      onCreated(id);
    } catch {
      // Shown below from the mutation's error state.
    }
  };

  return (
    <form onSubmit={event => void submit(event)} data-testid="eval-sets-create-form">
      <Stack direction="row" gap={1} flexWrap="wrap" alignItems="flex-end">
        <FormControl sx={{ minWidth: 240 }}>
          <FormLabel>Name</FormLabel>
          <Input
            slotProps={{ input: { ref: nameRef, maxLength: 120, 'data-testid': 'eval-sets-name-input' } }}
            value={name}
            onChange={event => setName(event.target.value)}
          />
        </FormControl>
        <FormControl>
          <FormLabel>Window</FormLabel>
          <Select
            value={days}
            onChange={(_event, value) => value && setDays(value)}
            data-testid="eval-sets-window-select"
          >
            {VERDICT_EVAL_WINDOWS.map(option => (
              <Option key={option} value={option}>
                {option} days
              </Option>
            ))}
          </Select>
        </FormControl>
        <FormControl>
          <FormLabel>Unflagged sample</FormLabel>
          <Input
            type="number"
            value={unflaggedSample}
            onChange={event => setUnflaggedSample(Number(event.target.value))}
            slotProps={{
              input: {
                min: EVAL_SET_UNFLAGGED_SAMPLE_MIN,
                max: EVAL_SET_UNFLAGGED_SAMPLE_MAX,
                'data-testid': 'eval-sets-sample-input',
              },
            }}
          />
        </FormControl>
        <FormControl>
          <FormLabel>Held-out share</FormLabel>
          <Input
            type="number"
            value={heldOutShare}
            onChange={event => setHeldOutShare(Number(event.target.value))}
            slotProps={{
              input: {
                min: EVAL_SET_HELD_OUT_SHARE_MIN,
                max: EVAL_SET_HELD_OUT_SHARE_MAX,
                step: 0.1,
                'data-testid': 'eval-sets-share-input',
              },
            }}
          />
        </FormControl>
        <AdminPermissionAction requirement="users:moderate">
          {disabled => (
            <Button
              type="submit"
              variant={primary ? 'solid' : 'outlined'}
              loading={create.isPending}
              disabled={!valid || disabled}
              data-testid="eval-sets-create-btn"
            >
              Draw evaluation set
            </Button>
          )}
        </AdminPermissionAction>
      </Stack>
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted', mt: 0.5 }}>
        Needs a name, a sample of {EVAL_SET_UNFLAGGED_SAMPLE_MIN} to {EVAL_SET_UNFLAGGED_SAMPLE_MAX} and a held-out
        share of {EVAL_SET_HELD_OUT_SHARE_MIN} to {EVAL_SET_HELD_OUT_SHARE_MAX}.
      </Typography>
      {create.error && (
        <Alert color="danger" sx={{ mt: 1 }} data-testid="eval-sets-create-error">
          {getErrorMessage(create.error)}
        </Alert>
      )}
    </form>
  );
};

const RunReport: React.FC<{ run: EvalSetRun; previous: EvalSetRun | null; onRetry: () => void }> = ({
  run,
  previous,
  onRetry,
}) => {
  const { report } = run;
  const { recall } = report;
  const withheld = withheldMessage(recall);
  return (
    <Stack gap={2} data-testid="eval-sets-run">
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
        Run {formatUtc(run.ranAt)}
        {run.note ? `: ${run.note}` : ''}. {count(report.labelled)} of {count(report.examples)} held-out examples are
        labelled.
        {previous
          ? ` Changes are against the run of ${formatUtc(previous.ranAt)}.`
          : ' No earlier run to compare with.'}
      </Typography>
      <DataTable
        rows={report.scores}
        columns={scoreColumns(previous)}
        label="Run scores"
        getRowId={evalSetScoreKey}
        testId="eval-sets-run-scores"
        onRetry={onRetry}
        empty={<Typography level="body-sm">Label some held-out examples, then run again.</Typography>}
      />
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="eval-sets-scores-note">
        A run mixes every flagged account with a small unflagged sample, so hit rate and false positive rate are not
        reported here. Recall comes from the estimate below.
      </Typography>
      <StatStrip aria-label="Recall estimate">
        <StatTile
          label="Estimated recall"
          value={percent(recall.estimatedRecall)}
          comparison={
            withheld ??
            `${count(recall.flaggedReviewed)} flagged and ${count(recall.unflaggedReviewed)} unflagged held-out examples reviewed`
          }
        />
        <StatTile
          label="Estimated missed abuse"
          value={recall.estimatedMissedAbuse === null ? '-' : Math.round(recall.estimatedMissedAbuse).toLocaleString()}
          comparison={`${count(recall.unflaggedAbuse)} abuse in ${count(recall.unflaggedReviewed)} reviewed unflagged held-out examples, scaled to ${count(recall.unflaggedPopulation)} accounts`}
        />
        <StatTile
          label="Estimated flagged abuse"
          value={
            recall.estimatedFlaggedAbuse === null ? '-' : Math.round(recall.estimatedFlaggedAbuse).toLocaleString()
          }
          comparison={`${count(recall.flaggedAbuse)} abuse in ${count(recall.flaggedReviewed)} reviewed of ${count(recall.flaggedExamples)} flagged held-out examples, scaled to ${count(recall.flaggedPopulation)} accounts`}
        />
      </StatStrip>
      <DataTable
        rows={report.cohorts}
        columns={cohortColumns}
        label="Held-out cohorts"
        getRowId={row => row.cohort}
        testId="eval-sets-cohorts"
        onRetry={onRetry}
        empty={<Typography level="body-sm">No held-out cohorts.</Typography>}
      />
      <LabelSources labelSources={report.labelSources} />
      <Calibration calibration={report.calibration} onRetry={onRetry} />
      {previous && <RunComparison run={report} previous={previous} onRetry={onRetry} />}
    </Stack>
  );
};

type LabelDialogProps = {
  setId: string;
  example: EvalSetExample;
  onClose: () => void;
};

const LabelDialog: React.FC<LabelDialogProps> = ({ setId, example, onClose }) => {
  const mutation = useEvalSetVerdict(setId);
  const [draft, setDraft] = useState<Draft>({ verdict: null });
  const [conflict, setConflict] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async (reason: string) => {
    if (!draft.verdict || !isValidAdminActionReason(reason)) return;
    setConflict(null);
    setFailure(null);
    try {
      await mutation.mutateAsync({
        userId: example.userId,
        verdict: draft.verdict,
        reason,
        expectedRevision: example.revision,
      });
      onClose();
    } catch (error) {
      const message = getErrorMessage(error);
      if (isAxiosError(error) && error.response?.status === 409) {
        setConflict(`Account ${example.userId}: ${message} The list was reloaded.`);
        return;
      }
      setFailure(message);
    }
  };

  return (
    <ActionDialog
      open
      onClose={() => {
        if (!mutation.isPending) onClose();
      }}
      title="Label example"
      description="Records an evaluation-set verdict on this account. It changes nothing on the account. Every verdict stays in the history; to correct one, record another."
      reasonPresets={ADMIN_REASON_PRESETS.shadowDetectionVerdict}
      confirmLabel={draft.verdict ? `Record ${VERDICT_LABELS[draft.verdict].toLowerCase()}` : 'Record verdict'}
      blockedReason={draft.verdict ? null : 'Pick a verdict.'}
      pending={mutation.isPending}
      onConfirm={submit}
      data-testid="eval-sets-label-dialog"
    >
      <Stack gap={0.5}>
        <UserLink userId={example.userId} />
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          {example.latestVerdict
            ? `Latest verdict: ${VERDICT_LABELS[example.latestVerdict.verdict]}`
            : 'No evaluation-set verdict yet'}
        </Typography>
      </Stack>
      {conflict && (
        <Alert color="warning" data-testid="eval-sets-conflict">
          {conflict}
        </Alert>
      )}
      {failure && (
        <Alert color="danger" data-testid="eval-sets-verdict-error">
          {failure}
        </Alert>
      )}
      <FormControl>
        <FormLabel>Verdict</FormLabel>
        <RadioGroup
          name="eval-sets-verdict"
          value={draft.verdict ?? ''}
          onChange={event => setDraft({ verdict: event.target.value as ShadowDetectionVerdict })}
        >
          {SHADOW_DETECTION_VERDICTS.map(option => (
            <Radio
              key={option}
              value={option}
              label={VERDICT_LABELS[option]}
              slotProps={{ input: { 'data-testid': `eval-sets-verdict-option-${option}` } }}
            />
          ))}
        </RadioGroup>
      </FormControl>
    </ActionDialog>
  );
};

const latestVerdictCell = (example: EvalSetExample) => {
  const latest = example.latestVerdict;
  if (!latest) return '-';
  return (
    <Stack gap={0.25}>
      <Typography level="body-sm">
        {VERDICT_LABELS[latest.verdict]}, by {latest.reviewerId}, {formatUtc(latest.reviewedAt)}
      </Typography>
      {latest.verdict === 'insufficient_evidence' && (
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          Leaves the example unlabelled, overriding any label frozen at draw.
        </Typography>
      )}
    </Stack>
  );
};

const SetDetail: React.FC<{ summary: EvalSetSummary }> = ({ summary }) => {
  const detail = useEvalSet(summary.id);
  const run = useRunEvalSet(summary.id);
  const [labellingUserId, setLabellingUserId] = useState<string | null>(null);
  const [runNote, setRunNote] = useState('');
  const set: EvalSetDetail | undefined = detail.data;

  const startRun = async () => {
    try {
      await run.mutateAsync({ note: runNote.trim() || undefined });
      setRunNote('');
    } catch {
      // Shown below from the mutation's error state.
    }
  };

  const exampleColumns: readonly DataColumn<EvalSetExample>[] = [
    { id: 'user', label: 'Account', render: example => <UserLink userId={example.userId} /> },
    { id: 'kind', label: 'Flagged by a detector', render: example => (example.kind === 'flagged' ? 'Yes' : 'No') },
    { id: 'split', label: 'Split', render: example => (example.split === 'heldOut' ? 'Held out' : 'Tuning') },
    {
      id: 'cohorts',
      label: 'Cohorts',
      render: example => example.cohorts.map(cohort => COHORT_LABELS[cohort]).join(', ') || '-',
    },
    {
      id: 'label',
      label: 'Label',
      render: example =>
        example.currentLabel
          ? `${example.currentLabel.label} (${example.currentLabel.source === 'verdict' ? 'verdict' : 'frozen at draw'})`
          : 'Unlabelled',
    },
    { id: 'latest', label: 'Latest verdict (reviewer, time)', render: latestVerdictCell },
    {
      id: 'action',
      label: 'Label',
      render: example => (
        <AdminPermissionAction requirement="users:moderate">
          {disabled => (
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              disabled={disabled}
              onClick={() => setLabellingUserId(example.userId)}
              aria-label={`Label ${example.userId}`}
              data-testid={`eval-sets-label-btn-${example.userId}`}
            >
              {example.latestVerdict ? 'Change label' : 'Label'}
            </Button>
          )}
        </AdminPermissionAction>
      ),
    },
  ];

  const priorityOf = set ? reviewPriority(set.window) : null;
  const examples = set && priorityOf ? [...set.examples].sort((a, b) => priorityOf(a) - priorityOf(b)) : [];
  const labelling = set?.examples.find(example => example.userId === labellingUserId) ?? null;
  const [latest, previous] = set ? [set.runs.at(-1) ?? null, set.runs.length > 1 ? set.runs[0] : null] : [null, null];
  const heldOut = summary.heldOutExamples;
  const unflagged = summary.unflaggedExamples;
  const flaggedExamples = summary.examples - unflagged;

  return (
    <Stack gap={2} data-testid="eval-sets-detail">
      <Typography level="title-md" sx={{ color: 'admin.ink' }}>
        {summary.name}
      </Typography>
      <StatStrip aria-label="Evaluation set">
        <StatTile
          label="Accounts in window"
          value={count(summary.population.flagged + summary.population.unflagged)}
          comparison={`${count(summary.population.flagged)} flagged, ${count(summary.population.unflagged)} unflagged`}
        />
        <StatTile
          label="Sampled"
          value={count(summary.examples)}
          comparison={`${count(flaggedExamples)} flagged, ${count(unflagged)} of ${count(summary.population.unflagged)} unflagged`}
        />
        <StatTile
          label="Held out"
          value={count(heldOut)}
          comparison={`${count(summary.examples - heldOut)} tuning; whole campaigns share a split`}
        />
      </StatStrip>
      {summary.truncated && (
        <Alert color="warning" data-testid="eval-sets-truncated">
          The window held more accounts than one draw reads; the set covers part of it.
        </Alert>
      )}
      <Stack direction="row" gap={1} alignItems="flex-end" flexWrap="wrap">
        <FormControl sx={{ minWidth: 240 }}>
          <FormLabel>Run note (optional)</FormLabel>
          <Input
            value={runNote}
            onChange={event => setRunNote(event.target.value)}
            slotProps={{ input: { maxLength: 500, 'data-testid': 'eval-sets-run-note-input' } }}
          />
        </FormControl>
        <AdminPermissionAction requirement="users:moderate">
          {disabled => (
            <Button
              loading={run.isPending}
              disabled={disabled}
              onClick={() => void startRun()}
              data-testid="eval-sets-run-btn"
            >
              Run on held-out examples
            </Button>
          )}
        </AdminPermissionAction>
      </Stack>
      {run.error && (
        <Alert color="danger" data-testid="eval-sets-run-error">
          {getErrorMessage(run.error)}
        </Alert>
      )}
      {set && set.unreadableRunCount > 0 && (
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="eval-sets-unreadable-runs">
          {count(set.unreadableRunCount)} stored {set.unreadableRunCount === 1 ? 'run' : 'runs'} could not be read.
        </Typography>
      )}
      {latest ? (
        <RunReport run={latest} previous={previous} onRetry={() => void detail.refetch()} />
      ) : (
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="eval-sets-no-run">
          Not run yet. A run grades the automated verdicts on the held-out examples as they stand now.
        </Typography>
      )}
      <DataTable
        rows={examples}
        columns={exampleColumns}
        label="Examples"
        getRowId={example => example.userId}
        loading={detail.isPending}
        error={detail.error ? "Couldn't load the evaluation set." : undefined}
        onRetry={() => void detail.refetch()}
        testId="eval-sets-examples"
        pageResetKey={summary.id}
        minWidth="64rem"
      />
      {labelling && (
        <LabelDialog
          key={labelling.userId}
          setId={summary.id}
          example={labelling}
          onClose={() => setLabellingUserId(null)}
        />
      )}
    </Stack>
  );
};

/**
 * Frozen evaluation sets: draw one from a window, label the unflagged sample, and run the automated
 * verdicts against its held-out examples to estimate precision and recall. Shadow mode: nothing here
 * acts on an account.
 */
export const VerdictEvalSetsPanel: React.FC = () => {
  const sets = useEvalSets();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const selected = sets.data?.find(set => set.id === selectedId) ?? null;

  return (
    <Stack gap={2} data-testid="eval-sets-panel">
      <Typography level="title-md" sx={{ color: 'admin.ink' }}>
        Evaluation sets
      </Typography>
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
        A frozen set holds every flagged account in a window plus a random sample of accounts no detector flagged.
        Linked accounts share a split, so tuning never sees a campaign the held-out examples are graded on. Recall
        counts only verdicts given here, on both the flagged and the unflagged held-out examples.
      </Typography>
      <CreateForm onCreated={setSelectedId} nameRef={nameRef} primary={selected === null} />
      <DataTable
        rows={sets.data ?? []}
        columns={setColumns}
        label="Evaluation sets"
        getRowId={set => set.id}
        loading={sets.isPending}
        error={sets.error ? "Couldn't load the evaluation sets." : undefined}
        onRetry={() => void sets.refetch()}
        onRowActivate={set => setSelectedId(set.id)}
        activeRowId={selectedId ?? undefined}
        testId="eval-sets-table"
        empty={
          <EmptyState
            title="No evaluation sets yet"
            description="Draw one to measure precision and recall on accounts held out from tuning."
            action={
              <Button variant="outlined" onClick={() => nameRef.current?.focus()} data-testid="eval-sets-empty-btn">
                Name a set
              </Button>
            }
          />
        }
      />
      {selected && <SetDetail key={selected.id} summary={selected} />}
    </Stack>
  );
};
