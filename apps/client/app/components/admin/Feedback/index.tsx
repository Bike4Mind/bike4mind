import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Chip, ListDivider, MenuItem, Option, Select, Stack, Tooltip, Typography } from '@mui/joy';
import DownloadIcon from '@mui/icons-material/Download';
import RefreshIcon from '@mui/icons-material/Refresh';
import Papa from 'papaparse';
import { toast } from 'sonner';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  FEEDBACK_ID_PARAM,
  FEEDBACK_SUBJECTS,
  FEEDBACK_AI_AREAS,
  FEEDBACK_AI_SEVERITIES,
  FEEDBACK_RESOLUTIONS,
  FEEDBACK_RESOLUTION_LABELS,
  FeedbackStatus,
} from '@bike4mind/common';
import FeedbackCloseDialog from './FeedbackCloseDialog';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { CSV_FORMULA_PREFIX } from '@client/app/utils/csv';
import { relativeTimeFormat } from '@client/app/utils/dateUtils';
import { FEEDBACK_EXPORT_MAX_ROWS, getAllFeedbackForExport } from '@client/app/utils/feedbackAPICalls';
import {
  ActionDialog,
  ADMIN_REASON_PRESETS,
  AdminPageHeader,
  AdminSearchInput,
  DataTable,
  EmptyState,
  FilterChip,
  StatusChip,
  UpdatingBar,
  ViewTabs,
  type DataColumn,
} from '../shared';
import { ADMIN_REGION_GAP, adminFocus, adminFocusScope } from '../shared/adminStyles';
import { parseObjectId } from '../adminSearchValues';
import UserIdChip from '../Users/UserIdChip';
import { useFeedbackOperations } from './hooks/useFeedbackOperations';
import { useFeedbackFilters } from './hooks/useFeedbackFilters';
import { useFeedbackPagination } from './hooks/useFeedbackPagination';
import { getFeedbackDisplayContent, type IExtendedFeedbackDocument } from './types';
import FeedbackDetailDrawer from './FeedbackDetailDrawer';
import { useFeedbackDetailNavigation } from './hooks/useFeedbackDetailNavigation';
import { useFeedbackKeyboard } from './hooks/useFeedbackKeyboard';
import { copyFeedbackRecordLink, feedbackConversationPath, feedbackReporterMailto } from './feedbackLinks';
import HelpContextChip from './HelpContextChip';
import FeedbackTrendStrip from './FeedbackTrendStrip';
import { FEEDBACK_OPEN_STATUSES, FEEDBACK_RECEIVED_LABELS, FEEDBACK_RECEIVED_WINDOWS } from './feedbackTrends';
import {
  FEEDBACK_STATUS_LABELS,
  FEEDBACK_STATUS_ORDER,
  FEEDBACK_SUBJECT_LABELS,
  FEEDBACK_TYPE_LABELS,
  FEEDBACK_TYPE_ORDER,
  FEEDBACK_TYPE_TONES,
  feedbackTypeOf,
  toSubjectFilter,
} from './constants';
import {
  checkedStatuses,
  FEEDBACK_COMMENT_FILTERS,
  hasCreatedRange,
  toStatusFilters,
  type FeedbackCommentFilter,
} from './feedbackTabSearch';
import { FeedbackCreatedRangeDialog, formatCreatedRange } from './FeedbackCreatedRangeDialog';
import { useFeedbackSelection } from './hooks/useFeedbackSelection';
import FeedbackBulkActions from './FeedbackBulkActions';
import { RowActionsMenu } from '../shared/RowActionsMenu';

type FeedbackRow = IExtendedFeedbackDocument;

const STATUS_FILTER_OPTIONS = FEEDBACK_STATUS_ORDER.map(status => ({
  value: status,
  label: FEEDBACK_STATUS_LABELS[status],
}));
const SUBJECT_FILTER_OPTIONS = FEEDBACK_SUBJECTS.map(subject => ({
  value: subject,
  label: FEEDBACK_SUBJECT_LABELS[subject],
}));
const TYPE_FILTER_OPTIONS = FEEDBACK_TYPE_ORDER.map(type => ({
  value: type,
  label: FEEDBACK_TYPE_LABELS[type],
}));
const RECEIVED_FILTER_OPTIONS = FEEDBACK_RECEIVED_WINDOWS.map(range => ({
  value: range,
  label: FEEDBACK_RECEIVED_LABELS[range],
}));
const CUSTOM_RANGE = 'custom';
const COMMENT_FILTER_LABELS: Record<FeedbackCommentFilter, string> = { with: 'Has comment', without: 'No comment' };
const COMMENT_FILTER_OPTIONS = FEEDBACK_COMMENT_FILTERS.map(comment => ({
  value: comment,
  label: COMMENT_FILTER_LABELS[comment],
}));

// Built-in status views above the list. New is the default; a view lights when the status filter
// matches it exactly, and picking one leaves every other filter alone.
const STATUS_VIEWS = [
  { id: 'new', label: 'New', statuses: [FeedbackStatus.New] },
  { id: 'open', label: 'Open', statuses: [...FEEDBACK_OPEN_STATUSES] },
  { id: 'all', label: 'All', statuses: [...FEEDBACK_STATUS_ORDER] },
] as const;

// Tags the producers add that only restate the type chip; the rest (help, slash command,
// marketing...) still say where a report came from.
const TYPE_RESTATING_TAGS = new Set(['bug', 'bugReport', 'feedback']);
const VISIBLE_TAG_COUNT = 2;

const reporterName = (row: FeedbackRow) => row.username || row.userEmail || 'an unknown user';

const formatCreatedAt = (createdAt: Date | string) =>
  new Date(createdAt).toLocaleString('default', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

const CreatedCell = ({ row }: { row: FeedbackRow }) => (
  <Tooltip title={formatCreatedAt(row.createdAt)} placement="top-start">
    <Typography level="body-sm" noWrap data-testid={`feedback-row-created-${row._id}`}>
      {relativeTimeFormat(new Date(row.createdAt))}
    </Typography>
  </Tooltip>
);

const ReporterName = ({ row }: { row: FeedbackRow }) => {
  const name = (
    <Typography level="body-sm" noWrap title={row.username} sx={{ maxWidth: '100%', color: 'inherit' }}>
      {row.username}
    </Typography>
  );
  // Reports without an account (the waitlist form writes 'Unknown') have no profile to open.
  const userId = parseObjectId(row.userId);
  if (!userId) return name;
  return (
    <Link
      to="/admin/users/$userId"
      params={{ userId }}
      data-testid={`feedback-row-reporter-link-${row._id}`}
      style={{ flexShrink: 0, maxWidth: '70%', textDecoration: 'none', color: 'var(--joy-palette-admin-link)' }}
    >
      {name}
    </Link>
  );
};

const ReporterCell = ({ row }: { row: FeedbackRow }) => {
  const organization = row.organization && row.organization !== 'Unknown' ? row.organization : undefined;
  return (
    <Stack gap={0.25} alignItems="flex-start" sx={{ minWidth: 0, maxWidth: '100%' }}>
      <Stack direction="row" alignItems="baseline" gap={0.75} sx={{ minWidth: 0, width: '100%' }}>
        {row.username && <ReporterName row={row} />}
        {organization && (
          <Typography level="body-xs" noWrap title={organization} sx={{ color: 'admin.inkMuted', minWidth: 0 }}>
            {organization}
          </Typography>
        )}
      </Stack>
      <Stack direction="row" alignItems="center" gap={0.5} sx={{ minWidth: 0, maxWidth: '100%' }}>
        {row.userEmail && (
          <Typography level="body-xs" noWrap title={row.userEmail} sx={{ color: 'admin.inkMuted', minWidth: 0 }}>
            {row.userEmail}
          </Typography>
        )}
        {row.userId && <UserIdChip userId={row.userId} />}
      </Stack>
    </Stack>
  );
};

const ReportMeta = ({ row }: { row: FeedbackRow }) => {
  const type = feedbackTypeOf(row.type);
  const tags = (row.tags ?? []).filter(tag => !TYPE_RESTATING_TAGS.has(tag));
  const hiddenTags = tags.length - VISIBLE_TAG_COUNT;
  return (
    <Stack direction="row" flexWrap="wrap" alignItems="center" gap={0.75}>
      <StatusChip
        tone={FEEDBACK_TYPE_TONES[type]}
        label={FEEDBACK_TYPE_LABELS[type]}
        data-testid={`feedback-row-type-${row._id}`}
      />
      {row.subject && (
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          {FEEDBACK_SUBJECT_LABELS[row.subject]}
        </Typography>
      )}
      {tags.slice(0, VISIBLE_TAG_COUNT).map((tag, index) => (
        <Chip key={`${tag}-${index}`} size="sm" variant="soft" color="neutral">
          {tag}
        </Chip>
      ))}
      {hiddenTags > 0 && (
        <Tooltip title={tags.slice(VISIBLE_TAG_COUNT).join(', ')} placement="top">
          <Chip size="sm" variant="soft" color="neutral">
            +{hiddenTags}
          </Chip>
        </Tooltip>
      )}
    </Stack>
  );
};

const ContentCell = ({ row }: { row: FeedbackRow }) => (
  <Stack gap={0.5} alignItems="flex-start" sx={{ minWidth: 0 }}>
    <ReportMeta row={row} />
    <HelpContextChip feedbackItem={row} />
    {row.contentTruncated && (
      <StatusChip tone="warn" label="Truncated" data-testid="feedback-content-truncated-badge" />
    )}
    <Typography
      level="body-sm"
      sx={{ maxWidth: '100%', maxHeight: 80, overflowY: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
    >
      {getFeedbackDisplayContent(row, '') || (
        <Typography component="span" sx={{ color: 'admin.inkMuted' }}>
          No comment
        </Typography>
      )}
    </Typography>
  </Stack>
);

const FeedbackRowMenu = ({ row, onDelete }: { row: FeedbackRow; onDelete: (row: FeedbackRow) => void }) => {
  const conversationPath = feedbackConversationPath(row);
  const reporterMailto = feedbackReporterMailto(row);
  return (
    <RowActionsMenu
      testId={`feedback-row-actions-${row._id}`}
      ariaLabel={`Actions for the report from ${reporterName(row)}`}
    >
      <MenuItem onClick={() => void copyFeedbackRecordLink(row._id)} data-testid={`feedback-row-copy-link-${row._id}`}>
        Copy link to this report
      </MenuItem>
      {conversationPath && (
        <MenuItem
          component="a"
          href={conversationPath}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`feedback-row-open-conversation-${row._id}`}
        >
          {row.questId ? 'Open the conversation at this turn' : 'Open the conversation'}
        </MenuItem>
      )}
      {reporterMailto && (
        <MenuItem component="a" href={reporterMailto} data-testid={`feedback-row-email-reporter-${row._id}`}>
          Email reporter
        </MenuItem>
      )}
      <ListDivider />
      <MenuItem onClick={() => onDelete(row)} data-testid={`feedback-row-delete-${row._id}`}>
        Delete feedback
      </MenuItem>
    </RowActionsMenu>
  );
};

const FeedbackTab: React.FC = () => {
  // Declaration order is the data flow: the page cursor and the filters are INPUTS to the server
  // query, not results of it. Filtering and paging both moved server-side, so nothing here slices
  // a local array any more.
  const { currentPage, handlePageChange, itemsPerPage, handleItemsPerPageChange } = useFeedbackPagination();

  const {
    filters,
    setArea,
    setSeverity,
    setSearchTerm,
    setStatusFilters,
    setSelectedOrganizations,
    setSubject,
    setResolution,
    setTypes,
    setReceived,
    setCreatedRange,
    setComment,
    showOnly,
    toggleSortDirection,
    filterParams,
  } = useFeedbackFilters();

  const {
    feedback: currentFeedback,
    organizations,
    total,
    totalSettled,
    loading,
    isError,
    refreshFeedback,
    handleStatusChange,
    feedbackToClose,
    cancelClose,
    confirmClose,
    handleDeleteFeedbackClick,
    confirmDeleteFeedback,
    feedbackToDelete,
    openDeleteFeedbackModal,
    toggleDeleteFeedbackModal,
  } = useFeedbackOperations({ ...filterParams, page: currentPage, limit: itemsPerPage });

  const totalPages = Math.max(1, Math.ceil(total / itemsPerPage));

  // A shared or stale link can name a page the result set no longer reaches; land on the last real
  // one. Gated on a settled total so a URL page is never clamped against a count still loading.
  useEffect(() => {
    if (totalSettled && currentPage > totalPages) handlePageChange(totalPages);
  }, [totalSettled, currentPage, totalPages, handlePageChange]);

  // `?feedbackId=` is the drawer's open state, so a copied or Slack link opens the same report.
  // Fetched by id inside the drawer: the linked report may not be on this page or match the filters.
  const { [FEEDBACK_ID_PARAM]: openFeedbackId } = useSearch({ strict: false }) as { feedbackId?: string };
  const navigate = useNavigate();

  const setOpenFeedbackId = useCallback(
    (feedbackId: string | undefined) => {
      navigate({
        to: '/admin',
        search: previous => ({ ...previous, [FEEDBACK_ID_PARAM]: feedbackId }),
        replace: true,
      });
    },
    [navigate]
  );
  const openFeedback = useCallback((feedbackId: string) => setOpenFeedbackId(feedbackId), [setOpenFeedbackId]);
  const closeFeedback = useCallback(() => setOpenFeedbackId(undefined), [setOpenFeedbackId]);

  const detailNavigation = useFeedbackDetailNavigation({
    rowIds: currentFeedback.map(row => row._id),
    openId: openFeedbackId,
    page: currentPage,
    pageSize: itemsPerPage,
    total,
    settled: totalSettled,
    failed: isError,
    onPageChange: handlePageChange,
    open: openFeedback,
  });

  // Closing returns focus to the row of the report last shown, which after previous/next is not
  // the row that opened the drawer. Ids are compared rather than put in a selector: a deep-linked
  // id is arbitrary text.
  const tableRegionRef = useRef<HTMLDivElement>(null);
  useFeedbackKeyboard({
    rootRef: tableRegionRef,
    enabled: !openFeedbackId && !loading,
    onAction: (key, rowId) => {
      const row = currentFeedback.find(row => row._id === rowId);
      if (!row) return;
      if (key === 'e') {
        const mailto = feedbackReporterMailto(row);
        if (mailto) window.location.assign(mailto);
      } else {
        void handleStatusChange(row, key === 'i' ? FeedbackStatus.InProgress : FeedbackStatus.Closed);
      }
    },
  });
  const selectionScope = JSON.stringify({ filterParams, currentPage, itemsPerPage });
  const selection = useFeedbackSelection({
    pageIds: currentFeedback.map(row => row._id),
    scopeKey: selectionScope,
    total,
  });
  const previousOpenId = useRef(openFeedbackId);
  useEffect(() => {
    const closedId = previousOpenId.current;
    previousOpenId.current = openFeedbackId;
    if (!closedId || openFeedbackId) return;
    const rows = tableRegionRef.current?.querySelectorAll<HTMLElement>('[data-row-id]') ?? [];
    const row = Array.from(rows).find(row => row.dataset.rowId === closedId);
    // The row can be gone (status change under a filter, deep link): the drawer skips its own
    // focus restore, so without this focus would fall to <body>.
    (row ?? tableRegionRef.current)?.focus();
  }, [openFeedbackId]);

  // Pages through every match server-side. Exporting `currentFeedback` would silently emit one
  // page now that the list is paginated, which reads as a complete export of a much smaller
  // dataset.
  const handleExportToCSV = async () => {
    let exported: Awaited<ReturnType<typeof getAllFeedbackForExport>>;
    try {
      exported = await getAllFeedbackForExport(filterParams);
    } catch (error) {
      console.error('Error exporting feedback:', error);
      toast.error('Failed to export feedback.', { closeButton: true, position: 'bottom-left' });
      return;
    }

    if (exported.truncated) {
      toast.warning(`Export capped at ${FEEDBACK_EXPORT_MAX_ROWS} rows - narrow the filters for the rest.`, {
        closeButton: true,
        position: 'bottom-left',
      });
    }

    const csvData = exported.items.map(feedbackItem => ({
      ID: feedbackItem._id,
      CreatedAt: feedbackItem.createdAt,
      Status: feedbackItem.status,
      Resolution: feedbackItem.resolution ? FEEDBACK_RESOLUTION_LABELS[feedbackItem.resolution] : '',
      Type: FEEDBACK_TYPE_LABELS[feedbackTypeOf(feedbackItem.type)],
      Subject: feedbackItem.subject ? FEEDBACK_SUBJECT_LABELS[feedbackItem.subject] : '',
      UserId: feedbackItem.userId,
      Username: feedbackItem.username,
      UserEmail: feedbackItem.userEmail ?? '',
      Content: getFeedbackDisplayContent(feedbackItem, ''),
      HelpArticle: feedbackItem.helpContext?.slug ?? '',
      Organization: feedbackItem.organization,
      UpdatedAt: feedbackItem.updatedAt,
      Platform: feedbackItem.clientContext?.platform ?? '',
      AppVersion: feedbackItem.clientContext?.appVersion ?? '',
      Page: feedbackItem.clientContext?.path ?? '',
      Viewport: feedbackItem.clientContext?.viewport
        ? `${feedbackItem.clientContext.viewport.width}x${feedbackItem.clientContext.viewport.height}`
        : '',
      Model: feedbackItem.clientContext?.model ?? '',
      UserAgent: feedbackItem.clientContext?.userAgent ?? '',
    }));

    const csv = Papa.unparse(csvData, { escapeFormulae: CSV_FORMULA_PREFIX });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `feedback_${new Date().toISOString().slice(0, 10)}.csv`;
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const selectedStatuses = checkedStatuses(filters.statusFilters);
  const statusNarrowed = selectedStatuses.length < FEEDBACK_STATUS_ORDER.length;
  // Every status checked narrows nothing, so the chip reads as unset. Clearing it, or unpicking its
  // last status, checks them all again instead of leaving a filter that matches no report.
  const setStatuses = (picked: string[]) => {
    const next = FEEDBACK_STATUS_ORDER.filter(status => picked.includes(status));
    setStatusFilters(toStatusFilters(next.length > 0 ? next : FEEDBACK_STATUS_ORDER));
  };
  // A selected organization stays pickable even if it has left the facet, so it can be unpicked.
  const organizationOptions = [...new Set([...organizations, ...filters.selectedOrganizations])].map(name => ({
    value: name,
    label: name,
  }));

  const activeStatusView = STATUS_VIEWS.find(
    view =>
      view.statuses.length === selectedStatuses.length &&
      view.statuses.every(status => selectedStatuses.includes(status))
  )?.id;

  const createdRange = { createdFrom: filters.createdFrom, createdTo: filters.createdTo };
  const customRangeSet = hasCreatedRange(createdRange);
  const receivedOptions = [
    ...RECEIVED_FILTER_OPTIONS,
    // The menu entry keeps saying what it does (reopen the picker); the chip shows the range itself.
    {
      value: CUSTOM_RANGE,
      label: 'Custom range\u2026',
      chipLabel: customRangeSet ? formatCreatedRange(createdRange) : undefined,
    },
  ];
  const [rangeDialogOpen, setRangeDialogOpen] = useState(false);
  const setReceivedFilter = (value: string | undefined) => {
    if (value === CUSTOM_RANGE) return setRangeDialogOpen(true);
    setReceived(FEEDBACK_RECEIVED_WINDOWS.find(range => range === value));
  };

  const hasFilters =
    filters.area !== undefined ||
    filters.severity !== undefined ||
    filters.searchTerm.trim() !== '' ||
    statusNarrowed ||
    filters.subject !== undefined ||
    filters.resolution !== undefined ||
    filters.types.length > 0 ||
    filters.received !== undefined ||
    customRangeSet ||
    filters.comment !== undefined ||
    filters.selectedOrganizations.length > 0;
  const clearFilters = () => showOnly({ statusFilters: toStatusFilters(FEEDBACK_STATUS_ORDER) });

  // `loading` also covers a refetch with rows on screen (keepPreviousData): those rows stay, under a bar.
  const firstLoad = loading && currentFeedback.length === 0;
  const rowToDelete = currentFeedback.find(row => row._id === feedbackToDelete);

  const columns: DataColumn<FeedbackRow>[] = [
    { id: 'createdAt', label: 'Created', sortable: true, width: '7.5rem', render: row => <CreatedCell row={row} /> },
    { id: 'reporter', label: 'Reporter', width: '15rem', render: row => <ReporterCell row={row} /> },
    { id: 'content', label: 'Feedback', wrap: true, render: row => <ContentCell row={row} /> },
    {
      id: 'status',
      label: 'Status',
      width: '8.5rem',
      render: row => (
        <Stack gap={0.5}>
          <Select
            size="sm"
            value={row.status}
            onChange={(_, value) => void handleStatusChange(row, value)}
            slotProps={{
              button: {
                'aria-label': `Status of the report from ${reporterName(row)}`,
                'data-testid': `feedback-row-status-select-${row._id}`,
              },
            }}
            sx={{ width: '100%', minWidth: 0 }}
          >
            {FEEDBACK_STATUS_ORDER.map(status => (
              <Option key={status} value={status}>
                {FEEDBACK_STATUS_LABELS[status]}
              </Option>
            ))}
          </Select>
          {row.resolution && (
            <Typography level="body-xs" data-testid={`feedback-row-resolution-${row._id}`}>
              {FEEDBACK_RESOLUTION_LABELS[row.resolution]}
            </Typography>
          )}
        </Stack>
      ),
    },
  ];

  return (
    <Stack gap={ADMIN_REGION_GAP} sx={{ minWidth: 0 }} data-testid="admin-feedback-tab">
      <AdminPageHeader
        title="Feedback"
        count={firstLoad ? undefined : total}
        description="Reports and comments people send from the app, for triage."
        actions={
          <>
            <ContextHelpButton helpId="admin/feedback" tooltipText="Feedback help" />
            <Button
              variant="plain"
              size="sm"
              startDecorator={<RefreshIcon sx={{ fontSize: 16 }} />}
              disabled={loading}
              onClick={() => void refreshFeedback()}
              data-testid="feedback-refresh-btn"
              sx={adminFocus}
            >
              Refresh
            </Button>
            <Button
              variant="outlined"
              size="sm"
              startDecorator={<DownloadIcon sx={{ fontSize: 16 }} />}
              disabled={loading || total === 0}
              onClick={handleExportToCSV}
              data-testid="feedback-export-csv-btn"
              sx={adminFocus}
            >
              Export CSV
            </Button>
          </>
        }
      />

      <FeedbackTrendStrip showOnly={showOnly} />

      <ViewTabs
        views={STATUS_VIEWS}
        activeId={activeStatusView}
        onSelect={id => {
          const view = STATUS_VIEWS.find(candidate => candidate.id === id);
          if (view) setStatusFilters(toStatusFilters(view.statuses));
        }}
        aria-label="Status views"
        data-testid="feedback-status-views"
      />

      <Stack
        direction="row"
        flexWrap="wrap"
        alignItems="center"
        gap={1}
        sx={adminFocusScope}
        data-testid="feedback-filter-bar"
      >
        <AdminSearchInput
          value={filters.searchTerm}
          onChange={setSearchTerm}
          label="Search feedback"
          data-testid="feedback-search-input"
        />
        <FilterChip
          id="feedback-status"
          label="Status"
          multiple
          value={statusNarrowed ? selectedStatuses : []}
          options={STATUS_FILTER_OPTIONS}
          onChange={setStatuses}
        />
        <FilterChip
          id="feedback-type"
          label="Type"
          multiple
          value={filters.types}
          options={TYPE_FILTER_OPTIONS}
          onChange={picked => setTypes(FEEDBACK_TYPE_ORDER.filter(type => picked.includes(type)))}
        />
        <FilterChip
          id="feedback-area"
          label="Area"
          value={filters.area}
          options={FEEDBACK_AI_AREAS.map(value => ({ value, label: value }))}
          onChange={value => setArea(FEEDBACK_AI_AREAS.find(area => area === value))}
        />
        <FilterChip
          id="feedback-severity"
          label="Severity"
          value={filters.severity}
          options={FEEDBACK_AI_SEVERITIES.map(value => ({ value, label: value }))}
          onChange={value => setSeverity(FEEDBACK_AI_SEVERITIES.find(severity => severity === value))}
        />
        <FilterChip
          id="feedback-resolution"
          label="Resolution"
          value={filters.resolution}
          options={FEEDBACK_RESOLUTIONS.map(value => ({ value, label: FEEDBACK_RESOLUTION_LABELS[value] }))}
          onChange={value => setResolution(FEEDBACK_RESOLUTIONS.find(resolution => resolution === value))}
        />
        <FilterChip
          id="feedback-received"
          label="Received"
          value={customRangeSet ? CUSTOM_RANGE : filters.received}
          options={receivedOptions}
          onChange={setReceivedFilter}
        />
        <FilterChip
          id="feedback-comment"
          label="Comment"
          value={filters.comment}
          options={COMMENT_FILTER_OPTIONS}
          onChange={value => setComment(FEEDBACK_COMMENT_FILTERS.find(comment => comment === value))}
        />
        {/* Single-select, because GET /api/feedback takes one subject or none. */}
        <FilterChip
          id="feedback-subject"
          label="Subject"
          value={filters.subject}
          options={SUBJECT_FILTER_OPTIONS}
          onChange={value => setSubject(toSubjectFilter(value))}
        />
        {organizationOptions.length > 0 && (
          <FilterChip
            id="feedback-org"
            label="Organization"
            multiple
            value={filters.selectedOrganizations}
            options={organizationOptions}
            onChange={setSelectedOrganizations}
          />
        )}
      </Stack>

      <Stack
        ref={tableRegionRef}
        tabIndex={-1}
        data-testid="feedback-table-region"
        gap={1}
        sx={{ minWidth: 0, ...adminFocus }}
      >
        <UpdatingBar active={loading && !firstLoad} testId="feedback-updating-bar" />
        <DataTable
          label="Feedback"
          testId="feedback-table"
          rows={currentFeedback}
          columns={columns}
          getRowId={row => row._id}
          selection={!loading && totalSettled ? selection.selection : undefined}
          onSelectionChange={selection.setSelection}
          onRowActivate={row => openFeedback(row._id)}
          activeRowId={openFeedbackId}
          rowTestId={row => `feedback-row-${row._id}`}
          loading={firstLoad}
          error={isError ? 'Could not load feedback.' : undefined}
          onRetry={() => void refreshFeedback()}
          empty={
            hasFilters ? (
              <EmptyState
                title="No feedback matches these filters"
                action={
                  <Button variant="outlined" onClick={clearFilters} data-testid="feedback-empty-clear-btn">
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title="No feedback yet"
                description="Reports appear here as people send them."
                action={
                  <Button
                    variant="outlined"
                    onClick={() => void refreshFeedback()}
                    data-testid="feedback-empty-refresh-btn"
                  >
                    Refresh
                  </Button>
                }
              />
            )
          }
          sort={{ columnId: 'createdAt', direction: filters.sortAscending ? 'asc' : 'desc' }}
          onSortChange={() => toggleSortDirection()}
          pagination={{
            page: currentPage,
            pageSize: itemsPerPage,
            total,
            onPageChange: handlePageChange,
            onPageSizeChange: handleItemsPerPageChange,
          }}
          rowActions={row => <FeedbackRowMenu row={row} onDelete={handleDeleteFeedbackClick} />}
          minWidth="44rem"
          maxHeight="none"
        />
      </Stack>

      {rangeDialogOpen && (
        <FeedbackCreatedRangeDialog
          initial={createdRange}
          onApply={setCreatedRange}
          onClose={() => setRangeDialogOpen(false)}
        />
      )}
      <FeedbackBulkActions
        key={`${selectionScope}:${JSON.stringify(selection.selection)}`}
        selection={selection.selection}
        filters={filterParams}
        total={total}
        disabled={loading || !totalSettled}
        onSelectionChange={selection.setSelection}
        onApplied={refreshFeedback}
      />

      <ActionDialog
        open={openDeleteFeedbackModal}
        onClose={toggleDeleteFeedbackModal}
        title="Delete feedback"
        description={
          rowToDelete ? (
            <>
              Deletes the report from <strong>{reporterName(rowToDelete)}</strong>. This cannot be undone.
            </>
          ) : (
            'Deletes this report. This cannot be undone.'
          )
        }
        reasonPresets={ADMIN_REASON_PRESETS.feedbackDeletion}
        confirmLabel="Delete feedback"
        tone="danger"
        onConfirm={confirmDeleteFeedback}
        data-testid="feedback-delete-dialog"
      />

      <FeedbackDetailDrawer
        feedbackId={openFeedbackId}
        listRow={currentFeedback.find(row => row._id === openFeedbackId)}
        position={detailNavigation.position}
        onPrevious={detailNavigation.onPrevious}
        onNext={detailNavigation.onNext}
        onClose={closeFeedback}
        onStatusChange={handleStatusChange}
      />
      {feedbackToClose && (
        <FeedbackCloseDialog feedbackId={feedbackToClose.id} onClose={cancelClose} onConfirm={confirmClose} />
      )}
    </Stack>
  );
};

export default FeedbackTab;
