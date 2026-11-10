import { useState, type ReactNode } from 'react';
import { Alert, Box, Button, Link, Stack, Typography } from '@mui/joy';
import {
  ADMIN_MODEL_NEEDS_REVIEW_REASONS,
  ADAPTER_LITERAL_PRICE_SOURCE,
  type AdminModelFixAction,
  type AdminModelRow,
} from '@bike4mind/common';
import {
  AdminPageHeader,
  EmptyState,
  ErrorState,
  Fact,
  LoadingState,
  SectionCard,
  StatusChip,
  UpdatingBar,
} from '../../shared';
import { ADMIN_DETAIL_MAX_WIDTH, ADMIN_REGION_GAP, adminPageFrame } from '../../shared/adminStyles';
import { ModelFixAction } from '../ModelFixAction';
import { useModelsNavigation } from '../modelsNavigation';
import { apiErrorMessage, apiStatusOf, useDiscoveryRun, type DiscoveryRun, type RunPriceFlag } from './discoveryApi';
import {
  NOT_SAVED_NOTE,
  REPORT_MODE_BANNER,
  RUN_EXPIRED_TITLE,
  blockerCopy,
  flagCopy,
  formatRunTime,
  inOut,
  isDecisionBlocker,
  lifecycleWord,
  modelStatusCopy,
  runResult,
  runSentence,
  triggerLabel,
  usdPerMTok,
} from './discoveryCopy';
import { RunDetails } from './RunDetails';
import { modelName, useModelIndex } from './useModelIndex';

type ModelIndex = ReadonlyMap<string, AdminModelRow>;

type Decision = {
  modelId: string;
  reasons: string[];
  flags: RunPriceFlag[];
  notSaved: boolean;
  /** The first open reason's server fix action, on the model's own row. */
  fix: { action: AdminModelFixAction; row: AdminModelRow } | null;
  /** Flags with no open reason to act on: the price is the decision. */
  openPrices: boolean;
};

const unique = (ids: readonly string[]) => [...new Set(ids)];

/**
 * One card per model this run touched whose status is Needs review now (docs/admin-models-spec.md section 5.3),
 * plus this run's price flags, which phase 1 does not yet persist on the model. A report-mode run's new models have
 * no catalog row, so they show what they would need and no action; a write-mode flag on a model the list does not
 * carry still gets a card. Without the index (`indexFailed`) only the run's own findings are known, so nothing is
 * claimed about catalog rows.
 */
function buildDecisions(run: DiscoveryRun, index: ModelIndex, indexFailed: boolean): Decision[] {
  const flagsByModel = new Map<string, RunPriceFlag[]>();
  for (const flag of run.priceFlags) flagsByModel.set(flag.modelId, [...(flagsByModel.get(flag.modelId) ?? []), flag]);
  const diffByModel = new Map(run.catalogDiff.map(entry => [entry.modelId, entry]));
  const candidates = unique([
    ...run.priceFlags.map(flag => flag.modelId),
    ...run.changes.added,
    ...run.changes.flagged,
    ...run.lifecycleTransitions.filter(transition => !transition.autoApplied).map(transition => transition.modelId),
    ...run.catalogDiff.filter(entry => entry.blockedBy.some(isDecisionBlocker)).map(entry => entry.modelId),
  ]);

  const decisions: Decision[] = [];
  for (const modelId of candidates) {
    const row = index.get(modelId);
    const flags = flagsByModel.get(modelId) ?? [];
    if (!row) {
      const blockers =
        run.mode === 'report' ? (diffByModel.get(modelId)?.blockedBy ?? []).filter(isDecisionBlocker) : [];
      if (blockers.length === 0 && flags.length === 0) continue;
      decisions.push({
        modelId,
        reasons: blockers.map(blockerCopy),
        flags,
        notSaved: run.mode === 'report' && !indexFailed,
        fix: null,
        openPrices: indexFailed && flags.length > 0,
      });
      continue;
    }
    const open =
      row.status === 'needs-review' ? row.reasons.filter(r => ADMIN_MODEL_NEEDS_REVIEW_REASONS.has(r.code)) : [];
    if (open.length === 0 && flags.length === 0) continue;
    const fixAction = open[0]?.fixAction;
    decisions.push({
      modelId,
      reasons: open.map(reason => reason.message),
      flags,
      notSaved: false,
      fix: fixAction ? { action: fixAction, row } : null,
      openPrices: open.length === 0,
    });
  }
  return decisions;
}

function DecisionCard({ decision, index }: { decision: Decision; index: ModelIndex }) {
  const { modelId, reasons, flags, notSaved, fix } = decision;
  const { openModel, openPrices } = useModelsNavigation();
  const actionTestId = `discovery-decision-action-${modelId}`;
  return (
    <SectionCard
      title={modelName(index, modelId)}
      data-testid={`discovery-decision-${modelId}`}
      action={
        fix ? (
          <ModelFixAction action={fix.action} model={fix.row} data-testid={actionTestId} />
        ) : decision.openPrices ? (
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => void openPrices(modelId)}
            data-testid={actionTestId}
          >
            Open prices
          </Button>
        ) : null
      }
    >
      <Fact label="Model id">
        <Stack gap={0.25} alignItems="flex-start">
          <Typography level="body-xs" fontFamily="code" sx={{ overflowWrap: 'anywhere' }}>
            {modelId}
          </Typography>
          <Link
            component="button"
            type="button"
            level="body-sm"
            onClick={() => void openModel(modelId)}
            data-testid={`discovery-decision-open-${modelId}`}
          >
            Open model
          </Link>
        </Stack>
      </Fact>
      {notSaved && (
        <Fact label="Status" data-testid={`discovery-decision-not-saved-${modelId}`}>
          {NOT_SAVED_NOTE}
        </Fact>
      )}
      {reasons.length > 0 && (
        <Fact label="Why" data-testid={`discovery-decision-reasons-${modelId}`}>
          {reasons.map(reason => (
            <Box key={reason}>{reason}</Box>
          ))}
        </Fact>
      )}
      {flags.map(flag => (
        <Fact key={flag.kind} label="Price" data-testid={`discovery-decision-flag-${modelId}`}>
          <Stack gap={0.5}>
            <Box>{flagCopy(flag.kind, flag.detail)}</Box>
            {/* Never truncated: the sentence names the rates and sources, so they print nowhere else. */}
            <Box sx={{ color: 'admin.inkMuted' }}>{flag.detail}</Box>
          </Stack>
        </Fact>
      ))}
    </SectionCard>
  );
}

function ChangeGroup({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <Stack gap={0.75} data-testid={testId}>
      <Typography level="title-sm" component="h3" sx={{ color: 'admin.ink' }}>
        {title}
      </Typography>
      <Stack component="ul" gap={0.75} sx={{ m: 0, p: 0, listStyle: 'none' }}>
        {children}
      </Stack>
    </Stack>
  );
}

function ChangeItem({
  modelId,
  index,
  group,
  itemKey,
  children,
}: {
  modelId: string;
  index: ModelIndex;
  group: string;
  itemKey?: string;
  children?: ReactNode;
}) {
  const { openModel } = useModelsNavigation();
  return (
    <Stack
      component="li"
      direction="row"
      flexWrap="wrap"
      alignItems="center"
      columnGap={1}
      rowGap={0.25}
      data-testid={`discovery-changed-${group}-${itemKey ?? modelId}`}
    >
      <Link
        component="button"
        type="button"
        level="body-sm"
        onClick={() => void openModel(modelId)}
        data-testid="discovery-changed-open-model-link"
      >
        {modelName(index, modelId)}
      </Link>
      {children}
    </Stack>
  );
}

const Muted = ({ children }: { children: ReactNode }) => (
  <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
    {children}
  </Typography>
);

function WhatChanged({ run, index }: { run: DiscoveryRun; index: ModelIndex }) {
  const wrote = run.mode === 'write';
  const report = run.mode === 'report';
  const diffByModel = new Map(run.catalogDiff.map(entry => [entry.modelId, entry]));
  const repriced = run.priceRows
    .map((row, rowIndex) => ({ ...row, rowIndex }))
    .filter(row => !row.sources.includes(ADAPTER_LITERAL_PRICE_SOURCE));
  const overrides = run.priceOverrides ?? [];
  const groups: ReactNode[] = [];

  if (run.changes.added.length > 0) {
    groups.push(
      <ChangeGroup key="added" title={wrote ? 'Added' : 'Would add'} testId="discovery-changed-added">
        {run.changes.added.map(modelId => {
          const row = index.get(modelId);
          const status = row && modelStatusCopy(row.status);
          const blockers = diffByModel.get(modelId)?.blockedBy ?? [];
          return (
            <ChangeItem key={modelId} modelId={modelId} index={index} group="added">
              {status && <StatusChip tone={status.tone} label={status.label} />}
              {row && row.reasons.length > 0 && <Muted>{row.reasons[0].message}</Muted>}
              {!row && blockers.length > 0 && <Muted>{blockerCopy(blockers[0])}</Muted>}
            </ChangeItem>
          );
        })}
      </ChangeGroup>
    );
  }
  if (run.changes.promoted.length > 0) {
    groups.push(
      <ChangeGroup key="listed" title={wrote ? 'Listed' : 'Would list'} testId="discovery-changed-listed">
        {run.changes.promoted.map(modelId => (
          <ChangeItem key={modelId} modelId={modelId} index={index} group="listed" />
        ))}
      </ChangeGroup>
    );
  }
  if (repriced.length > 0) {
    groups.push(
      <ChangeGroup key="repriced" title={wrote ? 'Repriced' : 'Would reprice'} testId="discovery-changed-repriced">
        {repriced.map(row => (
          <ChangeItem
            key={row.rowIndex}
            modelId={row.modelId}
            index={index}
            group="repriced"
            itemKey={`${row.modelId}-${row.rowIndex}`}
          >
            <Muted>
              {usdPerMTok(row.inputPerMTok)} in / {usdPerMTok(row.outputPerMTok)} out per 1M
            </Muted>
          </ChangeItem>
        ))}
      </ChangeGroup>
    );
  }
  if (run.lifecycleTransitions.length > 0) {
    groups.push(
      <ChangeGroup key="lifecycle" title="Lifecycle changes" testId="discovery-changed-lifecycle">
        {run.lifecycleTransitions.map((transition, rowIndex) => {
          const detail = [
            `${lifecycleWord(transition.from ?? 'active')} to ${lifecycleWord(transition.to).toLowerCase()}`,
            transition.deprecationDate && `deprecates ${transition.deprecationDate}`,
            transition.retirementDate && `retires ${transition.retirementDate}`,
            transition.replacedBy && `replaced by ${modelName(index, transition.replacedBy)}`,
          ]
            .filter(Boolean)
            .join(', ');
          const applied = transition.autoApplied ? (wrote ? 'Applied' : 'Would apply') : 'Suggested';
          return (
            <ChangeItem
              key={rowIndex}
              modelId={transition.modelId}
              index={index}
              group="lifecycle"
              itemKey={`${transition.modelId}-${rowIndex}`}
            >
              <Muted>{detail}</Muted>
              <StatusChip tone={transition.autoApplied ? 'neutral' : 'info'} label={applied} />
            </ChangeItem>
          );
        })}
      </ChangeGroup>
    );
  }
  if (run.changes.operatorConflicts.length > 0 || overrides.length > 0) {
    groups.push(
      <ChangeGroup key="overruled" title="Overruled sources" testId="discovery-changed-overruled">
        {run.changes.operatorConflicts.map(modelId => (
          <ChangeItem key={`admin-${modelId}`} modelId={modelId} index={index} group="overruled">
            <Muted>Set by admin: the values an admin saved keep winning over what discovery found.</Muted>
          </ChangeItem>
        ))}
        {overrides.map(override => (
          <ChangeItem
            key={`price-${override.modelId}`}
            modelId={override.modelId}
            index={index}
            group="overruled"
            itemKey={`price-${override.modelId}`}
          >
            <Muted>
              {inOut(override.applied)} per 1M from {override.source}, over {override.dissenting.join(', ')}.{' '}
              {override.detail}
            </Muted>
          </ChangeItem>
        ))}
      </ChangeGroup>
    );
  }

  return (
    <SectionCard title="What changed" body="custom" data-testid="discovery-run-changes">
      <Stack gap={2} sx={{ px: 2, py: 1.75 }}>
        {groups.length > 0 ? (
          groups
        ) : (
          <Muted>{report ? 'This run found nothing to change.' : 'This run changed nothing.'}</Muted>
        )}
      </Stack>
    </SectionCard>
  );
}

function Breadcrumb({ current }: { current: string }) {
  const { openSection } = useModelsNavigation();
  return (
    <Stack component="nav" aria-label="Breadcrumb" direction="row" alignItems="center" gap={1} flexWrap="wrap">
      <Link
        component="button"
        type="button"
        level="body-sm"
        onClick={() => void openSection('list')}
        data-testid="discovery-run-breadcrumb-models"
      >
        Models
      </Link>
      <Typography level="body-sm" aria-hidden sx={{ color: 'admin.inkMuted' }}>
        /
      </Typography>
      <Link
        component="button"
        type="button"
        level="body-sm"
        onClick={() => void openSection('discovery')}
        data-testid="discovery-run-breadcrumb-discovery"
      >
        Discovery
      </Link>
      <Typography level="body-sm" aria-hidden sx={{ color: 'admin.inkMuted' }}>
        /
      </Typography>
      <Typography level="body-sm" aria-current="page" sx={{ color: 'admin.inkMuted', overflowWrap: 'anywhere' }}>
        {current}
      </Typography>
    </Stack>
  );
}

function RunView({ run }: { run: DiscoveryRun }) {
  const models = useModelIndex();
  const index: ModelIndex = models.data ?? new Map();
  const indexFailed = models.isError && !models.data;
  const [showDetails, setShowDetails] = useState(false);
  const result = runResult(run);
  const decisions = models.isLoading ? [] : buildDecisions(run, index, indexFailed);
  // The plan is reported identically in both modes, so a write run whose appends all threw looks clean everywhere
  // but here. Write mode only: report mode plans rows and writes none by design.
  const writeGaps =
    run.mode === 'write'
      ? [
          run.changes.plannedPriceRows > run.changes.appendedPriceRows &&
            `${run.changes.plannedPriceRows} price rows planned, ${run.changes.appendedPriceRows} appended`,
          run.changes.plannedRows > run.changes.appendedRows &&
            `${run.changes.plannedRows} catalog rows planned, ${run.changes.appendedRows} appended`,
        ].filter((gap): gap is string => !!gap)
      : [];

  return (
    <>
      {run.mode === 'report' && (
        <Alert color="neutral" data-testid="discovery-run-report-mode">
          {REPORT_MODE_BANNER}
        </Alert>
      )}
      {writeGaps.length > 0 && (
        <Alert color="warning" data-testid="discovery-run-write-gap">
          Writes were planned and did not land: {writeGaps.join('; ')}. The run still reports{' '}
          {result.label.toLowerCase()}.
        </Alert>
      )}

      <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap">
        <StatusChip tone={result.tone} label={result.label} data-testid="discovery-run-result" />
        <Typography level="body-md" sx={{ color: 'admin.ink' }} data-testid="discovery-run-summary">
          {runSentence(run)}
        </Typography>
      </Stack>

      <Stack component="section" gap={1.5} data-testid="discovery-run-decisions">
        <Typography level="title-md" component="h2" sx={{ color: 'admin.ink' }}>
          Needs your decision
        </Typography>
        {models.isLoading ? (
          <LoadingState label="Loading model status" />
        ) : decisions.length === 0 ? (
          <Muted>Nothing from this run needs your decision.</Muted>
        ) : (
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
            {decisions.map(decision => (
              <DecisionCard key={decision.modelId} decision={decision} index={index} />
            ))}
          </Box>
        )}
        {indexFailed && (
          <Muted>Could not load each model&apos;s current status, so only this run&apos;s own findings show.</Muted>
        )}
      </Stack>

      <WhatChanged run={run} index={index} />

      <Stack gap={1.5}>
        <Box>
          <Button
            variant="plain"
            color="neutral"
            size="sm"
            aria-expanded={showDetails}
            aria-controls="discovery-run-details"
            onClick={() => setShowDetails(open => !open)}
            data-testid="discovery-run-details-toggle"
          >
            {showDetails ? 'Hide run details' : 'Show run details'}
          </Button>
        </Box>
        {showDetails && (
          <Box id="discovery-run-details">
            <RunDetails run={run} />
          </Box>
        )}
      </Stack>
    </>
  );
}

/** One discovery run at /admin/models/runs/$runId (docs/admin-models-spec.md section 5.3). */
export function DiscoveryRunPage({ runId }: { runId: string }) {
  const query = useDiscoveryRun(runId);
  const { openSection } = useModelsNavigation();
  const run = query.data;
  const expired = apiStatusOf(query.error) === 404;

  return (
    <Stack
      gap={ADMIN_REGION_GAP}
      sx={{ ...adminPageFrame, maxWidth: ADMIN_DETAIL_MAX_WIDTH }}
      data-testid="discovery-run-page"
    >
      <Breadcrumb current={run ? formatRunTime(run.startedAt) : 'Run'} />
      <AdminPageHeader
        title="Discovery run"
        description={
          run && (
            <span data-testid="discovery-run-header">
              {triggerLabel(run.trigger)} run on {run.host}, started {formatRunTime(run.startedAt)}
              {run.finishedAt ? `, finished ${formatRunTime(run.finishedAt)}` : ', still running'}
            </span>
          )
        }
      />
      <UpdatingBar active={query.isFetching && !query.isLoading && !!run} testId="discovery-run-updating" />
      {run ? (
        <RunView key={runId} run={run} />
      ) : query.isLoading ? (
        <LoadingState label="Loading the run" testId="discovery-run-loading" />
      ) : expired ? (
        <Box data-testid="discovery-run-expired">
          <EmptyState
            title={RUN_EXPIRED_TITLE}
            action={
              <Button
                variant="outlined"
                onClick={() => void openSection('discovery')}
                data-testid="discovery-run-back-btn"
              >
                Back to discovery
              </Button>
            }
          />
        </Box>
      ) : (
        <ErrorState
          message={apiErrorMessage(query.error, 'Could not load the run')}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      )}
    </Stack>
  );
}
