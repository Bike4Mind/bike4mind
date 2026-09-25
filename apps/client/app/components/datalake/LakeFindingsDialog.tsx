import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  DialogContent,
  DialogTitle,
  Modal,
  ModalClose,
  ModalDialog,
  Option,
  Select,
  Tooltip,
  Typography,
} from '@mui/joy';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import RuleFolderOutlinedIcon from '@mui/icons-material/RuleFolderOutlined';
import type {
  IDataLakeFindingDocument,
  InconsistencyKind,
  LakeFindingStatus,
  LakeHealthApiResponse,
} from '@bike4mind/common';
import { INCONSISTENCY_KINDS, LAKE_FINDING_STATUSES } from '@bike4mind/common';
import { useDataLakeFindings, useGetDataLakeHealth } from '@client/app/hooks/data/dataLakes';
import FindingSourcePane from './FindingSourcePane';
import {
  FINDING_DETECTOR_LABEL,
  FINDING_KIND_HINT,
  FINDING_KIND_LABEL,
  FINDING_STATUS_LABEL,
  formatFindingDate,
  hasRecurredSinceResolution,
} from './findingCopy';

/**
 * The curator's read of one lake's detected corpus problems (#3044): a filterable list, and the
 * conflicting passages of one finding side by side in the documents they came from.
 *
 * READ-ONLY, deliberately and not by omission. Recording what a curator decided is #3045 and
 * changing the corpus is #3046; this surface exists so that a curator can LOOK at a problem, which
 * until now they could not do at all. Nothing here writes.
 */

/**
 * One page of the queue, well under the route's own 200 ceiling. `hasMore` comes straight from the
 * route's own response, not from comparing this to the page length client-side.
 */
const FINDINGS_PAGE_LIMIT = 50;

/** The value the filter Selects carry for "do not narrow". `undefined` cannot round-trip a Select. */
const ANY = 'any';

function FindingRow({ finding, onOpen }: { finding: IDataLakeFindingDocument; onOpen: () => void }) {
  const recurred = hasRecurredSinceResolution(finding);
  return (
    <Box
      data-testid={`lake-finding-row-${finding.id}`}
      // Opening a finding is the whole point of this surface, so the row carries button semantics
      // rather than a bare click handler - without them the detail view is mouse-only and a
      // keyboard or screen-reader curator can reach the filters and nothing else.
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        // Space scrolls the list otherwise, which moves the row out from under the press.
        event.preventDefault();
        onOpen();
      }}
      sx={{
        p: 1.5,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 'sm',
        cursor: 'pointer',
        '&:hover': { borderColor: 'primary.outlinedBorder', bgcolor: 'background.level1' },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.solidBg', outlineOffset: '2px' },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
        <Tooltip title={FINDING_KIND_HINT[finding.kind]} size="sm">
          <Chip size="sm" variant="soft" color="warning" sx={{ fontSize: '11px' }}>
            {FINDING_KIND_LABEL[finding.kind]}
          </Chip>
        </Tooltip>
        <Chip
          size="sm"
          variant="soft"
          color={finding.status === 'open' ? 'primary' : 'neutral'}
          sx={{ fontSize: '11px' }}
          data-testid="lake-finding-status"
        >
          {FINDING_STATUS_LABEL[finding.status]}
        </Chip>
        {/* A closed finding the detector keeps seeing. The model refuses to reopen it under the
            curator who closed it, so this chip is the only place that state is visible. */}
        {recurred && (
          <Tooltip title="This was ruled on, but the detector has seen it again since." size="sm">
            <Chip size="sm" variant="soft" color="danger" sx={{ fontSize: '11px' }} data-testid="lake-finding-recurred">
              Seen again
            </Chip>
          </Tooltip>
        )}
      </Box>
      {/* `subject` is normalized text lifted from member documents - a metric label, an org name.
          It is data, never markup, and is rendered as plain text for that reason. */}
      <Typography level="title-sm" sx={{ wordBreak: 'break-word' }} data-testid="lake-finding-subject">
        {finding.subject}
      </Typography>
      <Typography level="body-xs" textColor="text.tertiary">
        {`${finding.documentCount} document(s) \u00b7 ${FINDING_DETECTOR_LABEL[finding.detector]} \u00b7 last seen ${formatFindingDate(finding.lastSeenAt)}`}
      </Typography>
    </Box>
  );
}

function FindingDetail({ finding, onBack }: { finding: IDataLakeFindingDocument; onBack: () => void }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%', gap: 1.5 }}>
      <Box>
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          startDecorator={<ArrowBackIcon sx={{ fontSize: 16 }} />}
          onClick={onBack}
          data-testid="lake-finding-back-btn"
        >
          All findings
        </Button>
      </Box>
      <Box>
        <Typography level="title-md" sx={{ wordBreak: 'break-word' }}>
          {`${FINDING_KIND_LABEL[finding.kind]}: ${finding.subject}`}
        </Typography>
        <Typography level="body-xs" textColor="text.secondary">
          {FINDING_KIND_HINT[finding.kind]}
        </Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          {`${FINDING_DETECTOR_LABEL[finding.detector]} \u00b7 first seen ${formatFindingDate(finding.firstSeenAt)} \u00b7 last seen ${formatFindingDate(finding.lastSeenAt)} \u00b7 reaches ${finding.documentCount} document(s)`}
        </Typography>
      </Box>

      {/* The hedge, stated where the evidence is, not only in the list. These rules are patterns
          over prose: a finding is a prompt to read, and the two passages below are what the curator
          reads. Saying so is a requirement of the detector, not decoration. */}
      <Alert color="neutral" size="sm" data-testid="lake-finding-advisory">
        <Typography level="body-xs">
          Detected by pattern, not proven. Read both passages in context before concluding the documents disagree.
        </Typography>
      </Alert>

      {/* Two up, which is the shape of a cross-document conflict; a finding reaching more documents
          wraps into further rows rather than being cut down to the first pair. */}
      <Box
        data-testid="lake-finding-sources"
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
          gap: 1.5,
          overflow: 'auto',
        }}
      >
        {finding.sources.map(source => (
          <FindingSourcePane key={source.fabFileId} source={source} />
        ))}
      </Box>
    </Box>
  );
}

export function LakeFindingsDialog({
  open,
  onClose,
  dataLakeId,
  lakeName,
}: {
  open: boolean;
  onClose: () => void;
  dataLakeId: string;
  lakeName: string;
}) {
  const [status, setStatus] = useState<LakeFindingStatus | undefined>('open');
  const [kind, setKind] = useState<InconsistencyKind | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Held closed by the hook's own `enabled` rather than by nulling the lake id, which would key a
  // second, empty cache entry no invalidation reaches. The open-status default also matches the
  // chip's query exactly, so opening the dialog reads the fetch the chip already made.
  const {
    data: findings,
    isLoading,
    error,
    isForbidden,
    hasMore,
    loadMore,
    isLoadingMore,
  } = useDataLakeFindings(dataLakeId, { status, kind, limit: FINDINGS_PAGE_LIMIT }, { enabled: open });

  // Derived from the live list rather than held as a snapshot, so a refetch that drops or updates
  // the open finding takes the curator back to the list instead of leaving stale passages on screen.
  const selected = useMemo(() => findings?.find(f => f.id === selectedId) ?? null, [findings, selectedId]);

  // Narrowing drops the selection. It is otherwise possible to be returned to the list by a refetch
  // that dropped the open finding, still holding its id, and then be thrown back into its detail
  // pane unasked by a filter change that happens to bring it back.
  const narrow = (apply: () => void) => {
    setSelectedId(null);
    apply();
  };

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog layout="fullscreen" data-testid="lake-findings-dialog">
        <ModalClose />
        <DialogTitle>{`Findings in "${lakeName}"`}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {selected ? (
            <FindingDetail finding={selected} onBack={() => setSelectedId(null)} />
          ) : (
            <>
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1.5 }}>
                <Select
                  size="sm"
                  value={status ?? ANY}
                  onChange={(_, value) =>
                    narrow(() => setStatus(value === ANY ? undefined : (value as LakeFindingStatus)))
                  }
                  slotProps={{ button: { 'data-testid': 'lake-findings-status-filter' } }}
                  sx={{ minWidth: '9rem' }}
                >
                  <Option value={ANY}>Any status</Option>
                  {LAKE_FINDING_STATUSES.map(value => (
                    <Option key={value} value={value}>
                      {FINDING_STATUS_LABEL[value]}
                    </Option>
                  ))}
                </Select>
                <Select
                  size="sm"
                  value={kind ?? ANY}
                  onChange={(_, value) =>
                    narrow(() => setKind(value === ANY ? undefined : (value as InconsistencyKind)))
                  }
                  slotProps={{ button: { 'data-testid': 'lake-findings-kind-filter' } }}
                  sx={{ minWidth: '12rem' }}
                >
                  <Option value={ANY}>Any kind</Option>
                  {INCONSISTENCY_KINDS.map(value => (
                    <Option key={value} value={value}>
                      {FINDING_KIND_LABEL[value]}
                    </Option>
                  ))}
                </Select>
              </Box>

              {isLoading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }} data-testid="lake-findings-loading">
                  <CircularProgress size="sm" />
                </Box>
              ) : isForbidden ? (
                <Alert color="neutral" size="sm" data-testid="lake-findings-forbidden">
                  <Typography level="body-xs">
                    Findings quote the text of this lake&apos;s documents, so only someone who can manage the lake may
                    read them.
                  </Typography>
                </Alert>
              ) : error ? (
                <Alert color="danger" size="sm" data-testid="lake-findings-error">
                  Could not load findings for this lake. Try again shortly.
                </Alert>
              ) : !findings?.length ? (
                <Typography level="body-sm" textColor="text.secondary" data-testid="lake-findings-empty">
                  {/* Never "this lake is clean": detection is an owner-triggered pass, so an empty
                      list means nothing was found by the runs that happened, not that none exist. */}
                  Nothing matches these filters. Findings appear here after a detection run.
                </Typography>
              ) : (
                <Box
                  sx={{ display: 'flex', flexDirection: 'column', gap: 1, overflow: 'auto', minHeight: 0 }}
                  data-testid="lake-findings-list"
                >
                  {findings.map(finding => (
                    <FindingRow key={finding.id} finding={finding} onOpen={() => setSelectedId(finding.id)} />
                  ))}
                  {hasMore && (
                    <Button
                      size="sm"
                      variant="plain"
                      color="neutral"
                      loading={isLoadingMore}
                      onClick={() => loadMore()}
                      data-testid="lake-findings-load-more"
                    >
                      Load more
                    </Button>
                  )}
                </Box>
              )}
            </>
          )}
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
}

type ChipDisplay = {
  label: string;
  tooltip: string;
  color: 'warning' | 'neutral';
};

/**
 * What the chip says about the last detection run when there is no open work. An empty open query
 * alone cannot tell "never scanned" from "scanned and clean", so the run's own stamp
 * (`inconsistency` on GET /health) is what separates them. Either query not having answered yet
 * (or having failed) leaves the chip on its bare label rather than guessing: `openFindingsUnresolved`
 * covers the open-findings query (loading, or errored under `retry: false`), and
 * `inconsistency === undefined` covers health.
 */
export function findingsChipDisplay({
  openCount,
  hasMore,
  openFindingsUnresolved,
  inconsistency,
}: {
  openCount: number;
  hasMore: boolean;
  openFindingsUnresolved: boolean;
  inconsistency: LakeHealthApiResponse['inconsistency'] | undefined;
}): ChipDisplay {
  if (openCount > 0) {
    return {
      // A full page is a lower bound, so it reads `50+` rather than claiming an exact count.
      label: `${openCount}${hasMore ? '+' : ''} to review`,
      tooltip: 'Documents in this lake appear to contradict each other. Review the passages.',
      color: 'warning',
    };
  }
  if (openFindingsUnresolved || inconsistency === undefined) {
    return {
      label: 'Findings',
      tooltip: "Review this lake's detected findings, including past ones.",
      color: 'neutral',
    };
  }
  if (inconsistency === null) {
    return {
      label: 'Not scanned yet',
      tooltip: 'This lake has not been checked for contradicting documents yet.',
      color: 'neutral',
    };
  }
  const checked = formatFindingDate(inconsistency.computedAt);
  // A run that read no members found nothing because it looked at nothing - not a clean lake.
  if (inconsistency.memberCount === 0) {
    return {
      label: `Nothing scanned · checked ${checked}`,
      tooltip: 'The last check had no documents it could read, so it could not look for contradictions.',
      color: 'neutral',
    };
  }
  return {
    // "open", because dismissed or resolved findings may still exist behind the chip.
    label: `No open findings · checked ${checked}`,
    tooltip: "No open contradictions in the last check. Review this lake's past findings.",
    color: 'neutral',
  };
}

/**
 * The affordance that reaches the dialog, in the lake manager's badge row.
 *
 * Always rendered for a manager, regardless of the open count: a lake whose only findings are
 * dismissed or resolved still has history worth reviewing, and gating this on the open-only query
 * would make it unreachable in that state even though the route serves those rows. The open count
 * only changes its color/label - warning + a count when there is open work, neutral otherwise, with
 * the last detection run's state as the label (see `findingsChipDisplay`).
 * Gated on `canManage` to match the route, which refuses a reader because the rows carry document
 * excerpts.
 */
export default function LakeFindingsChip({
  lakeId,
  lakeName,
  canManage,
}: {
  lakeId: string;
  lakeName: string;
  canManage: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { data: findings, hasMore } = useDataLakeFindings(
    lakeId,
    { status: 'open', limit: FINDINGS_PAGE_LIMIT },
    {
      enabled: canManage,
    }
  );
  // Same query key as the health badge beside this chip, so it shares that fetch rather than adding one.
  const { data: health } = useGetDataLakeHealth(lakeId, canManage);
  const display = findingsChipDisplay({
    openCount: findings?.length ?? 0,
    hasMore,
    openFindingsUnresolved: findings === undefined,
    inconsistency: health?.inconsistency,
  });

  if (!canManage) return null;

  return (
    <>
      <Tooltip title={display.tooltip} size="sm">
        <Chip
          size="sm"
          variant="soft"
          color={display.color}
          startDecorator={<RuleFolderOutlinedIcon sx={{ fontSize: 12 }} />}
          onClick={() => setOpen(true)}
          sx={{ fontSize: '11px', cursor: 'pointer' }}
          data-testid={`datalake-findings-chip-${lakeId}`}
        >
          {display.label}
        </Chip>
      </Tooltip>
      {/* The dialog is independent of the open-findings state on purpose. The chip's color/label is
          derived from the OPEN query, and the curator inside may be reading dismissed ones - so an
          invalidation that empties the open query would otherwise yank the whole surface off screen
          mid-read. */}
      <LakeFindingsDialog open={open} onClose={() => setOpen(false)} dataLakeId={lakeId} lakeName={lakeName} />
    </>
  );
}
