import { Checkbox, Chip, Stack, Typography } from '@mui/joy';
import { MAX_BULK_ABUSE_BATCH } from '@bike4mind/common';
import type { EmailDomainGroup } from '@client/app/utils/signupAnomaly';
import { DataTable } from '../shared/DataTable';
import type { UserSelection } from './Views/SlimUsersView';

export function EmailDomainGroups({
  groups,
  selection,
  loading,
  error,
  onRetry,
  truncated,
  keysTruncated,
}: {
  groups: EmailDomainGroup[];
  selection: UserSelection;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  truncated?: boolean;
  keysTruncated?: boolean;
}) {
  return (
    <Stack gap={1}>
      <Typography level="body-sm">
        Domain counts cover at most the newest 5,000 accounts. Select at most {MAX_BULK_ABUSE_BATCH} accounts per bulk
        run.
        {truncated && ' Account scan limit reached; groups are partial.'}
        {keysTruncated && ' Key scan limit reached; API key counts are lower bounds.'}
      </Typography>
      <DataTable
        rows={groups}
        getRowId={group => group.domain}
        label="Users by email domain"
        loading={loading}
        error={error}
        onRetry={onRetry}
        testId="users-domain-table"
        columns={[
          {
            id: 'select',
            label: 'Select group',
            render: group => {
              const selected = group.userIds.filter(id => selection.selectedIds.has(id)).length;
              return (
                <Checkbox
                  checked={selected === group.count}
                  indeterminate={selected > 0 && selected < group.count}
                  disabled={group.count > MAX_BULK_ABUSE_BATCH}
                  slotProps={{
                    input: {
                      'aria-label': `Select ${group.domain}`,
                      'data-testid': `users-domain-select-${group.domain}`,
                    },
                  }}
                  onChange={event => selection.onTogglePage(group.userIds, event.target.checked)}
                />
              );
            },
          },
          { id: 'domain', label: 'Email domain', render: group => group.domain, sortValue: group => group.domain },
          {
            id: 'count',
            label: 'Accounts',
            numeric: true,
            render: group => group.count.toLocaleString(),
            sortValue: group => group.count,
          },
          {
            id: 'spread',
            label: 'Creation time spread',
            render: group => (
              <Typography level="body-sm" title={`${group.firstCreatedAt} - ${group.lastCreatedAt}`}>
                {Math.round(
                  (Date.parse(group.lastCreatedAt) - Date.parse(group.firstCreatedAt)) / 60000
                ).toLocaleString()}{' '}
                min
              </Typography>
            ),
          },
          {
            id: 'keys',
            label: 'API keys',
            numeric: true,
            render: group => group.apiKeyCount.toLocaleString(),
            sortValue: group => group.apiKeyCount,
          },
          {
            id: 'hint',
            label: 'Review signal',
            render: group =>
              group.likelyAutomated ? (
                <Chip
                  color="warning"
                  variant="soft"
                  title="Domain signup count exceeds the configured hourly baseline. Review before taking action."
                >
                  Likely automated
                </Chip>
              ) : (
                'No burst signal'
              ),
          },
        ]}
      />
    </Stack>
  );
}
