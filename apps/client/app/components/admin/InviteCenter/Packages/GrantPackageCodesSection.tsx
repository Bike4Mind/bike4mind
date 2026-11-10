import { useState } from 'react';
import {
  Alert,
  Button,
  Chip,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Stack,
  Switch,
  Typography,
} from '@mui/joy';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isGrantPackageExpired,
  RegInviteStatusType,
  type IGrantPackageDocument,
  type IRegInviteDocument,
} from '@bike4mind/common';
import {
  GRANT_PACKAGES_QUERY_KEY,
  fetchGrantPackageLinks,
  grantPackageLinksQueryKey,
} from '@client/app/utils/grantPackageAPICalls';
import { createRegInvites, updateRegInvite } from '@client/app/utils/regInviteAPICalls';
import { getErrorMessage } from '@client/app/utils/error';
import { DataTable, type DataColumn } from '@client/app/components/admin/shared';

export type QueuedCode = { key: number; unlimitedUse: boolean };

type Props = {
  /** The saved package; null while the package is still being created. */
  pkg: IGrantPackageDocument | null;
  /** Codes to create right after the package is created. */
  queued: QueuedCode[];
  onQueuedChange: (next: QueuedCode[]) => void;
};

/** Mirrors usageByGrantPackage in RegistrationInviteModel.ts and register(): unexpired, and unused unless unlimited. */
const isCodeActive = (invite: IRegInviteDocument, now = new Date()) =>
  (!invite.expiresAt || new Date(invite.expiresAt) >= now) &&
  (!invite.used || invite.unlimitedUse === true) &&
  invite.status !== RegInviteStatusType.used;

const usesLabel = (invite: IRegInviteDocument) =>
  invite.unlimitedUse ? `${invite.usageHistory?.length ?? 0} (unlimited)` : invite.used ? 'Used' : 'Unused';

type CodeEdit = { id: string; code: string; unlimitedUse: boolean; expiresOn: string };

const dayOf = (date: Date | string | null | undefined) => (date ? new Date(date).toISOString().slice(0, 10) : '');

/** Same end-of-day UTC reading as the package's own expiry field in GrantPackageFormModal. */
const expiresAtFromDay = (day: string): Date | null => (day === '' ? null : new Date(`${day}T23:59:59.999Z`));

const CODE_COLUMNS: readonly DataColumn<IRegInviteDocument>[] = [
  { id: 'code', label: 'Code', render: invite => invite.code },
  { id: 'uses', label: 'Uses', render: usesLabel },
  {
    id: 'expires',
    label: 'Expires',
    render: invite => dayOf(invite.expiresAt) || 'Never',
  },
  {
    id: 'status',
    label: 'Status',
    render: invite => (
      <Chip size="sm" color={isCodeActive(invite) ? 'success' : 'neutral'}>
        {isCodeActive(invite) ? 'Active' : 'Inactive'}
      </Chip>
    ),
  },
];

export function GrantPackageCodesSection({ pkg, queued, onQueuedChange }: Props) {
  const queryClient = useQueryClient();
  const [unlimitedUse, setUnlimitedUse] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const links = useQuery({
    queryKey: grantPackageLinksQueryKey(pkg?.id ?? ''),
    queryFn: () => fetchGrantPackageLinks(pkg?.id ?? ''),
    enabled: pkg !== null,
  });

  const [editing, setEditing] = useState<CodeEdit | null>(null);
  const editExpiresAt = editing ? expiresAtFromDay(editing.expiresOn) : null;
  const editInvalid = editExpiresAt !== null && Number.isNaN(editExpiresAt.getTime());

  const save = useMutation({
    mutationFn: (edit: CodeEdit) =>
      updateRegInvite(edit.id, { unlimitedUse: edit.unlimitedUse, expiresAt: expiresAtFromDay(edit.expiresOn) }),
    onSuccess: () => {
      setError(null);
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: [GRANT_PACKAGES_QUERY_KEY] });
    },
    onError: (err: unknown) => setError(getErrorMessage(err)),
  });

  const columns: readonly DataColumn<IRegInviteDocument>[] = [
    ...CODE_COLUMNS,
    {
      id: 'actions',
      label: 'Actions',
      render: invite => (
        <Button
          size="sm"
          variant="plain"
          onClick={() =>
            setEditing({
              id: invite.id,
              code: invite.code,
              unlimitedUse: invite.unlimitedUse === true,
              expiresOn: dayOf(invite.expiresAt),
            })
          }
          disabled={save.isPending}
          data-testid={`grant-package-code-edit-btn-${invite.code}`}
        >
          Edit
        </Button>
      ),
    },
  ];

  const add = useMutation({
    mutationFn: (packageId: string) => createRegInvites({ multiple: 1, unlimitedUse, grantPackageId: packageId }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: [GRANT_PACKAGES_QUERY_KEY] });
    },
    onError: (err: unknown) => setError(getErrorMessage(err)),
  });

  const closedReason = !pkg
    ? null
    : isGrantPackageExpired(pkg)
      ? 'This package has expired, so it cannot take new codes.'
      : !pkg.active
        ? 'This package is inactive, so it cannot take new codes.'
        : null;

  const onAdd = () => {
    if (pkg) add.mutate(pkg.id);
    else onQueuedChange([...queued, { key: Date.now() + queued.length, unlimitedUse }]);
  };

  const invites = links.data?.invites;

  return (
    <Stack gap={1} data-testid="grant-package-codes-section">
      <Typography level="title-sm">Invite codes</Typography>
      {error && (
        <Alert color="danger" data-testid="grant-package-codes-error">
          {error}
        </Alert>
      )}
      {pkg && links.isError && (
        <Alert color="danger" data-testid="grant-package-codes-load-error">
          {getErrorMessage(links.error)}
        </Alert>
      )}
      {pkg && invites && invites.data.length === 0 && (
        <Typography level="body-sm" data-testid="grant-package-codes-empty">
          No codes redeem this package yet.
        </Typography>
      )}
      {pkg && invites && invites.data.length > 0 && (
        <DataTable
          rows={invites.data}
          label="invite codes"
          onRetry={() => void links.refetch()}
          columns={columns}
          getRowId={invite => invite.id}
          rowTestId={invite => `grant-package-code-row-${invite.code}`}
          testId="grant-package-codes-table"
        />
      )}
      {editing && (
        <Stack
          gap={1}
          sx={{ p: 1.5, borderRadius: 'sm', bgcolor: 'background.level1' }}
          data-testid="grant-package-code-edit"
        >
          <Typography level="body-sm" fontWeight="md">
            Edit code {editing.code}
          </Typography>
          <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap">
            <FormControl orientation="horizontal" sx={{ gap: 1 }}>
              <Switch
                checked={editing.unlimitedUse}
                onChange={e => setEditing({ ...editing, unlimitedUse: e.target.checked })}
                slotProps={{ input: { 'data-testid': 'grant-package-code-edit-unlimited-switch' } }}
              />
              <FormLabel>Unlimited use</FormLabel>
            </FormControl>
            <FormControl orientation="horizontal" sx={{ gap: 1 }} error={editInvalid}>
              <FormLabel>Expires on</FormLabel>
              <Input
                type="date"
                size="sm"
                value={editing.expiresOn}
                onChange={e => setEditing({ ...editing, expiresOn: e.target.value })}
                slotProps={{ input: { 'data-testid': 'grant-package-code-edit-expires-input' } }}
              />
            </FormControl>
          </Stack>
          <FormHelperText>
            Redeemable through the end of this day (UTC). Leave empty and the code never expires.
          </FormHelperText>
          <Stack direction="row" gap={1}>
            <Button
              size="sm"
              onClick={() => save.mutate(editing)}
              loading={save.isPending}
              disabled={editInvalid}
              data-testid="grant-package-code-edit-save-btn"
            >
              Save code
            </Button>
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              onClick={() => setEditing(null)}
              disabled={save.isPending}
              data-testid="grant-package-code-edit-cancel-btn"
            >
              Cancel
            </Button>
          </Stack>
        </Stack>
      )}
      {invites?.truncated && (
        <FormHelperText data-testid="grant-package-codes-truncated">
          Showing the newest {invites.data.length} codes.
        </FormHelperText>
      )}
      {!pkg && queued.length > 0 && (
        <Stack gap={0.5} data-testid="grant-package-codes-queued">
          {queued.map((code, index) => (
            <Stack key={code.key} direction="row" gap={1} alignItems="center">
              <Typography level="body-sm">
                New code {index + 1}
                {code.unlimitedUse ? ' (unlimited use)' : ''}
              </Typography>
              <Button
                size="sm"
                variant="plain"
                color="neutral"
                onClick={() => onQueuedChange(queued.filter(item => item.key !== code.key))}
                data-testid={`grant-package-queued-code-remove-${index}`}
              >
                Remove
              </Button>
            </Stack>
          ))}
          <FormHelperText>Codes are created after the package is saved.</FormHelperText>
        </Stack>
      )}
      <Stack direction="row" gap={1.5} alignItems="center">
        <FormControl orientation="horizontal" sx={{ gap: 1 }}>
          <Switch
            checked={unlimitedUse}
            disabled={closedReason !== null}
            onChange={e => setUnlimitedUse(e.target.checked)}
            slotProps={{ input: { 'data-testid': 'grant-package-code-unlimited-switch' } }}
          />
          <FormLabel>Unlimited use (expires in 3 months)</FormLabel>
        </FormControl>
        <Button
          size="sm"
          variant="outlined"
          onClick={onAdd}
          loading={add.isPending}
          disabled={closedReason !== null}
          data-testid="grant-package-add-code-btn"
        >
          Add code
        </Button>
      </Stack>
      {closedReason && <FormHelperText data-testid="grant-package-codes-closed">{closedReason}</FormHelperText>}
    </Stack>
  );
}
