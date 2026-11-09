import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  DialogContent,
  Dropdown,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  Menu,
  MenuButton,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from '@mui/joy';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import RefreshIcon from '@mui/icons-material/Refresh';
import { api } from '@client/app/contexts/ApiContext';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { useState, type ReactNode } from 'react';
import type { SafeSecretRotation } from '@client/lib/secretRotation/utils';
import {
  AdminDialog,
  AdminPageHeader,
  DataTable,
  EmptyState,
  StatusChip,
  UpdatingBar,
  type DataColumn,
} from './shared';
import { ADMIN_REGION_GAP, adminFocus } from './shared/adminStyles';

dayjs.extend(relativeTime);

/** An inactive record is not expected to rotate, so it never reads as overdue. */
function rotationStatus(secret: SafeSecretRotation): { tone: AdminStatusTone; label: string } {
  if (!secret.isActive) return { tone: 'neutral', label: 'Inactive' };
  if (dayjs(secret.nextRotation).isBefore(dayjs())) return { tone: 'warn', label: 'Overdue' };
  return { tone: 'good', label: 'Active' };
}

const muted = { color: 'admin.inkMuted' };
const dash = (
  <Typography level="body-sm" sx={muted}>
    -
  </Typography>
);

/** One line that truncates with an ellipsis, the full text on hover. */
const TruncatedText = ({ text, mono, testId }: { text: string; mono?: boolean; testId?: string }) => (
  <Tooltip title={text} placement="top-start">
    <Typography
      level="body-sm"
      noWrap
      data-testid={testId}
      sx={{ color: 'admin.ink', minWidth: 0, ...(mono && { fontFamily: 'code' }) }}
    >
      {text}
    </Typography>
  </Tooltip>
);

/** The absolute date, with the relative time as a description so it does not replace the date's name. */
const DateCell = ({ value, testId }: { value: Date; testId: string }) => (
  <Tooltip title={dayjs(value).fromNow()} describeChild>
    <Typography level="body-sm" noWrap data-testid={testId}>
      {dayjs(value).format('MMM D, YYYY')}
    </Typography>
  </Tooltip>
);

const DialogFooter = ({ children }: { children: ReactNode }) => (
  <Stack
    direction="row"
    justifyContent="flex-end"
    gap={1}
    sx={{ pt: 2, mt: 1, borderTop: '1px solid', borderColor: 'admin.border' }}
  >
    {children}
  </Stack>
);

const KeyName = ({ children }: { children: ReactNode }) => (
  <Typography component="code" fontFamily="code" sx={{ color: 'admin.ink' }}>
    {children}
  </Typography>
);

function RotationRowMenu({
  secret,
  onRenew,
  onEdit,
}: {
  secret: SafeSecretRotation;
  onRenew: (secret: SafeSecretRotation) => void;
  onEdit: (secret: SafeSecretRotation) => void;
}) {
  return (
    <Dropdown>
      <MenuButton
        slots={{ root: IconButton }}
        slotProps={{
          root: {
            size: 'sm',
            variant: 'plain',
            'aria-label': `Actions for ${secret.keyName}`,
            sx: { ...adminFocus, color: 'admin.inkMuted' },
          },
        }}
        data-testid={`secrets-rotation-row-actions-${secret.id}`}
      >
        <MoreHorizIcon sx={{ fontSize: 18 }} />
      </MenuButton>
      <Menu size="sm" placement="bottom-end" sx={{ zIndex: 1300 }}>
        <MenuItem onClick={() => onRenew(secret)} data-testid={`secrets-rotation-row-renew-${secret.id}`}>
          Mark renewed
        </MenuItem>
        <MenuItem onClick={() => onEdit(secret)} data-testid={`secrets-rotation-row-edit-${secret.id}`}>
          Edit rotation
        </MenuItem>
      </Menu>
    </Dropdown>
  );
}

export default function SecretsRotationTab() {
  const queryClient = useQueryClient();
  const [openRenewModal, setOpenRenewModal] = useState(false);
  const [openEditModal, setOpenEditModal] = useState(false);
  const [currentSecret, setCurrentSecret] = useState<SafeSecretRotation | null>(null);
  const [editFormData, setEditFormData] = useState({
    rotationIntervalDays: 30,
    description: '',
  });

  const { data, isLoading, isFetching, error, refetch } = useQuery<SafeSecretRotation[]>({
    queryKey: ['secrets-rotation'],
    queryFn: async () => {
      const response = await api.get('/api/secret-rotations');
      return response.data;
    },
    refetchInterval: 300000, // Auto-refresh every 5 minutes
  });

  const editMutation = useMutation({
    mutationFn: (data: { id: string; rotationIntervalDays?: number; description?: string }) =>
      api.put(`/api/secret-rotations/${data.id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['secrets-rotation'] });
      setOpenEditModal(false);
    },
  });

  const renewMutation = useMutation({
    mutationFn: (data: { id: string }) => api.post('/api/secret-rotations/renewed', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['secrets-rotation'] });
      setOpenRenewModal(false);
    },
  });

  const handleRenew = (secret: SafeSecretRotation) => {
    setCurrentSecret(secret);
    setOpenRenewModal(true);
  };

  const handleEdit = (secret: SafeSecretRotation) => {
    setCurrentSecret(secret);
    setEditFormData({
      rotationIntervalDays: secret.rotationIntervalDays,
      description: secret.description || '',
    });
    setOpenEditModal(true);
  };

  const handleRefresh = () => {
    refetch();
  };

  const columns: readonly DataColumn<SafeSecretRotation>[] = [
    {
      id: 'keyName',
      label: 'Secret',
      width: '12rem',
      render: secret => <TruncatedText text={secret.keyName} mono testId={`secrets-rotation-key-${secret.id}`} />,
    },
    {
      id: 'description',
      label: 'Description',
      render: secret => (secret.description ? <TruncatedText text={secret.description} /> : dash),
    },
    {
      id: 'interval',
      label: 'Interval (days)',
      numeric: true,
      width: '7rem',
      render: secret => secret.rotationIntervalDays,
    },
    {
      id: 'rotatedAt',
      label: 'Last renewed',
      width: '8rem',
      render: secret => <DateCell value={secret.rotatedAt} testId={`secrets-rotation-rotated-at-${secret.id}`} />,
    },
    {
      id: 'lastRotatedBy',
      label: 'Last renewed by',
      width: '9rem',
      render: secret => (secret.lastRotatedByName ? <TruncatedText text={secret.lastRotatedByName} /> : dash),
    },
    {
      id: 'nextRotation',
      label: 'Next rotation',
      width: '8rem',
      render: secret => <DateCell value={secret.nextRotation} testId={`secrets-rotation-next-rotation-${secret.id}`} />,
    },
    {
      id: 'status',
      label: 'Status',
      width: '6.5rem',
      render: secret => {
        const { tone, label } = rotationStatus(secret);
        return <StatusChip tone={tone} label={label} data-testid={`secrets-rotation-status-${secret.id}`} />;
      },
    },
  ];

  return (
    <Stack gap={ADMIN_REGION_GAP} sx={{ minWidth: 0 }} data-testid="admin-secrets-rotation-tab">
      <AdminPageHeader
        title="Secrets rotation"
        count={data?.length}
        description="Rotation schedules for platform secrets, and who renewed each one last."
        actions={
          <>
            <ContextHelpButton helpId="admin/secrets-management" tooltipText="Secrets rotation help" />
            <Button
              variant="outlined"
              size="sm"
              startDecorator={<RefreshIcon sx={{ fontSize: 16 }} />}
              disabled={isFetching}
              onClick={handleRefresh}
              data-testid="secrets-rotation-refresh-btn"
              sx={adminFocus}
            >
              Refresh
            </Button>
          </>
        }
      />

      <Stack gap={1} sx={{ minWidth: 0 }}>
        <UpdatingBar active={isFetching && !isLoading} testId="secrets-rotation-updating-bar" />
        <DataTable
          label="Secrets rotation"
          testId="secrets-rotation-table"
          rows={data ?? []}
          columns={columns}
          getRowId={secret => secret.id}
          rowTestId={secret => `secrets-rotation-row-${secret.id}`}
          loading={isLoading}
          error={error ? 'Could not load the rotation schedules.' : undefined}
          onRetry={handleRefresh}
          empty={
            <EmptyState
              title="No secrets are tracked for rotation"
              description="Secrets appear here once they are registered for rotation."
              action={
                <Button variant="outlined" onClick={handleRefresh} data-testid="secrets-rotation-empty-refresh-btn">
                  Refresh
                </Button>
              }
            />
          }
          rowActions={secret => <RotationRowMenu secret={secret} onRenew={handleRenew} onEdit={handleEdit} />}
          pagination={false}
          // Wide enough that every column keeps one line; below it the table scrolls inside its frame.
          minWidth="64rem"
          maxHeight="none"
        />
      </Stack>

      <AdminDialog
        open={openEditModal}
        onClose={() => setOpenEditModal(false)}
        title="Edit rotation"
        data-testid="secrets-rotation-edit-dialog"
      >
        <DialogContent sx={{ gap: 2 }}>
          <Typography level="body-sm" component="div">
            Changes the description and rotation interval of <KeyName>{currentSecret?.keyName}</KeyName>.
          </Typography>
          <FormControl>
            <FormLabel>Description</FormLabel>
            <Input
              name="description"
              value={editFormData.description}
              onChange={e => setEditFormData({ ...editFormData, description: e.target.value })}
              slotProps={{ input: { 'data-testid': 'secrets-rotation-edit-description-input' } }}
            />
          </FormControl>
          <FormControl>
            <FormLabel>Rotation interval (days)</FormLabel>
            <Input
              name="rotationIntervalDays"
              value={editFormData.rotationIntervalDays}
              onChange={e => setEditFormData({ ...editFormData, rotationIntervalDays: Number(e.target.value) })}
              type="number"
              slotProps={{
                input: {
                  min: 1,
                  max: 365,
                  'data-testid': 'secrets-rotation-edit-interval-input',
                },
              }}
            />
          </FormControl>
        </DialogContent>
        <DialogFooter>
          <Button
            variant="plain"
            color="neutral"
            onClick={() => setOpenEditModal(false)}
            data-testid="secrets-rotation-edit-cancel-btn"
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (currentSecret) {
                editMutation.mutate({
                  id: currentSecret.id,
                  ...editFormData,
                });
              }
            }}
            loading={editMutation.isPending}
            data-testid="secrets-rotation-edit-save-btn"
          >
            Save changes
          </Button>
        </DialogFooter>
      </AdminDialog>

      <AdminDialog
        open={openRenewModal}
        onClose={() => setOpenRenewModal(false)}
        title="Mark secret as renewed"
        data-testid="secrets-rotation-renew-dialog"
      >
        <DialogContent>
          <Typography level="body-sm" component="div">
            Records <KeyName>{currentSecret?.keyName}</KeyName> as renewed now, by you, and schedules its next rotation
            in {currentSecret?.rotationIntervalDays} days.
          </Typography>
        </DialogContent>
        <DialogFooter>
          <Button
            variant="plain"
            color="neutral"
            onClick={() => setOpenRenewModal(false)}
            data-testid="secrets-rotation-renew-cancel-btn"
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (currentSecret) {
                renewMutation.mutate({
                  id: currentSecret.id,
                });
              }
            }}
            loading={renewMutation.isPending}
            data-testid="secrets-rotation-renew-confirm-btn"
          >
            Mark renewed
          </Button>
        </DialogFooter>
      </AdminDialog>
    </Stack>
  );
}
