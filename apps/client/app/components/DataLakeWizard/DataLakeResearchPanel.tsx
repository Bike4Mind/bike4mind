import React, { useEffect, useMemo, useState } from 'react';
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
import type { ResearchModelOption } from '@client/app/utils/researchJudgeModels';

export interface DataLakeResearchPanelProps {
  configs: IDataLakeResearchConfigDocument[] | undefined;
  runs: IDataLakeResearchRunDocument[] | undefined;
  isLoading: boolean;
  error: unknown;
  /** Relevance-judge models, already ordered and labelled by `researchJudgeModelOptions`. */
  modelOptions: ResearchModelOption[];
  /** The "no model chosen" option's label, naming what the run falls back to. */
  defaultModelLabel?: string;
  isCreating?: boolean;
  /** The config a save, delete or start is in flight for, so only its own row shows busy. */
  savingConfigId?: string | null;
  deletingConfigId?: string | null;
  startingConfigId?: string | null;
  onCreate: (input: ResearchConfigInput) => void;
  onUpdate: (configId: string, input: ResearchConfigInput) => void;
  onDelete: (configId: string) => void;
  onStartRun: (configId: string) => void;
  /** Whether the open create/edit form holds edits not yet saved, so the host can confirm before closing. */
  onDirtyChange?: (dirty: boolean) => void;
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

/**
 * Full precision, unlike `microUsdToUsdInput`: a saved ceiling can be sub-cent (e.g. $0.004), and
 * `toFixed(2)` would seed the field with "0.00", which then fails the "above $0" range check and
 * blocks Save, or rounds up and saves a different ceiling than the one on screen. Micro-USD is an
 * integer, so `String` on the quotient is exact - JS renders the shortest round-tripping decimal.
 */
const microUsdToUsdDraftInput = (micro: number): string => String(micro / 1_000_000);

/** Spend is routinely a fraction of a cent, so two decimals would render every run as $0.00. */
const formatSpend = (micro: number): string => `$${(micro / 1_000_000).toFixed(4)}`;

const MICRO_USD_PER_CENT = 10_000;

/** A ceiling is a setting, not a tally: whole cents read as money, a sub-cent one keeps its precision. */
const formatCeiling = (micro: number): string =>
  micro >= MICRO_USD_PER_CENT && micro % MICRO_USD_PER_CENT === 0
    ? `$${microUsdToUsdInput(micro)}`
    : formatSpend(micro);

const pluralize = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`;

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
  costCeilingUsd: microUsdToUsdDraftInput(config.costCeilingMicroUsd),
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

type DraftErrors = Partial<Record<keyof ConfigDraft, string>>;

/**
 * The server clamps an out-of-range lever rather than refusing it, so without this check a typo
 * saves a different config than the one on screen (a $99 ceiling stored as $5.00, -7 days stored as
 * "no limit"). Blank is valid wherever `draftToInput` gives blank a meaning.
 */
const rangeError = (
  value: string,
  { min, max, integer, message }: { min: number; max: number; integer: boolean; message: string }
): string | undefined => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return message;
  if (integer && !Number.isInteger(parsed)) return message;
  return undefined;
};

const costCeilingLimitUsd = RESEARCH_COST_CEILING_MICRO_USD_LIMIT / 1_000_000;

const validateDraft = (draft: ConfigDraft): DraftErrors => {
  const errors: DraftErrors = {
    maxResults: rangeError(draft.maxResults, {
      min: 1,
      max: RESEARCH_MAX_RESULTS_LIMIT,
      integer: true,
      message: `Enter a whole number from 1 to ${RESEARCH_MAX_RESULTS_LIMIT}.`,
    }),
    maxProposals: rangeError(draft.maxProposals, {
      min: 1,
      max: RESEARCH_MAX_PROPOSALS_LIMIT,
      integer: true,
      message: `Enter a whole number from 1 to ${RESEARCH_MAX_PROPOSALS_LIMIT}.`,
    }),
    recencyDays: rangeError(draft.recencyDays, {
      min: 1,
      max: RESEARCH_RECENCY_DAYS_LIMIT,
      integer: true,
      message: `Enter a whole number of days from 1 to ${RESEARCH_RECENCY_DAYS_LIMIT}, or leave blank.`,
    }),
    minRelevance: rangeError(draft.minRelevance, {
      min: 0,
      max: 1,
      integer: false,
      message: 'Enter a number from 0 to 1.',
    }),
    costCeilingUsd: rangeError(draft.costCeilingUsd, {
      // The server floors the ceiling at 1 micro-USD; anything that rounds below it is not a ceiling.
      min: 0.000001,
      max: costCeilingLimitUsd,
      integer: false,
      message: `Enter an amount above $0 and up to $${microUsdToUsdInput(RESEARCH_COST_CEILING_MICRO_USD_LIMIT)}.`,
    }),
  };
  return Object.fromEntries(Object.entries(errors).filter(([, message]) => message)) as DraftErrors;
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

/** When a run actually began, falling back to when it was queued - the time its history row shows. */
const runStartedAt = (run: IDataLakeResearchRunDocument): Date | string => run.startedAt ?? run.createdAt;

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
  defaultModelLabel = 'Default',
  isCreating,
  savingConfigId,
  deletingConfigId,
  startingConfigId,
  onCreate,
  onUpdate,
  onDelete,
  onStartRun,
  onDirtyChange,
}: DataLakeResearchPanelProps) {
  // null = the form is closed; '' = creating; an id = editing that config.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ConfigDraft>(emptyDraft);
  const [draftBaseline, setDraftBaseline] = useState<ConfigDraft>(emptyDraft);
  const isDirty =
    editingId !== null && (Object.keys(draft) as (keyof ConfigDraft)[]).some(key => draft[key] !== draftBaseline[key]);
  // The cleanup reports clean on unmount too: Joy unmounts an inactive TabPanel, which drops the draft.
  useEffect(() => {
    onDirtyChange?.(isDirty);
    return () => onDirtyChange?.(false);
  }, [isDirty, onDirtyChange]);

  // Age-bounded on purpose: this mirrors the server's own active-run count, so the button unlocks
  // for exactly the lakes a POST would be accepted for rather than staying dead on an abandoned row.
  const runInFlight = useMemo(() => (runs ?? []).some(run => isResearchRunInFlight(run)), [runs]);
  const configById = useMemo(() => new Map((configs ?? []).map(config => [config.id, config])), [configs]);
  const modelLabelById = useMemo(() => new Map(modelOptions.map(option => [option.id, option.label])), [modelOptions]);
  // The config's own `lastRunAt` is stamped when the run is queued; the newest run row, when this
  // page has it, carries the time the run began, which is what the history below shows.
  const lastRunAtByConfig = useMemo(() => {
    const latest = new Map<string, Date | string>();
    for (const run of runs ?? []) {
      const at = runStartedAt(run);
      const current = latest.get(run.configId);
      if (!current || new Date(at).getTime() > new Date(current).getTime()) latest.set(run.configId, at);
    }
    return latest;
  }, [runs]);
  const setField = (field: keyof ConfigDraft) => (value: string) => setDraft(prev => ({ ...prev, [field]: value }));

  const openCreate = () => {
    setDraft(emptyDraft());
    setDraftBaseline(emptyDraft());
    setEditingId('');
  };
  const openEdit = (config: IDataLakeResearchConfigDocument) => {
    setDraft(draftFromConfig(config));
    setDraftBaseline(draftFromConfig(config));
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
  const errors = validateDraft(draft);
  const missingRequired = !draft.name.trim() || !draft.query.trim();
  const canSave = !missingRequired && Object.keys(errors).length === 0;
  const editedConfig = editingId ? configById.get(editingId) : undefined;
  // A run reads the SAVED config, so running mid-edit would run something other than what is on screen.
  const hasUnsavedEdits = !!editedConfig && JSON.stringify(draft) !== JSON.stringify(draftFromConfig(editedConfig));
  // A saved model this picker no longer lists (retired, disabled, filtered) must still render as
  // selected, or the Select shows blank and a save silently keeps a model nobody can see.
  const orphanModelId = draft.model && !modelLabelById.has(draft.model) ? draft.model : null;

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
        const unsaved = editingId === config.id && hasUnsavedEdits;
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
                  {`Up to ${pluralize(config.maxProposals, 'proposal')} \u00b7 ${formatCeiling(config.costCeilingMicroUsd)} ceiling`}
                </Chip>
              </Stack>
              <Typography level="body-xs" sx={{ whiteSpace: 'pre-wrap' }} data-testid="datalake-research-config-query">
                {config.query}
              </Typography>
              <Typography level="body-xs" textColor="text.tertiary" data-testid="datalake-research-config-model">
                {`Model: ${config.model ? (modelLabelById.get(config.model) ?? config.model) : defaultModelLabel}`}
              </Typography>
              {config.proposedTags.length > 0 && (
                <Stack
                  direction="row"
                  spacing={0.5}
                  sx={{ flexWrap: 'wrap', rowGap: 0.5 }}
                  data-testid="datalake-research-config-tags"
                >
                  {config.proposedTags.map(tag => (
                    <Chip key={tag} size="sm" variant="outlined">
                      {tag}
                    </Chip>
                  ))}
                </Stack>
              )}
              <Typography level="body-xs" textColor="text.tertiary" data-testid="datalake-research-config-last-run">
                {`Last run ${formatWhen(lastRunAtByConfig.get(config.id) ?? config.lastRunAt)}`}
              </Typography>
              <Stack direction="row" spacing={1}>
                <Button
                  size="sm"
                  color="primary"
                  loading={startingConfigId === config.id}
                  // A lake runs one at a time - the server refuses a second, so the button says so
                  // rather than letting a click earn a refusal toast.
                  disabled={busy || runInFlight || unsaved}
                  onClick={() => onStartRun(config.id)}
                  data-testid="datalake-research-run-btn"
                >
                  {runInFlight ? 'Run in progress' : unsaved ? 'Save changes to run' : 'Run now'}
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
            <FormControl size="sm" required>
              <FormLabel>Name</FormLabel>
              <Input
                value={draft.name}
                onChange={e => setField('name')(e.target.value)}
                slotProps={{
                  input: { 'data-testid': 'datalake-research-name-input', maxLength: RESEARCH_CONFIG_NAME_MAX_CHARS },
                }}
              />
              <FormHelperText data-testid="datalake-research-name-count">
                {`${draft.name.length}/${RESEARCH_CONFIG_NAME_MAX_CHARS}`}
              </FormHelperText>
            </FormControl>

            <FormControl size="sm" required>
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
              <FormHelperText data-testid="datalake-research-query-count">
                {`Used both as the web search and as the question each result is judged against. ${draft.query.length}/${RESEARCH_CONFIG_QUERY_MAX_CHARS}`}
              </FormHelperText>
            </FormControl>

            <FormControl size="sm">
              <FormLabel>Relevance model</FormLabel>
              <Select
                value={draft.model}
                onChange={(_e, value) => setField('model')(value ?? '')}
                slotProps={{ button: { 'data-testid': 'datalake-research-model-select' } }}
              >
                <Option value="">{defaultModelLabel}</Option>
                {orphanModelId && (
                  <Option value={orphanModelId} disabled>
                    {`${orphanModelId} (not offered for research)`}
                  </Option>
                )}
                {modelOptions.map(option => (
                  <Option key={option.id} value={option.id}>
                    {option.label}
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
                  error={!!errors.maxResults}
                  slotProps={{
                    input: {
                      'data-testid': 'datalake-research-max-results-input',
                      min: 1,
                      max: RESEARCH_MAX_RESULTS_LIMIT,
                    },
                  }}
                />
                <FormHelperText>{errors.maxResults ?? `Up to ${RESEARCH_MAX_RESULTS_LIMIT}`}</FormHelperText>
              </FormControl>

              <FormControl size="sm" sx={{ flex: 1 }}>
                <FormLabel>Proposals per run</FormLabel>
                <Input
                  type="number"
                  value={draft.maxProposals}
                  onChange={e => setField('maxProposals')(e.target.value)}
                  error={!!errors.maxProposals}
                  slotProps={{
                    input: {
                      'data-testid': 'datalake-research-max-proposals-input',
                      min: 1,
                      max: RESEARCH_MAX_PROPOSALS_LIMIT,
                    },
                  }}
                />
                <FormHelperText>{errors.maxProposals ?? `Up to ${RESEARCH_MAX_PROPOSALS_LIMIT}`}</FormHelperText>
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
                  error={!!errors.recencyDays}
                  endDecorator="days"
                  slotProps={{
                    input: {
                      'data-testid': 'datalake-research-recency-input',
                      min: 1,
                      max: RESEARCH_RECENCY_DAYS_LIMIT,
                    },
                  }}
                />
                <FormHelperText>{errors.recencyDays ?? 'Leave blank for no recency limit.'}</FormHelperText>
              </FormControl>

              <FormControl size="sm" sx={{ flex: 1 }}>
                <FormLabel>Minimum relevance</FormLabel>
                <Input
                  type="number"
                  value={draft.minRelevance}
                  onChange={e => setField('minRelevance')(e.target.value)}
                  error={!!errors.minRelevance}
                  slotProps={{
                    input: { 'data-testid': 'datalake-research-min-relevance-input', min: 0, max: 1, step: 0.05 },
                  }}
                />
                <FormHelperText>
                  {errors.minRelevance ?? '0 to 1. Below this, a result is never fetched or proposed.'}
                </FormHelperText>
              </FormControl>
            </Stack>

            <FormControl size="sm">
              <FormLabel>Cost ceiling</FormLabel>
              <Input
                type="number"
                value={draft.costCeilingUsd}
                onChange={e => setField('costCeilingUsd')(e.target.value)}
                error={!!errors.costCeilingUsd}
                startDecorator="$"
                slotProps={{
                  input: {
                    'data-testid': 'datalake-research-cost-ceiling-input',
                    min: 0,
                    max: costCeilingLimitUsd,
                    step: 0.01,
                  },
                }}
              />
              <FormHelperText>
                {errors.costCeilingUsd ??
                  `Judgement spend for one run. The run stops when it would exceed this. Maximum $${microUsdToUsdInput(
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
                <FormHelperText>One per line, subdomains included. Leave blank to allow any site.</FormHelperText>
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
                <FormHelperText>One per line, subdomains included. Wins over the allow list.</FormHelperText>
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
              <FormHelperText>
                Shown on each proposal as suggestions only. Approving applies the lake tag, not these.
              </FormHelperText>
            </FormControl>

            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <Button
                size="sm"
                color="primary"
                loading={saveBusy}
                disabled={!canSave}
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
              {!canSave && (
                <Typography level="body-xs" textColor="text.tertiary" data-testid="datalake-research-save-hint">
                  {missingRequired ? 'Add a name and what to look for to save.' : 'Fix the highlighted fields to save.'}
                </Typography>
              )}
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
                    {`${formatWhen(runStartedAt(run))} \u00b7 ${formatSpend(run.spentMicroUsd)}`}
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
