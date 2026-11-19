import { InviteType } from '@bike4mind/common';
import { useCancelInvite } from '@client/app/hooks/data/invites';
import { useResendOrganizationInvite } from '@client/app/hooks/data/organizations';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import type { ISharerInviteView } from '@client/app/utils/invitesAPICalls';
import MailOutlineIcon from '@mui/icons-material/MailOutline';
import { Box, Button, Card, Sheet, Stack, Table, Typography } from '@mui/joy';
import { useQueryClient } from '@tanstack/react-query';
import { FC, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { buildPendingInviteRows, PendingInviteRow, PendingInviteTarget } from './pendingInviteRows';

// Below this card width the Role, Sent and Invited by columns fold into a line under the invitee,
// so Resend / Cancel stay in view without a sideways scroll.
const NARROW = '@container pending-invites (max-width: 599px)';
const wideOnly = { [NARROW]: { display: 'none' } } as const;

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
    <Card
      variant="outlined"
      data-testid="organization-pending-invites"
      sx={{ containerType: 'inline-size', containerName: 'pending-invites' }}
    >
      <Typography level="title-sm" startDecorator={<MailOutlineIcon />}>
        Pending invitations ({rows.length})
      </Typography>
      <Sheet sx={{ overflowX: 'auto', bgcolor: 'transparent' }}>
        <Table size="sm" aria-label="Pending invitations" sx={{ '& th, & td': { verticalAlign: 'middle' } }}>
          <thead>
            <tr>
              <Box component="th">Invitee</Box>
              <Box component="th" sx={{ width: 90, ...wideOnly }}>
                Role
              </Box>
              <Box component="th" sx={{ width: 120, ...wideOnly }}>
                Sent
              </Box>
              <Box component="th" sx={wideOnly}>
                Invited by
              </Box>
              {canManage && <Box component="th" sx={{ width: 180 }} aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const { target } = row;
              const canResend = !!target && (row.role !== 'admin' || canGrantAdmin);
              const role = row.role ? ROLE_LABELS[row.role] : '-';
              const sent = row.sentAt ? formatDate(row.sentAt) : '-';
              const inviter = row.inviterId && row.inviterId === currentUserId ? 'You' : (row.inviterName ?? '-');
              return (
                <tr key={row.key} data-testid="organization-pending-invite-row">
                  <td>
                    <Typography level="body-sm" sx={{ overflowWrap: 'anywhere' }}>
                      {row.label}
                    </Typography>
                    <Typography
                      level="body-xs"
                      sx={{ display: 'none', color: 'text.tertiary', [NARROW]: { display: 'block' } }}
                    >
                      {`${role} \u00B7 ${sent} \u00B7 Invited by ${inviter}`}
                    </Typography>
                  </td>
                  <Box component="td" sx={wideOnly}>
                    {role}
                  </Box>
                  <Box component="td" sx={wideOnly} title={row.sentAt?.toLocaleString(i18n.language)}>
                    {sent}
                  </Box>
                  <Box component="td" sx={wideOnly}>
                    {inviter}
                  </Box>
                  {canManage && (
                    <td>
                      {target ? (
                        <Stack direction="row" spacing={1} justifyContent="flex-end" flexWrap="wrap" useFlexGap>
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
