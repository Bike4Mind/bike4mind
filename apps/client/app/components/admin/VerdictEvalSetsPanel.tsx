import React, { useRef, useState } from 'react';
import { Alert, Button, FormControl, FormLabel, Input, Option, Select, Stack, Typography } from '@mui/joy';
import { SHADOW_DETECTION_VERDICTS, type ShadowDetectionVerdict } from '@bike4mind/common';
import { Link } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import {
  useCreateEvalSet,
  useEvalSet,
  useEvalSets,
  useEvalSetVerdict,
  useRunEvalSet,
} from '@client/app/hooks/data/verdictEvalSets';
import {
  EVAL_SET_HELD_OUT_SHARE_MAX,
  EVAL_SET_HELD_OUT_SHARE_MIN,
  EVAL_SET_UNFLAGGED_SAMPLE_MAX,
  EVAL_SET_UNFLAGGED_SAMPLE_MIN,
  type EvalSetDetail,
  type EvalSetExample,
  type EvalSetRun,
  type EvalSetScore,
  type EvalSetSummary,
} from '@client/app/utils/verdictEvalSets';
import {
  VERDICT_EVAL_WINDOWS,
  type EvalCohort,
  type VerdictEvalCohortRow,
  type VerdictEvalGrader,
  type VerdictEvalWindowDays,
} from '@client/app/utils/verdictEval';
import { DataTable, EmptyState, StatStrip, StatTile, formatUtc, type DataColumn } from './shared';

const GRADER_LABELS: Record<VerdictEvalGrader, string> = {
  assessment: 'AI assessment',
  containment: 'Auto-containment',
  signupVerdict: 'Signup verdict',
  detectors: 'Detectors',
};

const COHORT_LABELS: Record<EvalCohort, string> = {
  mobile: 'Mobile or tablet',
  sharedNetwork: 'Shared signup network',
  apiAgent: 'API, agent or CLI use',
  assistive: 'Assistive technology',
};

const VERDICT_LABELS: Record<ShadowDetectionVerdict, string> = {
  confirmed_abuse: 'Confirmed abuse',
  legitimate_human: 'Legitimate human',
  legitimate_automation: 'Legitimate automation',
  insufficient_evidence: 'Insufficient evidence',
};

const STALE_MESSAGE = 'Someone else labelled that account first. The set was reloaded; review it again.';

const count = (value: number) => value.toLocaleString();
const percent = (value: number | null) => (value === null ? '-' : `${Math.round(value * 100)}%`);

/** Percentage points from the previous run, signed; a dash when either run has no value. */
const delta = (current: number | null, previous: number | null | undefined) =>
  current === null || previous === null || previous === undefined
    ? ''
    : ` (${current - previous >= 0 ? '+' : ''}${Math.round((current - previous) * 100)} pts)`;

const scoreKey = (score: EvalSetScore) => `${score.grader}-${score.variant}`;

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
    previous?.report.scores.find(candidate => scoreKey(candidate) === scoreKey(score));
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
      id: 'precision',
      label: 'Precision (95% lower bound)',
      render: score =>
        score.precision === null
          ? '-'
          : `${percent(score.precision)} (${percent(score.precisionLowerBound)})${delta(score.precision, before(score)?.precision)}`,
      numeric: true,
    },
    {
      id: 'hit',
      label: 'Hit rate (of abuse)',
      render: score =>
        score.hitRate === null
          ? '-'
          : `${percent(score.hitRate)} of ${count(score.truePositive + score.falseNegative)}${delta(score.hitRate, before(score)?.hitRate)}`,
      numeric: true,
    },
    {
      id: 'fpr',
      label: 'False positive rate (of legit)',
      render: score =>
        score.falsePositiveRate === null
          ? '-'
          : `${percent(score.falsePositiveRate)} of ${count(score.falsePositive + score.trueNegative)}${delta(score.falsePositiveRate, before(score)?.falsePositiveRate)}`,
      numeric: true,
    },
  ];
}

type Draft = { verdict: ShadowDetectionVerdict | null; reason: string };
const EMPTY_DRAFT: Draft = { verdict: null, reason: '' };

/** Unlabelled accounts nobody flagged first: they decide the recall estimate. */
const reviewPriority = (example: EvalSetExample) =>
  example.currentLabel === null ? (example.kind === 'unflagged' ? 0 : 1) : 2;

const CreateForm: React.FC<{ onCreated: (id: string) => void; nameRef: React.RefObject<HTMLInputElement | null> }> = ({
  onCreated,
  nameRef,
}) => {
  const create = useCreateEvalSet();
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
    if (!valid) return;
    const id = await create.mutateAsync({ name: name.trim(), days, unflaggedSample, heldOutShare });
    setName('');
    onCreated(id);
  };

  return (
    <form onSubmit={event => void submit(event)} data-testid="eval-sets-create-form">
      <Stack direction="row" gap={1} flexWrap="wrap" alignItems="flex-end">
        <FormControl sx={{ minWidth: 240 }}>
          <FormLabel>Name</FormLabel>
          <Input
            slotProps={{ input: { ref: nameRef, 'data-testid': 'eval-sets-name-input' } }}
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
        <Button type="submit" loading={create.isPending} disabled={!valid} data-testid="eval-sets-create-btn">
          Draw evaluation set
        </Button>
      </Stack>
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted', mt: 0.5 }}>
        Needs a name, a sample of {EVAL_SET_UNFLAGGED_SAMPLE_MIN} to {EVAL_SET_UNFLAGGED_SAMPLE_MAX} and a held-out
        share of {EVAL_SET_HELD_OUT_SHARE_MIN} to {EVAL_SET_HELD_OUT_SHARE_MAX}.
      </Typography>
      {create.error && (
        <Alert color="danger" sx={{ mt: 1 }} data-testid="eval-sets-create-error">
          Couldn&apos;t draw the set.
        </Alert>
      )}
    </form>
  );
};

const RunReport: React.FC<{ run: EvalSetRun; previous: EvalSetRun | null }> = ({ run, previous }) => {
  const { report } = run;
  const { recall } = report;
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
        getRowId={scoreKey}
        testId="eval-sets-run-scores"
        onRetry={() => undefined}
        empty={<Typography level="body-sm">Label some held-out examples, then run again.</Typography>}
      />
      <StatStrip aria-label="Recall estimate">
        <StatTile
          label="Estimated recall"
          value={percent(recall.estimatedRecall)}
          comparison={`${count(recall.flaggedAbuse)} flagged abuse in the held-out half`}
        />
        <StatTile
          label="Estimated missed abuse"
          value={recall.estimatedMissedAbuse === null ? '-' : recall.estimatedMissedAbuse.toLocaleString()}
          comparison={`${count(recall.sampledUnflaggedAbuse)} abuse in ${count(recall.sampledUnflagged)} labelled unflagged, scaled to ${count(recall.unflaggedPopulation)} accounts`}
        />
      </StatStrip>
      <DataTable
        rows={report.cohorts}
        columns={cohortColumns}
        label="Held-out cohorts"
        getRowId={row => row.cohort}
        testId="eval-sets-cohorts"
        onRetry={() => undefined}
      />
    </Stack>
  );
};

const SetDetail: React.FC<{ summary: EvalSetSummary }> = ({ summary }) => {
  const detail = useEvalSet(summary.id);
  const verdict = useEvalSetVerdict(summary.id);
  const run = useRunEvalSet(summary.id);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [stale, setStale] = useState(false);
  const [runNote, setRunNote] = useState('');
  const set: EvalSetDetail | undefined = detail.data;

  const draftOf = (userId: string) => drafts[userId] ?? EMPTY_DRAFT;
  const setDraft = (userId: string, next: Partial<Draft>) =>
    setDrafts(current => ({ ...current, [userId]: { ...(current[userId] ?? EMPTY_DRAFT), ...next } }));

  const submitVerdict = async (example: EvalSetExample) => {
    const draft = draftOf(example.userId);
    if (!draft.verdict || draft.reason.trim().length === 0) return;
    setStale(false);
    try {
      await verdict.mutateAsync({
        userId: example.userId,
        verdict: draft.verdict,
        reason: draft.reason.trim(),
        expectedRevision: example.revision,
      });
      setDrafts(current => ({ ...current, [example.userId]: EMPTY_DRAFT }));
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 409) setStale(true);
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
    {
      id: 'verdict',
      label: 'Label this account (verdict and a reason)',
      render: example => {
        const draft = draftOf(example.userId);
        return (
          <Stack direction="row" gap={1} alignItems="center" data-testid={`eval-sets-verdict-form-${example.userId}`}>
            <Select
              size="sm"
              placeholder="Verdict"
              value={draft.verdict}
              onChange={(_event, value) => setDraft(example.userId, { verdict: value })}
              slotProps={{ button: { 'aria-label': `Verdict for ${example.userId}` } }}
              data-testid={`eval-sets-verdict-select-${example.userId}`}
            >
              {SHADOW_DETECTION_VERDICTS.map(option => (
                <Option key={option} value={option}>
                  {VERDICT_LABELS[option]}
                </Option>
              ))}
            </Select>
            <Input
              size="sm"
              placeholder="Reason (required)"
              value={draft.reason}
              onChange={event => setDraft(example.userId, { reason: event.target.value })}
              slotProps={{
                input: {
                  maxLength: 500,
                  'aria-label': `Reason for ${example.userId}`,
                  'data-testid': `eval-sets-reason-input-${example.userId}`,
                },
              }}
            />
            <Button
              size="sm"
              variant="outlined"
              disabled={!draft.verdict || draft.reason.trim().length === 0}
              loading={verdict.isPending && verdict.variables?.userId === example.userId}
              onClick={() => void submitVerdict(example)}
              data-testid={`eval-sets-verdict-btn-${example.userId}`}
            >
              Save label
            </Button>
          </Stack>
        );
      },
    },
  ];

  const examples = set ? [...set.examples].sort((a, b) => reviewPriority(a) - reviewPriority(b)) : [];
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
        <Button
          loading={run.isPending}
          onClick={() => void run.mutateAsync({ note: runNote.trim() || undefined }).then(() => setRunNote(''))}
          data-testid="eval-sets-run-btn"
        >
          Run on held-out examples
        </Button>
      </Stack>
      {run.error && (
        <Alert color="danger" data-testid="eval-sets-run-error">
          Couldn&apos;t run the set.
        </Alert>
      )}
      {latest ? (
        <RunReport run={latest} previous={previous} />
      ) : (
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="eval-sets-no-run">
          Not run yet. A run grades the automated verdicts on the held-out examples as they stand now.
        </Typography>
      )}
      {stale && (
        <Alert color="warning" data-testid="eval-sets-conflict">
          {STALE_MESSAGE}
        </Alert>
      )}
      {verdict.error && !stale && (
        <Alert color="danger" data-testid="eval-sets-verdict-error">
          Couldn&apos;t save the label.
        </Alert>
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
    </Stack>
  );
};

/**
 * Frozen evaluation sets: draw one from a window, label the unflagged sample, and run the automated
 * verdicts against its held-out half to estimate precision and recall. Shadow mode: nothing here acts
 * on an account.
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
        Linked accounts share a split, so tuning never sees a campaign the held-out half is graded on. Labelling the
        unflagged sample is what makes recall measurable.
      </Typography>
      <CreateForm onCreated={setSelectedId} nameRef={nameRef} />
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
