import React, { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Option,
  Select,
  Stack,
  Textarea,
  Typography,
} from '@mui/joy';
import type {
  IDataLakeResearchConfigDocument,
  IDataLakeResearchRunDocument,
  ResearchRunTotals,
} from '@bike4mind/common';
import {
  isResearchRunInFlight,
  RESEARCH_CONFIG_NAME_MAX_CHARS,
  RESEARCH_CONFIG_QUERY_MAX_CHARS,
  RESEARCH_COST_CEILING_MICRO_USD_DEFAULT,
  RESEARCH_COST_CEILING_MICRO_USD_LIMIT,
  RESEARCH_MAX_PROPOSALS_DEFAULT,
  RESEARCH_MAX_PROPOSALS_LIMIT,
  RESEARCH_MAX_RESULTS_DEFAULT,
  RESEARCH_MAX_RESULTS_LIMIT,
  RESEARCH_MIN_RELEVANCE_DEFAULT,
  RESEARCH_RECENCY_DAYS_LIMIT,
} from '@bike4mind/common';
import type { ResearchConfigInput } from '@client/app/hooks/data/dataLakes';

/** One selectable relevance-judge model, projected from the model catalog by the caller. */
export interface ResearchModelOption {
  id: string;
  name: string;
}

export interface DataLakeResearchPanelProps {
  configs: IDataLakeResearchConfigDocument[] | undefined;
  runs: IDataLakeResearchRunDocument[] | undefined;
  isLoading: boolean;
  error: unknown;
  modelOptions: ResearchModelOption[];
  isCreating?: boolean;
  /** The config a save, delete or start is in flight for, so only its own row shows busy. */
  savingConfigId?: string | null;
  deletingConfigId?: string | null;
  startingConfigId?: string | null;
  onCreate: (input: ResearchConfigInput) => void;
  onUpdate: (configId: string, input: ResearchConfigInput) => void;
  onDelete: (configId: string) => void;
  onStartRun: (configId: string) => void;
}

/** Every field a string, because that is what a form holds; conversion happens once, at submit. */
interface ConfigDraft {
  name: string;
  query: string;
  model: string;
  maxResults: string;
  maxProposals: string;
  recencyDays: string;
  minRelevance: string;
  costCeilingUsd: string;
  allowedDomains: string;
  blockedDomains: string;
  proposedTags: string;
}

const microUsdToUsdInput = (micro: number): string => (micro / 1_000_000).toFixed(2);

/** Spend is routinely a fraction of a cent, so two decimals would render every run as $0.00. */
const formatSpend = (micro: number): string => `$${(micro / 1_000_000).toFixed(4)}`;

const emptyDraft = (): ConfigDraft => ({
  name: '',
  query: '',
  model: '',
  // Seeded from the shared constants rather than hardcoded, so the form's idea of a default and the
  // normalizer's can never drift apart.
  maxResults: String(RESEARCH_MAX_RESULTS_DEFAULT),
  maxProposals: String(RESEARCH_MAX_PROPOSALS_DEFAULT),
  recencyDays: '',
  minRelevance: String(RESEARCH_MIN_RELEVANCE_DEFAULT),
  costCeilingUsd: microUsdToUsdInput(RESEARCH_COST_CEILING_MICRO_USD_DEFAULT),
  allowedDomains: '',
  blockedDomains: '',
  proposedTags: '',
});

const draftFromConfig = (config: IDataLakeResearchConfigDocument): ConfigDraft => ({
  name: config.name,
  query: config.query,
  model: config.model ?? '',
  maxResults: String(config.maxResults),
  maxProposals: String(config.maxProposals),
  recencyDays: config.recencyDays == null ? '' : String(config.recencyDays),
  minRelevance: String(config.minRelevance),
  costCeilingUsd: microUsdToUsdInput(config.costCeilingMicroUsd),
  allowedDomains: config.allowedDomains.join('\n'),
  blockedDomains: config.blockedDomains.join('\n'),
  proposedTags: config.proposedTags.join(', '),
});

const parseList = (value: string): string[] =>
  value
    .split(/[\n,]/)
    .map(entry => entry.trim())
    .filter(Boolean);

/** Blank means "unset", which for a nullable lever is null (clear it) and never 0. */
const parseNullableNumber = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Blank falls back to the shared default rather than sending NaN at the server - and blank has to
 * be tested BEFORE `Number`, because `Number('')` is 0 and 0 is finite. The server clamps rather
 * than rejects, so a cleared field would otherwise submit a silently wrong lever: 0 relevance is
 * "propose everything", the opposite of what clearing that field reaches for, and a 0 ceiling
 * clamps to 1 micro-USD and stops the run having judged nothing.
 */
const parseNumber = (value: string, fallback: number): number => {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const draftToInput = (draft: ConfigDraft): ResearchConfigInput => ({
  name: draft.name.trim(),
  query: draft.query.trim(),
  model: draft.model.trim() || null,
  maxResults: parseNumber(draft.maxResults, RESEARCH_MAX_RESULTS_DEFAULT),
  maxProposals: parseNumber(draft.maxProposals, RESEARCH_MAX_PROPOSALS_DEFAULT),
  recencyDays: parseNullableNumber(draft.recencyDays),
  minRelevance: parseNumber(draft.minRelevance, RESEARCH_MIN_RELEVANCE_DEFAULT),
  costCeilingMicroUsd: Math.round(
    parseNumber(draft.costCeilingUsd, RESEARCH_COST_CEILING_MICRO_USD_DEFAULT / 1_000_000) * 1_000_000
  ),
  allowedDomains: parseList(draft.allowedDomains),
  blockedDomains: parseList(draft.blockedDomains),
  proposedTags: parseList(draft.proposedTags),
});

const RUN_STATUS_COLOR = {
  queued: 'neutral',
  running: 'primary',
  completed: 'success',
  failed: 'danger',
  /** Not a stored status - see `runStateLabel`. Warning, not danger: nothing was lost, it stopped. */
  abandoned: 'warning',
} as const;

/**
 * Why a run stopped early, in the reviewer's terms. A stop reason is not a failure - it is the
 * lever that fired, and naming the lever is what makes it obvious which one to raise.
 */
const STOP_REASON_LABEL = {
  exhausted: 'Reviewed every search result',
  cost_ceiling: 'Stopped at the cost ceiling',
  proposal_limit: 'Reached the proposal limit',
  time_budget: 'Stopped at the time budget',
} as const;

const formatWhen = (value: Date | string | null | undefined): string => {
  if (!value) return 'not yet';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleString();
};

/**
 * How a run's state reads on its card. `abandoned` is not a stored status: it is a non-terminal row
 * past the stale bound, which nothing will ever settle, so reporting it as `running` would promise
 * work that is not happening. The server already ignores these rows when it counts active runs.
 */
const runStateLabel = (run: IDataLakeResearchRunDocument): keyof typeof RUN_STATUS_COLOR =>
  run.status !== 'completed' && run.status !== 'failed' && !isResearchRunInFlight(run) ? 'abandoned' : run.status;

/**
 * Why every hit that was NOT proposed was dropped, in the order a reader asks about them: cheapest
 * rejection first. Keyed by `ResearchRunTotals` minus the two counts that are not drops, so adding a
 * new drop bucket to the shared type fails THIS file to compile rather than silently vanishing from
 * the only place a manager can see it.
 */
const DROP_REASON_LABEL: Record<Exclude<keyof ResearchRunTotals, 'searchHits' | 'proposed'>, string> = {
  filteredBySource: 'blocked by source rules',
  belowRelevance: 'below the relevance floor',
  judgeFailed: 'could not be judged (the model was unreachable)',
  alreadyInLake: 'already in the lake',
  duplicatePending: 'already awaiting review',
  suppressedByTombstone: 'previously declined',
  unusableSource: 'unusable source',
  fetchFailed: 'could not be fetched',
};

/**
 * Which saved configuration produced this run. A lake can hold twenty of them, so a history that
 * only says "completed" cannot be read at all. Falls back to the query SNAPSHOTTED on the run rather
 * than the live config's: a config is editable and deletable, and the point of the history is what
 * actually ran.
 */
const runConfigLabel = (
  run: IDataLakeResearchRunDocument,
  configById: Map<string, IDataLakeResearchConfigDocument>
): string => configById.get(run.configId)?.name || run.levers.query || 'Deleted configuration';

/**
 * The one-line account of where a finished run's search hits went. Only non-zero buckets are
 * listed: a run that proposed 3 of 10 hits should say WHICH filter ate the other 7, and padding
 * the line with seven zeroes is how that gets lost.
 */
const runOutcomeSummary = (run: IDataLakeResearchRunDocument): string => {
  const { totals } = run;
  const parts: string[] = [`${totals.searchHits} found`, `${totals.proposed} proposed`];
  for (const [key, label] of Object.entries(DROP_REASON_LABEL)) {
    const count = totals[key as keyof ResearchRunTotals];
    if (count > 0) parts.push(`${count} ${label}`);
  }
  return parts.join(' \u00b7 ');
};

/**
 * The Research tab (#1682): a lake's saved run configurations, and the history of what they did.
 *
 * Every value on the form is a lever the run provably reads - there are no constants hidden behind
 * this UI. Running one proposes sources into the review queue and writes nothing to the lake; a
 * human still approves each proposal on the Proposals tab, which is the whole point of the split.
 *
 * Pure/presentational - all data and mutations arrive via props - so it needs no
 * QueryClientProvider in tests.
 */
export function DataLakeResearchPanel({
  configs,
  runs,
  isLoading,
  error,
  modelOptions,
  isCreating,
  savingConfigId,
  deletingConfigId,
  startingConfigId,
  onCreate,
  onUpdate,
  onDelete,
  onStartRun,
}: DataLakeResearchPanelProps) {
  // null = the form is closed; '' = creating; an id = editing that config.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ConfigDraft>(emptyDraft);

  // Age-bounded on purpose: this mirrors the server's own active-run count, so the button unlocks
  // for exactly the lakes a POST would be accepted for rather than staying dead on an abandoned row.
  const runInFlight = useMemo(() => (runs ?? []).some(run => isResearchRunInFlight(run)), [runs]);
  const configById = useMemo(() => new Map((configs ?? []).map(config => [config.id, config])), [configs]);
  const setField = (field: keyof ConfigDraft) => (value: string) => setDraft(prev => ({ ...prev, [field]: value }));

  const openCreate = () => {
    setDraft(emptyDraft());
    setEditingId('');
  };
  const openEdit = (config: IDataLakeResearchConfigDocument) => {
    setDraft(draftFromConfig(config));
    setEditingId(config.id);
  };
  const closeForm = () => setEditingId(null);

  const submit = () => {
    const input = draftToInput(draft);
    if (editingId) onUpdate(editingId, input);
    else onCreate(input);
    // Closed optimistically: the mutation toasts its own refusal, and leaving the form open on
    // success would look like the save had not registered.
    closeForm();
  };

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }} data-testid="datalake-research-loading">
        <CircularProgress size="sm" />
      </Box>
    );
  }

  if (error) {
    return (
      <Alert color="danger" size="sm" data-testid="datalake-research-error">
        Could not load research configurations for this data lake. Try again shortly.
      </Alert>
    );
  }

  const formOpen = editingId !== null;
  const saveBusy = editingId ? savingConfigId === editingId : !!isCreating;

  return (
    <Stack spacing={2} data-testid="datalake-research-panel">
      <Typography level="body-xs" textColor="text.tertiary" data-testid="datalake-research-help">
        A research run searches the web with the settings below and puts what it finds in the Proposals queue. Nothing
        reaches this lake until you approve it.
      </Typography>

      {!configs?.length && !formOpen && (
        <Stack spacing={1} data-testid="datalake-research-empty">
          <Typography level="body-sm">No research configurations yet.</Typography>
          <Typography level="body-xs" textColor="text.tertiary">
            Save one to describe what this lake should be looking for, then run it whenever you want fresh material.
          </Typography>
        </Stack>
      )}

      {configs?.map(config => {
        const busy = savingConfigId === config.id || deletingConfigId === config.id;
        return (
          <Box
            key={config.id}
            data-testid="datalake-research-config-row"
            sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 'sm', p: 1.5 }}
          >
            <Stack spacing={1}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <Typography level="title-sm" sx={{ flex: 1, minWidth: '10rem' }}>
                  {config.name}
                </Typography>
                <Chip size="sm" variant="soft" data-testid="datalake-research-config-limits">
                  {`Up to ${config.maxProposals} proposals \u00b7 ${formatSpend(config.costCeilingMicroUsd)} ceiling`}
                </Chip>
              </Stack>
              <Typography level="body-xs" sx={{ whiteSpace: 'pre-wrap' }} data-testid="datalake-research-config-query">
                {config.query}
              </Typography>
              <Typography level="body-xs" textColor="text.tertiary">
                {`Last run ${formatWhen(config.lastRunAt)}`}
              </Typography>
              <Stack direction="row" spacing={1}>
                <Button
                  size="sm"
                  color="primary"
                  loading={startingConfigId === config.id}
                  // A lake runs one at a time - the server refuses a second, so the button says so
                  // rather than letting a click earn a refusal toast.
                  disabled={busy || runInFlight}
                  onClick={() => onStartRun(config.id)}
                  data-testid="datalake-research-run-btn"
                >
                  {runInFlight ? 'Run in progress' : 'Run now'}
                </Button>
                <Button
                  size="sm"
                  variant="outlined"
                  color="neutral"
                  disabled={busy}
                  onClick={() => openEdit(config)}
                  data-testid="datalake-research-edit-btn"
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="plain"
                  color="danger"
                  loading={deletingConfigId === config.id}
                  onClick={() => onDelete(config.id)}
                  data-testid="datalake-research-delete-btn"
                >
                  Delete
                </Button>
              </Stack>
            </Stack>
          </Box>
        );
      })}

      {formOpen ? (
        <Box
          data-testid="datalake-research-form"
          sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 'sm', p: 1.5 }}
        >
          <Stack spacing={1.5}>
            <FormControl size="sm">
              <FormLabel>Name</FormLabel>
              <Input
                value={draft.name}
                onChange={e => setField('name')(e.target.value)}
                slotProps={{
                  input: { 'data-testid': 'datalake-research-name-input', maxLength: RESEARCH_CONFIG_NAME_MAX_CHARS },
                }}
              />
            </FormControl>

            <FormControl size="sm">
              <FormLabel>What to look for</FormLabel>
              <Textarea
                minRows={2}
                value={draft.query}
                onChange={e => setField('query')(e.target.value)}
                slotProps={{
                  textarea: {
                    'data-testid': 'datalake-research-query-input',
                    maxLength: RESEARCH_CONFIG_QUERY_MAX_CHARS,
                  },
                }}
              />
              <FormHelperText>
                Used both as the web search and as the question each result is judged against.
              </FormHelperText>
            </FormControl>

            <FormControl size="sm">
              <FormLabel>Relevance model</FormLabel>
              <Select
                value={draft.model}
                onChange={(_e, value) => setField('model')(value ?? '')}
                slotProps={{ button: { 'data-testid': 'datalake-research-model-select' } }}
              >
                <Option value="">Default</Option>
                {modelOptions.map(option => (
                  <Option key={option.id} value={option.id}>
                    {option.name}
                  </Option>
                ))}
              </Select>
              <FormHelperText>
                Judges each search result before it is fetched. A cheaper model costs less per run and reads less
                carefully.
              </FormHelperText>
            </FormControl>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <FormControl size="sm" sx={{ flex: 1 }}>
                <FormLabel>Search results</FormLabel>
                <Input
                  type="number"
                  value={draft.maxResults}
                  onChange={e => setField('maxResults')(e.target.value)}
                  slotProps={{
                    input: {
                      'data-testid': 'datalake-research-max-results-input',
                      min: 1,
                      max: RESEARCH_MAX_RESULTS_LIMIT,
                    },
                  }}
                />
                <FormHelperText>{`Up to ${RESEARCH_MAX_RESULTS_LIMIT}`}</FormHelperText>
              </FormControl>

              <FormControl size="sm" sx={{ flex: 1 }}>
                <FormLabel>Proposals per run</FormLabel>
                <Input
                  type="number"
                  value={draft.maxProposals}
                  onChange={e => setField('maxProposals')(e.target.value)}
                  slotProps={{
                    input: {
                      'data-testid': 'datalake-research-max-proposals-input',
                      min: 1,
                      max: RESEARCH_MAX_PROPOSALS_LIMIT,
                    },
                  }}
                />
                <FormHelperText>{`Up to ${RESEARCH_MAX_PROPOSALS_LIMIT}`}</FormHelperText>
              </FormControl>
            </Stack>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <FormControl size="sm" sx={{ flex: 1 }}>
                <FormLabel>Only results from the last</FormLabel>
                <Input
                  type="number"
                  placeholder="Any age"
                  value={draft.recencyDays}
                  onChange={e => setField('recencyDays')(e.target.value)}
                  endDecorator="days"
                  slotProps={{
                    input: {
                      'data-testid': 'datalake-research-recency-input',
                      min: 1,
                      max: RESEARCH_RECENCY_DAYS_LIMIT,
                    },
                  }}
                />
                <FormHelperText>Leave blank for no recency limit.</FormHelperText>
              </FormControl>

              <FormControl size="sm" sx={{ flex: 1 }}>
                <FormLabel>Minimum relevance</FormLabel>
                <Input
                  type="number"
                  value={draft.minRelevance}
                  onChange={e => setField('minRelevance')(e.target.value)}
                  slotProps={{
                    input: { 'data-testid': 'datalake-research-min-relevance-input', min: 0, max: 1, step: 0.05 },
                  }}
                />
                <FormHelperText>0 to 1. Below this, a result is never fetched or proposed.</FormHelperText>
              </FormControl>
            </Stack>

            <FormControl size="sm">
              <FormLabel>Cost ceiling</FormLabel>
              <Input
                type="number"
                value={draft.costCeilingUsd}
                onChange={e => setField('costCeilingUsd')(e.target.value)}
                startDecorator="$"
                slotProps={{
                  input: {
                    'data-testid': 'datalake-research-cost-ceiling-input',
                    min: 0,
                    max: RESEARCH_COST_CEILING_MICRO_USD_LIMIT / 1_000_000,
                    step: 0.01,
                  },
                }}
              />
              <FormHelperText>
                {`Judgement spend for one run. The run stops when it would exceed this. Maximum $${microUsdToUsdInput(
                  RESEARCH_COST_CEILING_MICRO_USD_LIMIT
                )}.`}
              </FormHelperText>
            </FormControl>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <FormControl size="sm" sx={{ flex: 1 }}>
                <FormLabel>Only these sites</FormLabel>
                <Textarea
                  minRows={2}
                  placeholder="example.com"
                  value={draft.allowedDomains}
                  onChange={e => setField('allowedDomains')(e.target.value)}
                  slotProps={{ textarea: { 'data-testid': 'datalake-research-allowed-input' } }}
                />
                <FormHelperText>One per line. Leave blank to allow any site.</FormHelperText>
              </FormControl>

              <FormControl size="sm" sx={{ flex: 1 }}>
                <FormLabel>Never these sites</FormLabel>
                <Textarea
                  minRows={2}
                  placeholder="example.net"
                  value={draft.blockedDomains}
                  onChange={e => setField('blockedDomains')(e.target.value)}
                  slotProps={{ textarea: { 'data-testid': 'datalake-research-blocked-input' } }}
                />
                <FormHelperText>Applied after the allow list, and wins over it.</FormHelperText>
              </FormControl>
            </Stack>

            <FormControl size="sm">
              <FormLabel>Tags to propose</FormLabel>
              <Input
                placeholder="research, weekly"
                value={draft.proposedTags}
                onChange={e => setField('proposedTags')(e.target.value)}
                slotProps={{ input: { 'data-testid': 'datalake-research-tags-input' } }}
              />
              <FormHelperText>Suggested on each proposal. You can still change them when you approve.</FormHelperText>
            </FormControl>

            <Stack direction="row" spacing={1}>
              <Button
                size="sm"
                color="primary"
                loading={saveBusy}
                disabled={!draft.name.trim() || !draft.query.trim()}
                onClick={submit}
                data-testid="datalake-research-save-btn"
              >
                {editingId ? 'Save changes' : 'Save configuration'}
              </Button>
              <Button
                size="sm"
                variant="plain"
                color="neutral"
                onClick={closeForm}
                data-testid="datalake-research-cancel-btn"
              >
                Cancel
              </Button>
            </Stack>
          </Stack>
        </Box>
      ) : (
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          onClick={openCreate}
          sx={{ alignSelf: 'flex-start' }}
          data-testid="datalake-research-new-btn"
        >
          New configuration
        </Button>
      )}

      {!!runs?.length && (
        <>
          <Divider />
          <Typography level="title-sm">Recent runs</Typography>
          {runs.map(run => (
            <Box key={run.id} data-testid="datalake-research-run-row">
              <Stack spacing={0.5}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <Chip
                    size="sm"
                    color={RUN_STATUS_COLOR[runStateLabel(run)]}
                    data-testid="datalake-research-run-status"
                  >
                    {runStateLabel(run)}
                  </Chip>
                  <Typography level="body-xs" data-testid="datalake-research-run-config">
                    {runConfigLabel(run, configById)}
                  </Typography>
                  <Typography level="body-xs" textColor="text.tertiary">
                    {`${formatWhen(run.startedAt ?? run.createdAt)} \u00b7 ${formatSpend(run.spentMicroUsd)}`}
                  </Typography>
                </Stack>
                {run.status === 'failed' && run.error && (
                  <Typography level="body-xs" color="danger" data-testid="datalake-research-run-error">
                    {run.error}
                  </Typography>
                )}
                {run.status === 'completed' && (
                  <Typography level="body-xs" data-testid="datalake-research-run-totals">
                    {runOutcomeSummary(run)}
                  </Typography>
                )}
                {run.stopReason && (
                  <Typography level="body-xs" textColor="text.tertiary" data-testid="datalake-research-run-stop-reason">
                    {STOP_REASON_LABEL[run.stopReason]}
                  </Typography>
                )}
              </Stack>
            </Box>
          ))}
        </>
      )}
    </Stack>
  );
}
