import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Link,
  Modal,
  ModalClose,
  ModalDialog,
  Sheet,
  Stack,
  Table,
  Typography,
} from '@mui/joy';
import type { ColorPaletteProp } from '@mui/joy/styles';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { api } from '@client/app/contexts/ApiContext';
import { AdminTab } from './adminSidebarConfig';
import { useAdminModal } from './useAdminModal';
import { useCreditAnalysisStore } from './CreditAnalysis/store';

/**
 * Wire shapes of GET /api/admin/model-discovery?runId= (dates arrive as strings).
 * Mirrors fullRun() in pages/api/admin/model-discovery.ts, which defaults every
 * top-level array; the nested arrays come off stored subdocuments, so `list()`
 * still tolerates a missing one.
 */
interface RunSource {
  name: string;
  ok: boolean;
  durationMs: number;
  httpStatus?: number;
  recordCount?: number;
  error?: string;
}

interface PerMTokRates {
  inputPerMTok: number;
  outputPerMTok: number;
}

interface PriceFlag {
  modelId: string;
  /** A service-owned union read as a free string; a new kind must still render. */
  kind: string;
  proposed: PerMTokRates;
  current?: PerMTokRates;
  sources: string[];
  detail: string;
}

interface PlannedPriceRow {
  modelId: string;
  unit: string;
  inputPerMTok: number;
  outputPerMTok: number;
  effectiveFrom: string;
  sources: string[];
  note: string;
}

/** A row written over a source that disagreed with it; the inverse of a flag. */
interface PriceOverride {
  modelId: string;
  source: string;
  dissenting: string[];
  applied: PerMTokRates;
  detail: string;
}

interface LifecycleTransition {
  modelId: string;
  from?: string;
  to: string;
  signal: string;
  deprecationDate?: string;
  retirementDate?: string;
  replacedBy?: string;
  autoApplied: boolean;
}

interface CatalogDiffEntry {
  modelId: string;
  kind: string;
  ownedGroups: string[];
  changedKeys: string[];
  lifecycleStatus: string;
  promoted: boolean;
  blockedBy: string[];
  operatorOwned: boolean;
}

/**
 * How much each capped detail array was cut from, present per array only when the
 * runner truncated it (MAX_PERSISTED_RUN_DETAIL). The `changes.*` id arrays the
 * sections explain are uncapped, so without these a wide run reads "260 flagged"
 * in the header and "Price flags (200)" below it with nothing saying why.
 */
interface DetailTotals {
  priceFlags?: number;
  priceRows?: number;
  priceOverrides?: number;
  priceSkips?: number;
  lifecycleTransitions?: number;
  catalogDiff?: number;
}

interface RunDetail {
  id: string;
  startedAt: string;
  finishedAt?: string | null;
  trigger: string;
  host: string;
  status: 'ok' | 'partial' | 'failed';
  /**
   * What the run was allowed to do, as it ran. Absent on runs written before the
   * field existed, which is why nothing here infers 'write' from its absence.
   */
  mode?: 'report' | 'write';
  passes: number;
  sources: RunSource[];
  joinCoverage: Array<{ aggregator: string; matched: number; total: number }>;
  changes: {
    added: string[];
    promoted: string[];
    deprecated: string[];
    repriced: string[];
    flagged: string[];
    operatorConflicts: string[];
    plannedRows: number;
    appendedRows: number;
    plannedPriceRows: number;
    appendedPriceRows: number;
  };
  priceFlags: PriceFlag[];
  priceRows: PlannedPriceRow[];
  /** Optional: runs written before provider prices could overrule a mirror carry none. */
  priceOverrides?: PriceOverride[];
  priceSkips: Array<{ modelId: string; reason: string }>;
  lifecycleTransitions: LifecycleTransition[];
  catalogDiff: CatalogDiffEntry[];
  /** Absent per array (and, on an older run document, entirely) when nothing was cut. */
  detailTotals?: DetailTotals;
  unmatchedIds: string[];
  droppedRecords: Array<{ source: string; modelId: string; reason: string }>;
}

const STATUS_COLOR: Record<RunDetail['status'], ColorPaletteProp> = {
  ok: 'success',
  partial: 'warning',
  failed: 'danger',
};

/**
 * PriceFlagKind in b4m-core/services/src/modelDiscoveryService/types.ts. A kind
 * added there renders neutral rather than crashing, but the two guardrails an
 * operator acts on most are coloured apart deliberately.
 */
const FLAG_KIND_COLOR: Record<string, ColorPaletteProp> = {
  'band-exceeded': 'danger',
  'source-disagreement': 'warning',
  'single-source-untrusted': 'primary',
  'operator-owned-divergence': 'primary',
  'tiered-pricing-manual': 'neutral',
};

// The envelope names it 'error' (server/middlewares/errorHandler.ts); 'message'
// stays as a fallback for endpoints that answer outside that envelope. Reading
// only 'message' left every 403 and 500 as axios's useless
// 'Request failed with status code 403'.
const apiErrorMessage = (err: unknown, fallback: string) => {
  const e = err as { response?: { data?: { error?: string; message?: string } }; message?: string };
  return e?.response?.data?.error || e?.response?.data?.message || e?.message || fallback;
};

const formatTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '-');

/** Rates arrive already per 1M tokens, the unit an operator reads prices in. */
const usdPerMTok = (value: number | undefined) =>
  value === undefined ? '-' : `$${value.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;

const inOut = (rates: PerMTokRates | undefined) =>
  rates ? `${usdPerMTok(rates.inputPerMTok)} in / ${usdPerMTok(rates.outputPerMTok)} out` : '-';

/** Undefined is tolerated: a subdoc written before its path existed has no array. */
const list = (values: string[] | undefined) => (values && values.length > 0 ? values.join(', ') : '-');

/**
 * A section's count, which may not pass a truncated slice off as the whole set:
 * the run document caps each detail array, and the ids in `changes` do not.
 */
const countLabel = (shown: number, total: number | undefined) =>
  total !== undefined && total > shown ? `first ${shown} of ${total}` : `${shown}`;

/** A labelled Sheet + Table section, the idiom ModelLifecycleTab uses. */
const Section: React.FC<{ title: string; children: React.ReactNode; sx?: object }> = ({ title, children, sx }) => (
  <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm', ...sx }}>
    <Typography level="title-sm" sx={{ mb: 0.5 }}>
      {title}
    </Typography>
    {children}
  </Sheet>
);

/**
 * One discovery run as the report behind the status card's change counts: which
 * models were flagged and, above all, WHY - the flag detail sentence used to
 * reach only a log line, leaving an operator a count like "34 flagged" and no
 * way to act on it. Price flags come first because they are the work queue.
 *
 * Fetches on open; the run id is captured by the caller, so the status card's
 * poll cannot swap out what is on screen. See GET /api/admin/model-discovery.
 */
export const DiscoveryRunDetailModal: React.FC<{ runId: string | null; onClose: () => void }> = ({
  runId,
  onClose,
}) => {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSkips, setShowSkips] = useState(false);

  const setAdminTab = useAdminModal(state => state.setActiveTab);
  const focusPricingModel = useCreditAnalysisStore(state => state.focusPricingModel);

  const unmounted = useRef(false);
  useEffect(() => {
    // Reset on mount, not just set on unmount: React can remount the same
    // instance (StrictMode does it deliberately), and a ref left true discards
    // every post-await state write, leaving the modal spinning forever.
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  // Latest requested run; a slower earlier response must not overwrite the run
  // currently displayed, the same guard ModelPricingCatalog's history uses.
  const requestedRunId = useRef<string | null>(null);

  useEffect(() => {
    requestedRunId.current = runId;
    if (!runId) return;
    setRun(null);
    setError(null);
    setShowSkips(false);
    setIsLoading(true);
    void (async () => {
      try {
        const res = await api.get<{ run: RunDetail }>(`/api/admin/model-discovery?runId=${encodeURIComponent(runId)}`);
        if (unmounted.current || requestedRunId.current !== runId) return;
        setRun(res.data.run);
      } catch (err) {
        if (unmounted.current || requestedRunId.current !== runId) return;
        setError(apiErrorMessage(err, 'Failed to load the discovery run'));
      } finally {
        if (!unmounted.current && requestedRunId.current === runId) setIsLoading(false);
      }
    })();
  }, [runId]);

  const jumpToPricing = (modelId: string) => {
    focusPricingModel(modelId);
    setAdminTab(AdminTab.CreditAnalytics);
    onClose();
  };

  const changes = run?.changes;
  // The plan is reported identically in both modes, so a write-mode run whose
  // appends all threw looks clean everywhere except here. Write mode ONLY: report
  // mode plans rows and writes none by design, and warning about that on every
  // report run (the default mode) is how the warning stops meaning anything.
  const writeGaps =
    changes && run?.mode === 'write'
      ? [
          ...(changes.plannedPriceRows > changes.appendedPriceRows
            ? [`${changes.plannedPriceRows} price rows planned, ${changes.appendedPriceRows} appended`]
            : []),
          ...(changes.plannedRows > changes.appendedRows
            ? [`${changes.plannedRows} catalog rows planned, ${changes.appendedRows} appended`]
            : []),
        ]
      : [];

  const overrideCount = countLabel(run?.priceOverrides?.length ?? 0, run?.detailTotals?.priceOverrides);

  return (
    <Modal open={!!runId} onClose={onClose}>
      <ModalDialog
        sx={{ width: 'min(1100px, 96vw)', maxHeight: '90vh', overflow: 'auto' }}
        data-testid="discovery-run-modal"
      >
        <ModalClose />
        <Typography level="title-md" sx={{ pr: 4 }}>
          Discovery run
        </Typography>
        <Typography level="body-xs" sx={{ fontFamily: 'monospace', color: 'neutral.500', mb: 1 }}>
          {runId}
        </Typography>

        {error && (
          <Alert color="danger" size="sm" sx={{ mb: 1 }} data-testid="discovery-run-error">
            {error}
          </Alert>
        )}

        {isLoading && !run ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
            <CircularProgress data-testid="discovery-run-loading" />
          </Box>
        ) : (
          run && (
            <Stack spacing={1.5}>
              <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                <Chip size="sm" color={STATUS_COLOR[run.status] ?? 'neutral'} data-testid="discovery-run-status-chip">
                  {run.status}
                </Chip>
                <Typography level="body-xs" data-testid="discovery-run-header">
                  {run.trigger} on {run.host}, started {formatTime(run.startedAt)}
                  {run.finishedAt ? `, finished ${formatTime(run.finishedAt)}` : ', still running'}
                </Typography>
                <Typography level="body-xs" color="neutral" data-testid="discovery-run-change-counts">
                  {run.changes.added.length} added, {run.changes.promoted.length} promoted,{' '}
                  {run.changes.deprecated.length} deprecated, {run.changes.repriced.length} repriced,{' '}
                  {run.changes.flagged.length} flagged
                </Typography>
              </Stack>

              {run.mode === 'report' && (
                <Alert color="primary" size="sm" data-testid="discovery-run-report-mode">
                  Report mode: this run computed the plan below and wrote nothing. Every count is what it would have
                  changed, not what changed.
                </Alert>
              )}

              {writeGaps.length > 0 && (
                <Alert color="warning" size="sm" data-testid="discovery-run-write-gap">
                  Writes were planned and did not land: {writeGaps.join('; ')}. The run still reports {run.status}.
                </Alert>
              )}

              {run.priceFlags.length > 0 && (
                <Section
                  title={`Price flags (${countLabel(run.priceFlags.length, run.detailTotals?.priceFlags)}) - discovered prices this run refused to write`}
                  sx={{ borderColor: 'warning.400', borderWidth: 2 }}
                >
                  <Table size="sm" data-testid="discovery-run-price-flags-table">
                    <thead>
                      <tr>
                        <th style={{ width: '18%' }}>Model</th>
                        <th style={{ width: '13%' }}>Kind</th>
                        <th style={{ width: '13%' }}>Proposed $/M</th>
                        <th style={{ width: '13%' }}>In force $/M</th>
                        <th style={{ width: '11%' }}>Sources</th>
                        <th>Why</th>
                        <th style={{ width: '8%' }} aria-label="actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {run.priceFlags.map(flag => (
                        <tr key={`${flag.modelId}|${flag.kind}`} data-testid={`discovery-run-flag-row-${flag.modelId}`}>
                          <td>{flag.modelId}</td>
                          <td>
                            <Chip size="sm" variant="soft" color={FLAG_KIND_COLOR[flag.kind] ?? 'neutral'}>
                              {flag.kind}
                            </Chip>
                          </td>
                          <td>{inOut(flag.proposed)}</td>
                          <td>{inOut(flag.current)}</td>
                          <td>{list(flag.sources)}</td>
                          {/* Never truncated: this sentence is what the operator came for. */}
                          <td data-testid={`discovery-run-flag-detail-${flag.modelId}`}>{flag.detail}</td>
                          <td>
                            {/* component="button": a Joy Link with an onClick and no
                                href renders an <a> with no href, which no keyboard
                                can reach. Same as DiscoveryStatusCard's links. */}
                            <Link
                              level="body-xs"
                              component="button"
                              startDecorator={<OpenInNewIcon sx={{ fontSize: 14 }} />}
                              onClick={() => jumpToPricing(flag.modelId)}
                              data-testid={`discovery-run-flag-pricing-${flag.modelId}`}
                            >
                              pricing
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </Section>
              )}

              {/* operatorOwned in b4m-core/services/src/modelDiscoveryService/types.ts
                  is "an operator-owned CATALOG row exists for this model" and nothing
                  more: not a divergence, not a value comparison, and nothing to do
                  with prices (a price the operator owns is flagged above as
                  operator-owned-divergence instead). */}
              {run.changes.operatorConflicts.length > 0 && (
                <Section
                  title={`Operator-owned models this run planned a catalog change for (${run.changes.operatorConflicts.length})`}
                >
                  <Typography level="body-xs" color="neutral" data-testid="discovery-run-operator-conflicts">
                    An operator catalog row exists for these {run.changes.operatorConflicts.length} models, so the
                    groups it owns keep winning the merge and some of what discovery planned will not show up in the
                    catalog: {list(run.changes.operatorConflicts)}
                  </Typography>
                </Section>
              )}

              {run.priceRows.length > 0 && (
                <Section
                  title={
                    // Nothing was repriced on a run that wrote nothing, and an older
                    // run carries no mode to claim either way.
                    run.mode === 'write'
                      ? `Repriced (${countLabel(run.priceRows.length, run.detailTotals?.priceRows)})`
                      : `Price rows planned (${countLabel(run.priceRows.length, run.detailTotals?.priceRows)})`
                  }
                >
                  <Table size="sm" data-testid="discovery-run-price-rows-table">
                    <thead>
                      <tr>
                        <th>Model</th>
                        <th>$/M in</th>
                        <th>$/M out</th>
                        <th>Sources</th>
                        <th>Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* Keyed by index as well: priceRows is a plain flatMap across
                          convergence passes (see aggregate() in runModelDiscovery.ts),
                          so two rows for one modelId+unit are legitimate. */}
                      {run.priceRows.map((row, index) => (
                        <tr
                          key={`${row.modelId}|${row.unit}|${index}`}
                          data-testid={`discovery-run-price-row-${row.modelId}-${index}`}
                        >
                          <td>{row.modelId}</td>
                          <td>{usdPerMTok(row.inputPerMTok)}</td>
                          <td>{usdPerMTok(row.outputPerMTok)}</td>
                          <td>{list(row.sources)}</td>
                          <td>{row.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </Section>
              )}

              {/* Called out because the interesting fact is not the price but the
                  mirror: a source that disagreed with the provider is one that has
                  gone stale. The title is deliberately tense-neutral - a
                  report-mode run applied nothing, and these are raised for an
                  unchanged row too, so any wording claiming a write would be false
                  directly under the "wrote nothing" banner. */}
              {(run.priceOverrides?.length ?? 0) > 0 && (
                <Section title={`Overruled a disagreeing source (${overrideCount})`}>
                  <Table size="sm" data-testid="discovery-run-price-overrides-table">
                    <thead>
                      <tr>
                        <th style={{ width: '18%' }}>Model</th>
                        <th style={{ width: '13%' }}>Rate $/M</th>
                        <th style={{ width: '13%' }}>From</th>
                        <th style={{ width: '13%' }}>Overruled</th>
                        <th>Why</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(run.priceOverrides ?? []).map(override => (
                        <tr key={override.modelId} data-testid={`discovery-run-price-override-row-${override.modelId}`}>
                          <td>{override.modelId}</td>
                          <td>{inOut(override.applied)}</td>
                          <td>{override.source}</td>
                          <td>{list(override.dissenting)}</td>
                          <td data-testid={`discovery-run-price-override-detail-${override.modelId}`}>
                            {override.detail}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </Section>
              )}

              {run.lifecycleTransitions.length > 0 && (
                <Section
                  title={`Lifecycle transitions (${countLabel(
                    run.lifecycleTransitions.length,
                    run.detailTotals?.lifecycleTransitions
                  )})`}
                >
                  <Table size="sm" data-testid="discovery-run-lifecycle-table">
                    <thead>
                      <tr>
                        <th>Model</th>
                        <th>Change</th>
                        <th>Signal</th>
                        <th>Deprecation</th>
                        <th>Retirement</th>
                        <th>Successor</th>
                        <th>Applied</th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* Indexed for the same reason as the price rows: transitions are
                          flatMapped across passes, not collapsed per model. */}
                      {run.lifecycleTransitions.map((transition, index) => (
                        <tr
                          key={`${transition.modelId}|${index}`}
                          data-testid={`discovery-run-lifecycle-row-${transition.modelId}-${index}`}
                        >
                          <td>{transition.modelId}</td>
                          <td>
                            {transition.from ?? 'none'} {'->'} {transition.to}
                          </td>
                          <td>{transition.signal}</td>
                          <td>{transition.deprecationDate ?? '-'}</td>
                          <td>{transition.retirementDate ?? '-'}</td>
                          <td>{transition.replacedBy ?? '-'}</td>
                          <td>
                            <Chip size="sm" variant="soft" color={transition.autoApplied ? 'success' : 'neutral'}>
                              {transition.autoApplied ? 'auto-applied' : 'suggestion'}
                            </Chip>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </Section>
              )}

              {run.catalogDiff.length > 0 && (
                <Section
                  title={`Catalog changes (${countLabel(run.catalogDiff.length, run.detailTotals?.catalogDiff)})`}
                >
                  <Table size="sm" data-testid="discovery-run-catalog-table">
                    <thead>
                      <tr>
                        <th>Model</th>
                        <th>Kind</th>
                        <th>Changed keys</th>
                        <th>Lifecycle</th>
                        <th>Promoted</th>
                        <th>Blocked by</th>
                        <th>Operator owned</th>
                      </tr>
                    </thead>
                    <tbody>
                      {run.catalogDiff.map(entry => (
                        <tr key={entry.modelId} data-testid={`discovery-run-catalog-row-${entry.modelId}`}>
                          <td>{entry.modelId}</td>
                          <td>{entry.kind}</td>
                          <td>{list(entry.changedKeys)}</td>
                          <td>{entry.lifecycleStatus}</td>
                          <td>{entry.promoted ? 'yes' : 'no'}</td>
                          <td>{list(entry.blockedBy)}</td>
                          <td>{entry.operatorOwned ? 'yes' : 'no'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </Section>
              )}

              {run.priceSkips.length > 0 && (
                <Section title={`Not repriced (${countLabel(run.priceSkips.length, run.detailTotals?.priceSkips)})`}>
                  <Link
                    level="body-xs"
                    component="button"
                    onClick={() => setShowSkips(v => !v)}
                    data-testid="discovery-run-skips-toggle"
                  >
                    {showSkips ? 'hide' : 'show'} the observations that produced neither a row nor a flag
                  </Link>
                  {showSkips && (
                    <Table size="sm" data-testid="discovery-run-skips-table">
                      <thead>
                        <tr>
                          <th style={{ width: '40%' }}>Model</th>
                          <th>Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {run.priceSkips.map(skip => (
                          <tr key={`${skip.modelId}|${skip.reason}`}>
                            <td>{skip.modelId}</td>
                            <td>{skip.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  )}
                </Section>
              )}

              <Section title="Run mechanics">
                <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
                  <Chip size="sm" variant="outlined" data-testid="discovery-run-passes">
                    {run.passes} passes
                  </Chip>
                  {run.joinCoverage.map(coverage => (
                    <Chip
                      key={coverage.aggregator}
                      size="sm"
                      variant="outlined"
                      data-testid={`discovery-run-coverage-${coverage.aggregator}`}
                    >
                      {coverage.aggregator} {coverage.matched}/{coverage.total}
                    </Chip>
                  ))}
                  <Typography level="body-xs" color="neutral" data-testid="discovery-run-counters">
                    catalog rows {run.changes.appendedRows}/{run.changes.plannedRows} appended, price rows{' '}
                    {run.changes.appendedPriceRows}/{run.changes.plannedPriceRows} appended
                  </Typography>
                </Stack>
                {run.sources.length > 0 && (
                  <Table size="sm" data-testid="discovery-run-sources-table">
                    <thead>
                      <tr>
                        <th>Source</th>
                        <th>Ok</th>
                        <th>ms</th>
                        <th>HTTP</th>
                        <th>Records</th>
                        <th>Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {run.sources.map(source => (
                        <tr key={source.name} data-testid={`discovery-run-source-row-${source.name}`}>
                          <td>{source.name}</td>
                          <td>
                            <Chip size="sm" variant="soft" color={source.ok ? 'success' : 'danger'}>
                              {source.ok ? 'ok' : 'failed'}
                            </Chip>
                          </td>
                          <td>{source.durationMs}</td>
                          <td>{source.httpStatus ?? '-'}</td>
                          <td>{source.recordCount ?? '-'}</td>
                          <td>{source.error ?? '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
                {run.unmatchedIds.length > 0 && (
                  <Typography level="body-xs" color="neutral" sx={{ mt: 0.5 }} data-testid="discovery-run-unmatched">
                    Unmatched by every aggregator ({run.unmatchedIds.length}): {list(run.unmatchedIds)}
                  </Typography>
                )}
                {run.droppedRecords.length > 0 && (
                  <Table size="sm" sx={{ mt: 0.5 }} data-testid="discovery-run-dropped-table">
                    <thead>
                      <tr>
                        <th>Dropped record</th>
                        <th>Source</th>
                        <th>Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {run.droppedRecords.map(dropped => (
                        <tr key={`${dropped.source}|${dropped.modelId}|${dropped.reason}`}>
                          <td>{dropped.modelId}</td>
                          <td>{dropped.source}</td>
                          <td>{dropped.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Section>
            </Stack>
          )
        )}
      </ModalDialog>
    </Modal>
  );
};

export default DiscoveryRunDetailModal;
