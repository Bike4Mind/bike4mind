import { FC, useState } from 'react';
import {
  Alert,
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  List,
  ListItem,
  Modal,
  ModalDialog,
  Stack,
  Typography,
} from '@mui/joy';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import { IOrganizationDocument, WithId } from '@bike4mind/common';
import {
  ISubscription,
  SubscriptionOwnerType,
  SubscriptionSource,
  isLiveStripeBilledSubscription,
  resolveSubscriptionSource,
} from '@bike4mind/server-utils/lib/subscriptions/types';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useDeleteOrganization, useOrganizationSeats } from '@client/app/hooks/data/organizations';
import { useGetOrganizationUsers } from '@client/app/hooks/data/user';
import { useGetSubscriptionsByOwner } from '@client/app/hooks/data/subscriptions';
import { fetchOrganizationGroups } from '@client/app/utils/groupsAPICalls';
import { formatCreditAmount } from '@client/app/utils/formatCredits';
import { getErrorMessage } from '@client/app/utils/error';

type DeleteOrganizationDialogProps = {
  open: boolean;
  organization: WithId<IOrganizationDocument>;
  /** Whether the viewer can open the Billing tab (canViewOrgBilling), to offer a way to cancel the plan. */
  canOpenBilling: boolean;
  onClose: () => void;
  onOpenBilling: () => void;
  /** Called once the team is gone; the caller navigates away from the deleted team's page. */
  onDeleted: () => void;
};

/**
 * The plan rows that block the delete. Mirrors the route's canDeleteOrganization check
 * (pages/api/organizations/[id]/index.ts): any `status === 'active'` row refuses the delete, including
 * one already canceled at period end, which stays active until that date. Must stay in sync with it.
 */
export const blockingSubscriptions = <T extends Pick<ISubscription, 'status'>>(subscriptions: readonly T[]): T[] =>
  subscriptions.filter(sub => sub.status === 'active');

/**
 * Plan rows Stripe still bills that do not block the delete (past due, unpaid, incomplete). The delete
 * path does not cancel anything with Stripe, so those keep retrying the card after the team is gone.
 */
export const unblockedBilledSubscriptions = <T extends Pick<ISubscription, 'status' | 'source' | 'subscriptionId'>>(
  subscriptions: readonly T[]
): T[] => subscriptions.filter(sub => sub.status !== 'active' && isLiveStripeBilledSubscription(sub));

const formatDate = (date: Date | string) => dayjs(date).format('MMMM D, YYYY');

/** Why the delete is refused while `subscription` is active, and what the owner can do about it. */
const blockedPlanMessage = (subscription: ISubscription): string => {
  const endDate = formatDate(subscription.periodEndsAt);
  if (subscription.canceledAt) {
    return `The team plan is canceled but stays active until ${endDate}. You can delete the team after that date.`;
  }
  if (resolveSubscriptionSource(subscription) === SubscriptionSource.AdminGrant) {
    return 'This team has a plan granted by Bike4Mind. Contact support to end it before deleting the team.';
  }
  return `This team has an active plan that renews on ${endDate}. Cancel it from Billing first: it stays active until ${endDate}, and you can delete the team after that. Deleting the team never cancels the plan for you.`;
};

const DeleteOrganizationDialog: FC<DeleteOrganizationDialogProps> = ({
  open,
  organization,
  canOpenBilling,
  onClose,
  onOpenBilling,
  onDeleted,
}) => {
  const deleteOrganization = useDeleteOrganization();
  const [typedName, setTypedName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const orgId = open ? organization.id : null;
  const { data: users } = useGetOrganizationUsers(orgId);
  const { pendingSeats } = useOrganizationSeats(orgId ?? undefined);
  const hasGroupTypes = !organization.personal && (organization.allowedGroupTypes ?? []).length > 0;
  const { data: groups } = useQuery({
    queryKey: ['organizations', organization.id, 'groups'],
    queryFn: () => fetchOrganizationGroups(organization.id),
    enabled: open && hasGroupTypes,
  });
  const subscriptionsQuery = useGetSubscriptionsByOwner(SubscriptionOwnerType.Organization, organization.id, {
    enabled: open,
  });
  const subscriptions = subscriptionsQuery.data ?? [];
  const blocking = blockingSubscriptions(subscriptions);
  const stillBilled = unblockedBilledSubscriptions(subscriptions);

  // `users` includes the billing owner (organizationService.getUsers appends them).
  const otherMembers = (users ?? []).filter(user => user.id !== organization.userId).length;
  const credits = organization.currentCredits ?? 0;
  const nameMatches = typedName.trim() === organization.name.trim();
  // While the plan check is loading we cannot say whether the delete would go through.
  const canConfirm = nameMatches && blocking.length === 0 && !subscriptionsQuery.isPending;

  const close = () => {
    if (deleteOrganization.isPending) return;
    setTypedName('');
    setError(null);
    onClose();
  };

  const submit = async () => {
    if (!canConfirm) return;
    setError(null);
    try {
      await deleteOrganization.mutateAsync(organization.id);
    } catch (err) {
      setError(getErrorMessage(err));
      return;
    }
    setTypedName('');
    onDeleted();
  };

  return (
    <Modal open={open} onClose={close}>
      <ModalDialog role="alertdialog" sx={{ maxWidth: 560 }} data-testid="delete-organization-modal">
        <DialogTitle>
          <WarningAmberRoundedIcon sx={{ color: 'danger.plainColor' }} />
          Delete {organization.name}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Typography level="body-sm">This cannot be undone. Deleting the team:</Typography>
            <List marker="disc" size="sm" sx={{ py: 0 }} data-testid="delete-organization-impact">
              <ListItem data-testid="delete-organization-impact-members">
                {otherMembers === 0
                  ? 'Removes the team. Nobody else is a member.'
                  : `Removes ${otherMembers} ${otherMembers === 1 ? 'member' : 'members'} from the team, along with their access to its shared work.`}
              </ListItem>
              {pendingSeats > 0 && (
                <ListItem data-testid="delete-organization-impact-invites">
                  Closes {pendingSeats} pending {pendingSeats === 1 ? 'invite' : 'invites'}.
                </ListItem>
              )}
              <ListItem data-testid="delete-organization-impact-credits">
                {credits > 0
                  ? `Forfeits the team's ${formatCreditAmount(credits)} remaining credits. They are not refunded or moved to your account.`
                  : 'The team has no remaining credits.'}
              </ListItem>
              {!!groups?.length && (
                <ListItem data-testid="delete-organization-impact-groups">
                  Deletes {groups.length} {groups.length === 1 ? 'group' : 'groups'} and removes everyone from them.
                </ListItem>
              )}
              <ListItem>
                Ends members&apos; access to the team&apos;s data lakes. Lakes a member created pass to the team owner.
              </ListItem>
            </List>

            {subscriptionsQuery.isError ? (
              <Alert color="warning" variant="soft" data-testid="delete-organization-plan-unknown">
                Could not check the team plan. If it is still active, the delete will be refused.
              </Alert>
            ) : blocking.length > 0 ? (
              <Alert
                color="danger"
                variant="soft"
                data-testid="delete-organization-plan-blocking"
                endDecorator={
                  canOpenBilling && !blocking[0].canceledAt ? (
                    <Button
                      size="sm"
                      variant="solid"
                      color="danger"
                      onClick={onOpenBilling}
                      data-testid="delete-organization-open-billing-btn"
                    >
                      Open Billing
                    </Button>
                  ) : undefined
                }
              >
                {blockedPlanMessage(blocking[0])}
              </Alert>
            ) : stillBilled.length > 0 ? (
              <Alert color="warning" variant="soft" data-testid="delete-organization-plan-billed">
                The team plan has a payment problem and Stripe is still retrying the charge. Deleting the team does not
                cancel it, so cancel it from Billing first to stop the retries.
              </Alert>
            ) : (
              !subscriptionsQuery.isPending && (
                <Typography level="body-sm" data-testid="delete-organization-plan-none">
                  The team has no active plan, so there is nothing to cancel.
                </Typography>
              )
            )}

            <FormControl>
              <FormLabel>
                Type <strong>&nbsp;{organization.name}&nbsp;</strong> to confirm
              </FormLabel>
              <Input
                value={typedName}
                onChange={e => setTypedName(e.target.value)}
                disabled={deleteOrganization.isPending}
                autoComplete="off"
                slotProps={{ input: { 'aria-label': 'Team name', 'data-testid': 'delete-organization-name-input' } }}
              />
              <FormHelperText>After the delete you return to your teams list.</FormHelperText>
            </FormControl>

            {error && (
              <Alert color="danger" variant="soft" data-testid="delete-organization-error">
                The team was not deleted: {error}
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            color="danger"
            onClick={submit}
            disabled={!canConfirm}
            loading={deleteOrganization.isPending}
            data-testid="delete-organization-confirm-btn"
          >
            Delete team
          </Button>
          <Button
            variant="plain"
            color="neutral"
            onClick={close}
            disabled={deleteOrganization.isPending}
            data-testid="delete-organization-cancel-btn"
          >
            Cancel
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
};

export default DeleteOrganizationDialog;
