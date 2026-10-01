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
  Textarea,
  Tooltip,
  Typography,
} from '@mui/joy';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import RuleFolderOutlinedIcon from '@mui/icons-material/RuleFolderOutlined';
import RadarIcon from '@mui/icons-material/Radar';
import type {
  IDataLakeFindingDocument,
  InconsistencyKind,
  LakeFindingStatus,
  LakeHealthApiResponse,
} from '@bike4mind/common';
import { INCONSISTENCY_KINDS, LAKE_FINDING_RESOLUTION_MAX_CHARS, LAKE_FINDING_STATUSES } from '@bike4mind/common';
import {
  useDataLakeFindings,
  useGetDataLakeHealth,
  useLakeAccessView,
  useRuleOnDataLakeFinding,
  useScanDataLakeFindings,
} from '@client/app/hooks/data/dataLakes';
import { useUser } from '@client/app/contexts/UserContext';
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
 * The list is read-only, but the DETAIL view is where a curator rules on a finding (#3045): resolve
 * or dismiss it with an optional note, and set or clear its assignee. Changing the corpus is still
 * out of scope and has no control here (#3046). The one other write is "Scan now", which runs
 * detection on demand so a curator who just uploaded a conflicting document need not wait for the
 * nightly sweep to see it here.
 */

/**
 * One page of the queue, well under the route's own 200 ceiling. `hasMore` comes straight from the
 * route's own response, not from comparing this to the page length client-side.
 */
const FINDINGS_PAGE_LIMIT = 50;

/** The value the filter Selects carry for "do not narrow". `undefined` cannot round-trip a Select. */
const ANY = 'any';

const DEFAULT_STATUS_FILTER: LakeFindingStatus = 'open';

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

/**
 * Resolve or dismiss an open finding, with an optional note. A closed finding shows its ruling
 * instead - read-only, because the model is terminal by design (no route reopens one). The note is
 * capped server-side too; the counter and `maxLength` keep a curator from losing the tail of a long
 * sentence only after they submit.
 */
function FindingRuling({ finding, dataLakeId }: { finding: IDataLakeFindingDocument; dataLakeId: string }) {
  const [note, setNote] = useState('');
  const rule = useRuleOnDataLakeFinding(dataLakeId);

  if (finding.status !== 'open') {
    return (
      <Box data-testid="lake-finding-ruling" sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography level="body-xs" textColor="text.secondary">
          {`${FINDING_STATUS_LABEL[finding.status]} on ${formatFindingDate(finding.resolvedAt)}`}
        </Typography>
        {finding.resolution && (
          <Typography level="body-sm" sx={{ flexBasis: '100%', wordBreak: 'break-word' }}>
            {finding.resolution}
          </Typography>
        )}
        {/* The row carries this too, but the detail view is where a curator acts; the recurrence is
            the one fact that should follow them here. */}
        {hasRecurredSinceResolution(finding) && (
          <Chip size="sm" variant="soft" color="danger" sx={{ fontSize: '11px' }} data-testid="lake-finding-recurred">
            Seen again
          </Chip>
        )}
      </Box>
    );
  }

  const pending = rule.isPending;
  const ruleOn = (action: 'resolve' | 'dismiss') =>
    rule.mutate({ findingId: finding.id, action, resolution: note.trim() || undefined });

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Textarea
        size="sm"
        minRows={2}
        maxRows={4}
        value={note}
        onChange={event => setNote(event.target.value)}
        placeholder="Optional note: what did you find?"
        slotProps={{
          textarea: { maxLength: LAKE_FINDING_RESOLUTION_MAX_CHARS, 'data-testid': 'lake-finding-resolution-input' },
        }}
      />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Button
          size="sm"
          loading={pending}
          disabled={pending}
          onClick={() => ruleOn('resolve')}
          data-testid="lake-finding-resolve-btn"
        >
          Resolve
        </Button>
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          loading={pending}
          disabled={pending}
          onClick={() => ruleOn('dismiss')}
          data-testid="lake-finding-dismiss-btn"
        >
          Dismiss
        </Button>
        <Typography level="body-xs" textColor="text.tertiary">
          {`${note.length}/${LAKE_FINDING_RESOLUTION_MAX_CHARS}`}
        </Typography>
      </Box>
    </Box>
  );
}

/**
 * Set or clear a finding's assignee, available in every status - the route allows an assignment at
 * any time, and who owns triage is independent of whether the problem is closed.
 *
 * Candidates are the lake's owner/curator user grants from `useLakeAccessView`, read only while the
 * caller may manage the lake (`enabled`). That view is manage-gated, so a refusal simply hides the
 * picker; "Assign to me" and "Unassign" do not depend on it, because the route does not validate the
 * assignee against any candidate set. An assignee who no longer appears in the grants reads as
 * "Assigned to someone not listed" rather than being looked up - no second user fetch for a label.
 */
function FindingAssignee({
  finding,
  dataLakeId,
  canManage,
}: {
  finding: IDataLakeFindingDocument;
  dataLakeId: string;
  canManage: boolean;
}) {
  const currentUserId = useUser(state => state.currentUser?.id);
  const rule = useRuleOnDataLakeFinding(dataLakeId);
  const access = useLakeAccessView(dataLakeId, canManage);

  const candidates = useMemo(() => {
    const byId = new Map<string, string>();
    for (const grant of access.data?.view.grants ?? []) {
      if (grant.principalType !== 'user' || grant.status !== 'active') continue;
      if (grant.role !== 'owner' && grant.role !== 'curator') continue;
      if (!byId.has(grant.principalId)) byId.set(grant.principalId, grant.principalName ?? 'Unnamed curator');
    }
    return [...byId.entries()].map(([id, name]) => ({ id, name }));
  }, [access.data]);

  const assign = (assigneeUserId: string | null) =>
    rule.mutate({ findingId: finding.id, action: 'assign', assigneeUserId });

  const assignee = finding.assigneeUserId;
  const listedName = assignee ? candidates.find(candidate => candidate.id === assignee)?.name : undefined;
  const label = !assignee
    ? 'Unassigned'
    : assignee === currentUserId
      ? 'Assigned to you'
      : (listedName ?? 'Assigned to someone not listed');
  // Keep the Select's value among its own options: an assignee who holds no listed grant (e.g. an
  // org admin who used "Assign to me") would otherwise leave the control rendering blank.
  const assigneeUnlisted = !!assignee && !candidates.some(candidate => candidate.id === assignee);

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
      <Typography level="body-xs" textColor="text.secondary" data-testid="lake-finding-assignee">
        {label}
      </Typography>
      {candidates.length > 0 && (
        <Select
          size="sm"
          value={assignee ?? ''}
          disabled={rule.isPending}
          onChange={(_, value) => assign(value ? value : null)}
          slotProps={{ button: { 'data-testid': 'lake-finding-assignee-select' } }}
          sx={{ minWidth: '11rem' }}
        >
          <Option value="">Unassigned</Option>
          {assigneeUnlisted && (
            <Option value={assignee}>
              {assignee === currentUserId ? 'Assigned to you' : 'Assigned to someone not listed'}
            </Option>
          )}
          {candidates.map(candidate => (
            <Option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </Option>
          ))}
        </Select>
      )}
      {!!currentUserId && assignee !== currentUserId && (
        <Button
          size="sm"
          variant="plain"
          disabled={rule.isPending}
          onClick={() => assign(currentUserId)}
          data-testid="lake-finding-assign-me-btn"
        >
          Assign to me
        </Button>
      )}
      {!!assignee && (
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          disabled={rule.isPending}
          onClick={() => assign(null)}
          data-testid="lake-finding-unassign-btn"
        >
          Unassign
        </Button>
      )}
    </Box>
  );
}

function FindingDetail({
  finding,
  dataLakeId,
  canManage,
  onBack,
}: {
  finding: IDataLakeFindingDocument;
  dataLakeId: string;
  canManage: boolean;
  onBack: () => void;
}) {
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

      <FindingRuling finding={finding} dataLakeId={dataLakeId} />
      <FindingAssignee finding={finding} dataLakeId={dataLakeId} canManage={canManage} />

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
  canManage = true,
}: {
  open: boolean;
  onClose: () => void;
  dataLakeId: string;
  lakeName: string;
  /** Whether the caller may manage the lake; the access view behind the assignee picker is 403'd
   * without it, so it is fetched only when true. */
  canManage?: boolean;
}) {
  const [status, setStatus] = useState<LakeFindingStatus | undefined>(DEFAULT_STATUS_FILTER);
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
  const scan = useScanDataLakeFindings(dataLakeId);
  // Same query key as the chip's, so opening the dialog reads that fetch rather than adding one.
  const { data: health } = useGetDataLakeHealth(dataLakeId, open && canManage);

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
        <ModalClose aria-label="Close findings" data-testid="lake-findings-close-btn" />
        <DialogTitle>{`Findings in "${lakeName}"`}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {selected ? (
            <FindingDetail
              finding={selected}
              dataLakeId={dataLakeId}
              canManage={canManage}
              onBack={() => setSelectedId(null)}
            />
          ) : (
            <>
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1.5 }}>
                <Select
                  size="sm"
                  value={status ?? ANY}
                  onChange={(_, value) =>
                    narrow(() => setStatus(value === ANY ? undefined : (value as LakeFindingStatus)))
                  }
                  slotProps={{
                    button: { 'data-testid': 'lake-findings-status-filter', 'aria-label': 'Filter by status' },
                  }}
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
                  slotProps={{
                    button: { 'data-testid': 'lake-findings-kind-filter', 'aria-label': 'Filter by kind' },
                  }}
                  sx={{ minWidth: '12rem' }}
                >
                  <Option value={ANY}>Any kind</Option>
                  {INCONSISTENCY_KINDS.map(value => (
                    <Option key={value} value={value}>
                      {FINDING_KIND_LABEL[value]}
                    </Option>
                  ))}
                </Select>
                {/* Hidden when the read was refused: the run is gated on the same manage right. */}
                {!isForbidden && (
                  <Button
                    size="sm"
                    variant="outlined"
                    color="neutral"
                    startDecorator={<RadarIcon sx={{ fontSize: 16 }} />}
                    loading={scan.isPending}
                    onClick={() => scan.mutate()}
                    sx={{ ml: 'auto' }}
                    data-testid="lake-findings-scan-btn"
                  >
                    Scan now
                  </Button>
                )}
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
                  {findingsEmptyMessage({
                    inconsistency: health?.inconsistency,
                    filtered: status !== DEFAULT_STATUS_FILTER || kind !== undefined,
                  })}
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

const SCAN_SCHEDULE_HINT = 'Scans run nightly, or choose Scan now.';

/**
 * The dialog's empty-list copy, keyed on the last detection run the same way `findingsChipDisplay`
 * is: an empty list alone cannot tell "never scanned" from "nothing matched". Never "this lake is
 * clean" - detection is a pattern pass over a bounded sample, so an empty list means the runs that
 * happened found nothing, not that none exist.
 */
export function findingsEmptyMessage({
  inconsistency,
  filtered,
}: {
  inconsistency: LakeHealthApiResponse['inconsistency'] | undefined;
  /** Whether the curator has narrowed past the default open-only, any-kind view. */
  filtered: boolean;
}): string {
  if (inconsistency === undefined) {
    return `Nothing matches these filters. Findings appear after a scan. ${SCAN_SCHEDULE_HINT}`;
  }
  if (inconsistency === null) return `This lake has not been scanned yet. ${SCAN_SCHEDULE_HINT}`;
  const checked = formatFindingDate(inconsistency.computedAt);
  if (inconsistency.memberCount === 0) {
    return `The last scan (${checked}) had no documents it could read, so it could not look for contradictions.`;
  }
  if (filtered) return `Nothing matches these filters. Last scanned ${checked}.`;
  return `The last scan (${checked}) found nothing open to review.`;
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
      <LakeFindingsDialog
        open={open}
        onClose={() => setOpen(false)}
        dataLakeId={lakeId}
        lakeName={lakeName}
        canManage={canManage}
      />
    </>
  );
}
