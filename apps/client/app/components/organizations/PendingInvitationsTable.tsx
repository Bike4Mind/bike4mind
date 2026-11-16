import { InviteType } from '@bike4mind/common';
import { useCancelInvite } from '@client/app/hooks/data/invites';
import { useResendOrganizationInvite } from '@client/app/hooks/data/organizations';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import type { ISharerInviteView } from '@client/app/utils/invitesAPICalls';
import MailOutlineIcon from '@mui/icons-material/MailOutline';
import { Button, Card, Sheet, Stack, Table, Typography } from '@mui/joy';
import { useQueryClient } from '@tanstack/react-query';
import { FC, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { buildPendingInviteRows, PendingInviteRow, PendingInviteTarget } from './pendingInviteRows';

const ROLE_LABELS = { viewer: 'Viewer', editor: 'Editor', admin: 'Admin' } as const;

// Marks the one row whose request is in flight; mutation variables may carry more than the target.
const targetKey = (target: { email?: string; userId?: string } | null | undefined) =>
  target?.email ?? target?.userId ?? '';
const sameTarget = (variables: { email?: string; userId?: string } | undefined, target: PendingInviteTarget): boolean =>
  !!variables && targetKey(variables) === targetKey(target);

interface PendingInvitationsTableProps {
  organizationId: string;
  invites: readonly ISharerInviteView[] | undefined;
  isError: boolean;
  /** Viewer may resend and cancel (`isOrgMember` and `isOrgOwnerOrCurrentAdmin`, the invite routes' gates). */
  canManage: boolean;
  /** Only the owner tier may resend an admin invite (invite-resend.ts). */
  canGrantAdmin: boolean;
  currentUserId?: string;
}

/** The team's one list of pending invitations: everyone invited and not yet joined, by any route. */
const PendingInvitationsTable: FC<PendingInvitationsTableProps> = ({
  organizationId,
  invites,
  isError,
  canManage,
  canGrantAdmin,
  currentUserId,
}) => {
  const { i18n } = useTranslation();
  const queryClient = useQueryClient();
  const confirm = useConfirmation();
  const rows = useMemo(() => buildPendingInviteRows(invites ?? []), [invites]);
  const resend = useResendOrganizationInvite(organizationId);
  const cancel = useCancelInvite({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations', organizationId, 'invites'] });
      queryClient.invalidateQueries({ queryKey: ['users', 'organization', organizationId] });
      toast.success('Invitation cancelled');
    },
    onError: error => toast.error(error.message),
  });

  if (isError) {
    return (
      <Typography color="danger" data-testid="organization-pending-invites-error">
        Pending invitations could not be loaded. Try again.
      </Typography>
    );
  }
  if (rows.length === 0) return null;

  const formatDate = (date: Date) =>
    date.toLocaleDateString(i18n.language, { month: 'short', day: 'numeric', year: 'numeric' });

  const handleCancel = (row: PendingInviteRow, target: PendingInviteTarget) =>
    confirm({
      title: 'Cancel invitation',
      description: `Cancel the invitation to ${row.label}? They will no longer be able to join with it.`,
      okLabel: 'Cancel invitation',
      cancelLabel: 'Keep invitation',
      onOk: async () => {
        await cancel.mutateAsync({ id: organizationId, type: InviteType.Organization, ...target });
      },
    });

  return (
    <Card variant="outlined" data-testid="organization-pending-invites">
      <Typography level="title-sm" startDecorator={<MailOutlineIcon />}>
        Pending invitations ({rows.length})
      </Typography>
      <Sheet sx={{ overflowX: 'auto', bgcolor: 'transparent' }}>
        <Table size="sm" sx={{ minWidth: 560 }} aria-label="Pending invitations">
          <thead>
            <tr>
              <th>Invitee</th>
              <th style={{ width: 90 }}>Role</th>
              <th style={{ width: 120 }}>Sent</th>
              <th>Invited by</th>
              {canManage && <th style={{ width: 190 }} aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const { target } = row;
              const canResend = !!target && (row.role !== 'admin' || canGrantAdmin);
              return (
                <tr key={row.key} data-testid="organization-pending-invite-row">
                  <td>
                    <Typography level="body-sm" sx={{ wordBreak: 'break-all' }}>
                      {row.label}
                    </Typography>
                  </td>
                  <td>{row.role ? ROLE_LABELS[row.role] : '-'}</td>
                  <td title={row.sentAt?.toLocaleString(i18n.language)}>{row.sentAt ? formatDate(row.sentAt) : '-'}</td>
                  <td>{row.inviterId && row.inviterId === currentUserId ? 'You' : (row.inviterName ?? '-')}</td>
                  {canManage && (
                    <td>
                      {target ? (
                        <Stack direction="row" spacing={1} justifyContent="flex-end">
                          {canResend && (
                            <Button
                              size="sm"
                              variant="plain"
                              data-testid="organization-pending-invite-resend-btn"
                              aria-label={`Resend invitation to ${row.label}`}
                              loading={resend.isPending && sameTarget(resend.variables, target)}
                              disabled={resend.isPending}
                              onClick={() => resend.mutate(target)}
                            >
                              Resend
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outlined"
                            color="danger"
                            data-testid="organization-pending-invite-cancel-btn"
                            aria-label={`Cancel invitation to ${row.label}`}
                            loading={cancel.isPending && sameTarget(cancel.variables, target)}
                            disabled={cancel.isPending}
                            onClick={() => handleCancel(row, target)}
                          >
                            Cancel
                          </Button>
                        </Stack>
                      ) : (
                        <Typography level="body-xs" color="neutral" textAlign="right">
                          Only the inviter can manage this one
                        </Typography>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Sheet>
    </Card>
  );
};

export default PendingInvitationsTable;
