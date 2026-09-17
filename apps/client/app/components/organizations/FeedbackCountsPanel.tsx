import { FeedbackCountBucket, OrgFeedbackReport } from '@bike4mind/common';
import OrgFeedbackDrilldownPanel from '@client/app/components/organizations/OrgFeedbackDrilldownPanel';
import { useOrgFeedbackReport, type OrgFeedbackRange } from '@client/app/hooks/data/orgFeedbackReport';
import { getErrorMessage } from '@client/app/utils/error';
import { Alert, Box, Button, CircularProgress, Sheet, Stack, Typography } from '@mui/joy';
import { FC, useState } from 'react';

/**
 * A grouping's rows. `onSelect` is what makes a count drillable; only the groupings the list route
 * can actually filter by get one, because a cell that opened an unfiltered list would be lying
 * about which rows are behind it.
 */
const CountTable: FC<{
  title: string;
  testId: string;
  rows: { key: string; count: number }[];
  onSelect?: (key: string) => void;
  selectedKey?: string | null;
}> = ({ title, testId, rows, onSelect, selectedKey }) => (
  <Sheet variant="soft" sx={{ p: 2, borderRadius: 'sm', minWidth: 220, flex: 1 }} data-testid={testId}>
    <Typography level="title-sm" sx={{ mb: 1 }}>
      {title}
    </Typography>
    {rows.length === 0 ? (
      <Typography level="body-sm">None</Typography>
    ) : (
      <Stack spacing={0.5}>
        {rows.map(row =>
          onSelect ? (
            <Button
              key={row.key}
              variant={selectedKey === row.key ? 'soft' : 'plain'}
              size="sm"
              data-testid={`${testId}-row-${row.key}`}
              onClick={() => onSelect(row.key)}
              sx={{ justifyContent: 'space-between', gap: 2, fontWeight: 'normal' }}
            >
              <Typography level="body-sm">{row.key}</Typography>
              <Typography level="body-sm">{row.count}</Typography>
            </Button>
          ) : (
            <Box key={row.key} sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
              <Typography level="body-sm">{row.key}</Typography>
              <Typography level="body-sm">{row.count}</Typography>
            </Box>
          )
        )}
      </Stack>
    )}
  </Sheet>
);

const asRows = (buckets: FeedbackCountBucket[]) => buckets.map(bucket => ({ key: bucket.key, count: bucket.count }));

/**
 * Renders the counts for one window. Owns neither the date control nor the run trigger - the shell
 * does, so a second panel reading the same window is an added sibling rather than a rewrite.
 */
const FeedbackCountsPanel: FC<{ organizationId: string; range: OrgFeedbackRange }> = ({ organizationId, range }) => {
  const [openSubject, setOpenSubject] = useState<string | null>(null);
  const { data, isFetching, isError, error } = useOrgFeedbackReport(organizationId, range, { enabled: true });

  if (isFetching) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }} data-testid="org-analysis-loading">
        <CircularProgress />
      </Box>
    );
  }

  if (isError) {
    return (
      <Alert color="danger" data-testid="org-analysis-error">
        {getErrorMessage(error)}
      </Alert>
    );
  }

  if (!data) return null;

  const report: OrgFeedbackReport = data;
  if (report.totals.count === 0) {
    return (
      <Typography level="body-md" data-testid="org-analysis-empty">
        No feedback from this organization in the selected window.
      </Typography>
    );
  }

  const { membership } = report;
  return (
    <Stack spacing={2} data-testid="org-analysis-counts">
      <Typography level="h3" data-testid="org-analysis-total">
        {report.totals.count} reports from {membership.memberCount} members
      </Typography>

      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
        <CountTable
          title="By subject"
          testId="org-analysis-by-subject"
          rows={asRows(report.bySubject)}
          selectedKey={openSubject}
          onSelect={key => setOpenSubject(current => (current === key ? null : key))}
        />
        <CountTable title="By type" testId="org-analysis-by-type" rows={asRows(report.byType)} />
        <CountTable title="By status" testId="org-analysis-by-status" rows={asRows(report.byStatus)} />
      </Stack>

      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
        <CountTable
          title="By day"
          testId="org-analysis-by-day"
          rows={report.byDay.map(row => ({ key: row.day, count: row.count }))}
        />
        <CountTable
          title="By member"
          testId="org-analysis-by-member"
          rows={report.byMember.map(row => ({ key: row.displayName, count: row.count }))}
        />
        {/* Rows carrying no tag are absent here, so these do not sum to the total. */}
        <CountTable title="By tag" testId="org-analysis-by-tag" rows={asRows(report.byTag)} />
      </Stack>

      {openSubject !== null && (
        <OrgFeedbackDrilldownPanel organizationId={organizationId} range={range} subject={openSubject} />
      )}

      {(membership.aclOnly.length > 0 || membership.stampOnly.length > 0) && (
        <Alert color="neutral" data-testid="org-analysis-membership-note">
          <Stack spacing={0.5}>
            <Typography level="body-sm">
              The organization roster and the feedback stamped to this organization do not agree, so some of these
              counts rest on one source alone.
            </Typography>
            {membership.aclOnly.length > 0 && (
              <Typography level="body-sm" data-testid="org-analysis-acl-only">
                On the roster, authoring nothing stamped here:{' '}
                {membership.aclOnly.map(member => member.displayName).join(', ')}
              </Typography>
            )}
            {membership.stampOnly.length > 0 && (
              <Typography level="body-sm" data-testid="org-analysis-stamp-only">
                Authoring stamped feedback, but off the roster:{' '}
                {membership.stampOnly.map(member => member.displayName).join(', ')}
              </Typography>
            )}
          </Stack>
        </Alert>
      )}
    </Stack>
  );
};

export default FeedbackCountsPanel;
