import { useState } from 'react';
import { Box, Button, IconButton, Tooltip, Typography } from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { IGrantPackageDocument } from '@bike4mind/common';
import {
  AdminPageHeader,
  DataTable,
  EmptyState,
  StatusChip,
  type DataColumn,
} from '@client/app/components/admin/shared';
import { fetchGrantPackages, type GrantPackageRow } from '@client/app/utils/grantPackageAPICalls';
import { getErrorMessage } from '@client/app/utils/error';
import { GrantPackageFormModal } from './GrantPackageFormModal';

export const GRANT_PACKAGES_QUERY_KEY = 'admin-grant-packages';

const formatCount = (value: number) => value.toLocaleString('en-US');
const capLabel = (used: number, cap: number | null) =>
  cap === null ? `${formatCount(used)} / unlimited` : `${formatCount(used)} / ${formatCount(cap)}`;

const columns: DataColumn<GrantPackageRow>[] = [
  { id: 'name', label: 'Name', render: row => row.name },
  { id: 'credits', label: 'Credits', numeric: true, render: row => formatCount(row.credits) },
  { id: 'total', label: 'Redeemed', numeric: true, render: row => capLabel(row.redeemedTotal, row.totalCap) },
  { id: 'today', label: 'Today', numeric: true, render: row => capLabel(row.redeemedToday, row.dailyCap) },
  {
    id: 'capHits',
    label: 'Cap hits',
    numeric: true,
    render: row => (
      <Tooltip title={row.lastCapHitAt ? `Last refused ${new Date(row.lastCapHitAt).toUTCString()}` : 'Never refused'}>
        <span data-testid={`grant-package-cap-hits-${row.id}`}>{formatCount(row.capHits)}</span>
      </Tooltip>
    ),
  },
  {
    id: 'status',
    label: 'Status',
    render: row => <StatusChip tone={row.active ? 'good' : 'neutral'} label={row.active ? 'Active' : 'Inactive'} dot />,
  },
];

const GrantPackagesTab = () => {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<IGrantPackageDocument | null>(null);

  const { data, isPending, error, refetch } = useQuery({
    queryKey: [GRANT_PACKAGES_QUERY_KEY, { page, pageSize }],
    queryFn: () => fetchGrantPackages({ page, limit: pageSize }),
  });

  const openForm = (pkg: IGrantPackageDocument | null) => {
    setEditing(pkg);
    setFormOpen(true);
  };

  const createButton = (
    <Button startDecorator={<AddIcon />} onClick={() => openForm(null)} data-testid="grant-packages-create-btn">
      Create package
    </Button>
  );

  return (
    <Box sx={{ px: 3, py: 2 }}>
      <AdminPageHeader
        title="Grant packages"
        count={data?.meta.total}
        description="Signup credits that invite codes and partner rules draw from, with optional caps."
        actions={createButton}
      />
      <DataTable
        rows={data?.data ?? []}
        columns={columns}
        getRowId={row => row.id}
        label="Grant packages"
        loading={isPending}
        error={error ? getErrorMessage(error) : undefined}
        onRetry={() => void refetch()}
        testId="grant-packages-table"
        rowTestId={row => `grant-package-row-${row.id}`}
        onRowActivate={row => openForm(row)}
        rowActions={row => (
          <IconButton
            size="sm"
            variant="plain"
            aria-label={`Edit ${row.name}`}
            onClick={() => openForm(row)}
            data-testid={`grant-package-edit-btn-${row.id}`}
          >
            <EditIcon />
          </IconButton>
        )}
        empty={
          <EmptyState
            title="No grant packages yet"
            description="Create one to give invite signups a capped credit grant."
            action={createButton}
          />
        }
        pagination={{
          page,
          pageSize,
          total: data?.meta.total ?? 0,
          onPageChange: setPage,
          onPageSizeChange: size => {
            setPageSize(size);
            setPage(1);
          },
        }}
      />
      {data && (
        <Typography level="body-xs" sx={{ mt: 1, color: 'text.tertiary' }}>
          Packages above {formatCount(data.reasonPolicy.singleGrantCredits)} credits per signup, or able to hand out
          more than {formatCount(data.reasonPolicy.dailyTotalCredits)} in total, need a reason.
        </Typography>
      )}
      {formOpen && data && (
        <GrantPackageFormModal
          open
          editing={editing}
          reasonPolicy={data.reasonPolicy}
          onClose={() => setFormOpen(false)}
          onSaved={() => void queryClient.invalidateQueries({ queryKey: [GRANT_PACKAGES_QUERY_KEY] })}
        />
      )}
    </Box>
  );
};

export default GrantPackagesTab;
