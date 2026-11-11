import React, { useState, useEffect, useMemo } from 'react';
import {
  Button,
  Checkbox,
  Dropdown,
  FormControl,
  FormLabel,
  Input,
  Menu,
  MenuButton,
  MenuItem,
  Stack,
  Typography,
} from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import { ADMIN_TAB_PARAM } from '@bike4mind/common';
import { ADMIN_SUBSCRIPTIONS_TAB_SLUG } from './Subscriptions/Detail/subscriptionDetailModel';
import { CLEARED_FILTER_PARAMS } from './Subscriptions/subscriptionsTabSearch';
import { useSubscriptionsTab } from './Subscriptions/useSubscriptionsTabParams';
import { IOrganizationDocument, WithId } from '@bike4mind/common';
import {
  ActionDialog,
  AdminDialog,
  AdminDialogFooter,
  AdminPageHeader,
  AdminSearchInput,
  ChangePreview,
  DataTable,
  EmptyState,
  FilterChip,
  StatusChip,
  ReasonPicker,
  undoAdminReason,
  useUndoToast,
} from './shared';
import { ADMIN_REGION_GAP } from './shared/adminStyles';
import {
  ADMIN_REASON_PRESETS,
  type AdminReasonDraft,
  EMPTY_ADMIN_REASON,
  composeAdminReason,
  isAdminReasonComplete,
} from '@client/app/components/admin/shared/adminReason';
import { useTeamSeatLimits } from '@client/app/hooks/data/teamPlanSettings';
import { toast } from 'sonner';
import OrganizationProfileModal from './OrganizationProfileModal';
import OrganizationMembers from '@client/app/components/organizations/Member';
import AddIcon from '@mui/icons-material/Add';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { useSearchOrganizations, useCreateOrganization } from '@client/app/hooks/data/organizations';
import {
  useAdjustOrgSeats,
  useAdminOrgGrants,
  useConvertOrgToPaid,
  useGrantOrganization,
  useRevokeOrganization,
  useTopUpOrganization,
} from '@client/app/hooks/data/adminOrganizations';
import { useGetPendingOrganizationUsers } from '@client/app/hooks/data/user';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { openInNewTab } from '@client/app/utils/externalLinks';
import { organizationsPageToClampTo } from './organizationsTabSearch';
import { useOpenOrganizationId, useOrganizationsParams, useOrganizationsTabUrlSync } from './useOrganizationsTabParams';

/**
 * Adjust Seats modal, extracted so it can fetch pending invites for the org
 * via React Query and reflect them in the team-size floor. Without counting
 * pending invites, an admin could reduce seats below the eventual accepted
 * team size and the next invite acceptance would fail.
 */
interface AdjustSeatsModalProps {
  org: WithId<IOrganizationDocument>;
  seatsValue: number;
  setSeatsValue: (value: number) => void;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
  isPending: boolean;
}

const AdjustSeatsModal: React.FC<AdjustSeatsModalProps> = ({
  org,
  seatsValue,
  setSeatsValue,
  onClose,
  onSubmit,
  isPending,
}) => {
  const { data: pendingUsers } = useGetPendingOrganizationUsers(org.id);
  const { maxSeats } = useTeamSeatLimits();
  const pendingCount = pendingUsers?.length ?? 0;
  const acceptedTeamSize = (org.users?.length ?? 0) + 1; // +1 for owner
  const teamSize = acceptedTeamSize + pendingCount;
  // Clamp the floor at the ceiling so an over-cap org can be set back down to the max (#1424) -
  // mirrors the server validateSeatChange clamp. Without it, min > max here and the input forces
  // an unsubmittable value (>= teamSize) that the server then rejects as over the teamPlanMaxSeats cap.
  const minAllowed = Math.min(teamSize, maxSeats);
  const pendingHint = pendingCount > 0 ? ` (${pendingCount} pending invite${pendingCount === 1 ? '' : 's'})` : '';

  return (
    <ActionDialog
      open
      onClose={onClose}
      title={`Adjust seats for ${org.name}`}
      reasonPresets={ADMIN_REASON_PRESETS.seatChange}
      confirmLabel={`Set seats to ${seatsValue}`}
      blockedReason={
        seatsValue < minAllowed || seatsValue > maxSeats ? `Enter ${minAllowed} to ${maxSeats} seats.` : null
      }
      pending={isPending}
      onConfirm={onSubmit}
      data-testid="org-seats-dialog"
      testIds={{ reason: 'seats-reason-input', confirm: 'seats-submit' }}
    >
      <Typography level="body-sm" sx={{ mb: 1 }}>
        Current seats: {org.seats}. Members: {acceptedTeamSize}
        {pendingHint}. Minimum allowed: {minAllowed} (remove members or revoke pending invites to go lower).
      </Typography>
      <FormControl>
        <FormLabel>New seat count</FormLabel>
        <Input
          type="number"
          slotProps={{ input: { min: minAllowed, max: maxSeats, 'data-testid': 'seats-native-input' } }}
          value={seatsValue}
          onChange={e => setSeatsValue(Math.max(minAllowed, Number(e.target.value || minAllowed)))}
          data-testid="seats-input"
        />
      </FormControl>
      <ChangePreview before={org.seats ?? 0} after={seatsValue} data-testid="org-seats-preview" />
    </ActionDialog>
  );
};

const OrganizationsTab: React.FC = () => {
  const { setOrgId } = useOpenOrganizationId();
  const showUndo = useUndoToast();
  const [membersOrg, setMembersOrg] = useState<WithId<IOrganizationDocument> | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newOrgName, setNewOrgName] = useState('');

  // Grant Free Org mode (toggle in the create modal)
  const [grantMode, setGrantMode] = useState(false);
  const [grantOwnerEmail, setGrantOwnerEmail] = useState('');
  const [grantSeats, setGrantSeats] = useState<number>(4);
  const [grantInitialCredits, setGrantInitialCredits] = useState<number>(200_000);
  const [grantReason, setGrantReason] = useState<AdminReasonDraft>(EMPTY_ADMIN_REASON);

  // Row action dialog state
  const [topUpOrg, setTopUpOrg] = useState<WithId<IOrganizationDocument> | null>(null);
  const [topUpCredits, setTopUpCredits] = useState<number>(50_000);

  const [seatsOrg, setSeatsOrg] = useState<WithId<IOrganizationDocument> | null>(null);
  const [seatsValue, setSeatsValue] = useState<number>(4);

  const [revokeOrg, setRevokeOrg] = useState<WithId<IOrganizationDocument> | null>(null);
  const [convertOrg, setConvertOrg] = useState<WithId<IOrganizationDocument> | null>(null);

  useOrganizationsTabUrlSync();
  const [params, setParams] = useOrganizationsParams();

  const { data, isLoading, isFetching, isError, refetch } = useSearchOrganizations({
    page: params.page,
    limit: params.limit,
    search: params.search,
    filters: { personal: params.personal },
    orderBy: { by: params.sortBy, direction: params.sortDirection },
  });

  const { data: grants } = useAdminOrgGrants();
  const grantedOrgIds = useMemo(() => new Set((grants ?? []).map(g => g.ownerId)), [grants]);
  const grantSubscriptionIdByOrgId = useMemo(() => new Map((grants ?? []).map(g => [g.ownerId, g.id])), [grants]);
  const navigate = useNavigate();
  // Sync lives on the subscription page; land on the list narrowed to this customer's rows.
  const syncFromStripe = (org: WithId<IOrganizationDocument>) => {
    useSubscriptionsTab.getState().setParams({ ...CLEARED_FILTER_PARAMS, search: org.stripeCustomerId ?? org.id });
    void navigate({ to: '/admin', search: { [ADMIN_TAB_PARAM]: ADMIN_SUBSCRIPTIONS_TAB_SLUG } });
  };
  const viewSubscription = (orgId: string) => {
    const subscriptionId = grantSubscriptionIdByOrgId.get(orgId);
    if (!subscriptionId) return;
    void navigate({ to: '/admin/subscriptions/$subscriptionId', params: { subscriptionId } });
  };

  const organizations = data?.data ?? [];
  // The modal opens from a row snapshot; read the refreshed row once a write inside it (e.g. a
  // member credit limit) invalidates the list, or the modal keeps showing the old values.
  const liveMembersOrg = membersOrg ? (organizations.find(org => org.id === membersOrg.id) ?? membersOrg) : null;

  // A linked or restored page can be past the end of the list.
  const totalPages = data?.totalPages ?? 0;
  useEffect(() => {
    const page = organizationsPageToClampTo({ page: params.page, totalPages, isFetching });
    if (page !== undefined) setParams({ page });
  }, [isFetching, totalPages, params.page, setParams]);

  const createOrganizationMutation = useCreateOrganization();
  const grantOrgMutation = useGrantOrganization();
  const topUpMutation = useTopUpOrganization();
  const seatsMutation = useAdjustOrgSeats();
  const convertMutation = useConvertOrgToPaid();
  const revokeMutation = useRevokeOrganization();

  const resetCreateModal = () => {
    setIsCreateModalOpen(false);
    setNewOrgName('');
    setGrantMode(false);
    setGrantOwnerEmail('');
    setGrantSeats(4);
    setGrantInitialCredits(200_000);
    setGrantReason(EMPTY_ADMIN_REASON);
  };

  const handleCreateOrganization = async () => {
    if (grantMode) {
      if (!newOrgName.trim() || !grantOwnerEmail.trim() || !isAdminReasonComplete(grantReason)) {
        toast.error('Name, owner email, and a reason of at least 5 characters are required for grants');
        return;
      }
      try {
        await grantOrgMutation.mutateAsync({
          name: newOrgName.trim(),
          ownerEmail: grantOwnerEmail.trim(),
          seats: grantSeats,
          initialCredits: grantInitialCredits,
          reason: composeAdminReason(grantReason),
        });
        resetCreateModal();
        refetch();
      } catch {
        // mutation toasts the error
      }
      return;
    }

    if (!newOrgName.trim()) {
      toast.error('Organization name cannot be empty');
      return;
    }

    try {
      await createOrganizationMutation.mutateAsync(newOrgName);
      resetCreateModal();
      refetch();
    } catch (error) {
      // Error is handled by the mutation hook
    }
  };

  const handleTopUp = async (reason: string) => {
    if (!topUpOrg) return;
    try {
      await topUpMutation.mutateAsync({
        organizationId: topUpOrg.id,
        credits: topUpCredits,
        reason,
      });
      setTopUpOrg(null);
      setTopUpCredits(50_000);
      refetch();
    } catch {
      // toast handled
    }
  };

  const handleAdjustSeats = async (reason: string) => {
    if (!seatsOrg) return;
    try {
      const { id, name, seats } = seatsOrg;
      await seatsMutation.mutateAsync({ organizationId: id, seats: seatsValue, reason });
      setSeatsOrg(null);
      refetch();
      if (seats !== undefined && seats !== seatsValue) {
        showUndo({
          message: `Seats updated for ${name}`,
          onUndo: async () => {
            await seatsMutation.mutateAsync({ organizationId: id, seats, reason: undoAdminReason(reason) });
            await refetch();
          },
        });
      }
    } catch {
      // toast handled
    }
  };

  const handleConvertToPaid = async (reason: string) => {
    if (!convertOrg) return;
    try {
      const { checkoutUrl } = await convertMutation.mutateAsync({
        organizationId: convertOrg.id,
        callbackUrl: window.location.href,
        reason,
      });
      setConvertOrg(null);
      if (checkoutUrl) {
        await navigator.clipboard?.writeText(checkoutUrl).catch(() => undefined);
        toast.success('Checkout URL copied to clipboard');
        openInNewTab(checkoutUrl);
      }
    } catch {
      // toast handled
    }
  };

  const handleRevoke = async (reason: string) => {
    if (!revokeOrg) return;
    try {
      await revokeMutation.mutateAsync({ organizationId: revokeOrg.id, reason });
      setRevokeOrg(null);
      refetch();
    } catch {
      // toast handled
    }
  };

  const handleSearchChange = (value: string) => {
    setParams({ search: value, page: 1 });
  };

  const rowActions = (org: WithId<IOrganizationDocument>) => {
    const isGranted = grantedOrgIds.has(org.id);
    return (
      <Dropdown>
        <MenuButton
          slots={{ root: Button }}
          slotProps={{ root: { variant: 'plain', color: 'neutral', size: 'sm' } }}
          aria-label={`Actions for ${org.name}`}
          data-testid={`org-actions-${org.id}`}
        >
          <MoreVertIcon sx={{ fontSize: 16 }} />
        </MenuButton>
        <Menu>
          <MenuItem onClick={() => setOrgId(org.id)} data-testid={`edit-org-${org.id}`}>
            Edit profile
          </MenuItem>
          <MenuItem onClick={() => setMembersOrg(org)} data-testid={`members-org-${org.id}`}>
            View members
          </MenuItem>
          <MenuItem
            data-testid={`topup-credits-${org.id}`}
            onClick={() => {
              setTopUpOrg(org);
              setTopUpCredits(50_000);
            }}
          >
            Top up credits
          </MenuItem>
          {isGranted && (
            <MenuItem data-testid={`view-subscription-${org.id}`} onClick={() => viewSubscription(org.id)}>
              View subscription
            </MenuItem>
          )}
          {isGranted && (
            <MenuItem
              data-testid={`adjust-seats-${org.id}`}
              onClick={() => {
                setSeatsOrg(org);
                setSeatsValue(org.seats ?? 1);
              }}
            >
              Adjust seats
            </MenuItem>
          )}
          {!isGranted && !org.personal && (
            <MenuItem data-testid={`sync-from-stripe-${org.id}`} onClick={() => syncFromStripe(org)}>
              Sync from Stripe
            </MenuItem>
          )}
          {isGranted && (
            <MenuItem data-testid={`convert-to-paid-${org.id}`} onClick={() => setConvertOrg(org)}>
              Convert to paid
            </MenuItem>
          )}
          {isGranted && (
            <MenuItem data-testid={`revoke-grant-${org.id}`} color="danger" onClick={() => setRevokeOrg(org)}>
              Revoke grant
            </MenuItem>
          )}
        </Menu>
      </Dropdown>
    );
  };

  return (
    <Stack gap={ADMIN_REGION_GAP}>
      <AdminPageHeader
        title="Organizations"
        count={isError ? undefined : data?.totalOrganizations}
        description="Find organizations, manage their members and review grants."
        actions={
          <>
            <Button
              startDecorator={<AddIcon />}
              onClick={() => setIsCreateModalOpen(true)}
              data-testid="admin-organizations-create-btn"
            >
              Create organization
            </Button>
            <ContextHelpButton helpId="admin/organizations" tooltipText="Organizations Help" />
          </>
        }
      />
      <Stack direction="row" flexWrap="wrap" alignItems="center" gap={1} data-testid="admin-filter-bar">
        <AdminSearchInput
          value={params.search}
          onChange={handleSearchChange}
          label="Search organizations"
          data-testid="admin-organizations-search-input"
        />
        <FilterChip
          id="org-type"
          label="Type"
          value={params.personal === undefined ? undefined : String(params.personal)}
          options={[
            { value: 'true', label: 'Personal' },
            { value: 'false', label: 'Organization' },
          ]}
          onChange={value => setParams({ personal: value === undefined ? undefined : value === 'true', page: 1 })}
        />
        <FilterChip
          id="org-sort"
          label="Sort by"
          value={params.sortBy === 'name' ? undefined : params.sortBy}
          options={[
            { value: 'name', label: 'Name' },
            { value: 'createdAt', label: 'Created date' },
            { value: 'updatedAt', label: 'Updated date' },
          ]}
          onChange={value =>
            setParams({ sortBy: value === 'createdAt' || value === 'updatedAt' ? value : 'name', page: 1 })
          }
        />
        <FilterChip
          id="org-direction"
          label="Direction"
          value={params.sortDirection === 'asc' ? undefined : params.sortDirection}
          options={[
            { value: 'asc', label: 'Ascending' },
            { value: 'desc', label: 'Descending' },
          ]}
          onChange={value => setParams({ sortDirection: value === 'desc' ? 'desc' : 'asc', page: 1 })}
        />
      </Stack>
      <DataTable
        label="Organizations"
        rows={isError ? [] : organizations}
        getRowId={org => org.id}
        columns={[
          {
            id: 'name',
            label: 'Name',
            sortable: true,
            render: org => (
              <Stack direction="row" gap={1} alignItems="center">
                <Typography level="body-sm">{org.name}</Typography>
                {grantedOrgIds.has(org.id) && <StatusChip tone="warn" label="Granted" />}
              </Stack>
            ),
          },
          { id: 'type', label: 'Type', render: org => (org.personal ? 'Personal' : 'Organization') },
          {
            id: 'users',
            label: 'Users',
            numeric: true,
            render: org => (org.personal ? 1 : (org.users?.filter(u => u.userId !== org.userId).length ?? 0) + 1),
          },
          { id: 'billing', label: 'Billing contact', render: org => org.billingContact || '-' },
          { id: 'credits', label: 'Credits', numeric: true, render: org => (org.currentCredits ?? 0).toLocaleString() },
        ]}
        onRowActivate={org => setOrgId(org.id)}
        rowActions={rowActions}
        sort={{ columnId: params.sortBy, direction: params.sortDirection }}
        onSortChange={sort =>
          setParams({ sortBy: sort.columnId as typeof params.sortBy, sortDirection: sort.direction, page: 1 })
        }
        pagination={{
          page: params.page,
          pageSize: params.limit,
          total: data?.totalOrganizations ?? 0,
          onPageChange: page => setParams({ page }),
          onPageSizeChange: limit => setParams({ limit, page: 1 }),
        }}
        loading={isLoading}
        error={isError ? 'Organizations could not be loaded.' : undefined}
        onRetry={() => void refetch()}
        empty={
          <EmptyState
            title={
              params.search || params.personal !== undefined
                ? 'No organizations match these filters'
                : 'No organizations yet'
            }
            action={
              <Button
                variant="outlined"
                onClick={() =>
                  params.search || params.personal !== undefined
                    ? setParams({ search: '', personal: undefined, page: 1 })
                    : setIsCreateModalOpen(true)
                }
                data-testid="org-empty-action-btn"
              >
                {params.search || params.personal !== undefined ? 'Clear filters' : 'Create organization'}
              </Button>
            }
          />
        }
        minWidth="52rem"
      />

      <OrganizationProfileModal onClosed={refetch} />

      {membersOrg && (
        <AdminDialog
          open
          onClose={() => {
            setMembersOrg(null);
            refetch();
          }}
          title={`${membersOrg.name} - Members`}
          width={800}
          data-testid="org-members-dialog"
        >
          <OrganizationMembers organization={liveMembersOrg ?? membersOrg} />
        </AdminDialog>
      )}

      <AdminDialog
        open={isCreateModalOpen}
        onClose={resetCreateModal}
        title="Create organization"
        data-testid="org-create-dialog"
      >
        <Stack spacing={2}>
          <Checkbox
            checked={grantMode}
            onChange={e => setGrantMode(e.target.checked)}
            label="Grant Free Org (no Stripe checkout)"
            data-testid="grant-org-toggle"
          />
          <FormControl>
            <FormLabel>Organization Name</FormLabel>
            <Input
              value={newOrgName}
              onChange={e => setNewOrgName(e.target.value)}
              placeholder="Enter organization name"
              data-testid="org-name-input"
            />
          </FormControl>
          {grantMode && (
            <>
              <FormControl>
                <FormLabel>Owner Email</FormLabel>
                <Input
                  type="email"
                  value={grantOwnerEmail}
                  onChange={e => setGrantOwnerEmail(e.target.value)}
                  placeholder="owner@company.com"
                  data-testid="grant-owner-email-input"
                />
              </FormControl>
              <FormControl>
                <FormLabel>Seats</FormLabel>
                <Input
                  type="number"
                  slotProps={{ input: { min: 1, max: 100 } }}
                  value={grantSeats}
                  onChange={e => setGrantSeats(Math.max(1, Number(e.target.value || 1)))}
                  data-testid="grant-seats-input"
                />
              </FormControl>
              <FormControl>
                <FormLabel>Initial Credits</FormLabel>
                <Input
                  type="number"
                  slotProps={{ input: { min: 0, step: 10_000 } }}
                  value={grantInitialCredits}
                  onChange={e => setGrantInitialCredits(Math.max(0, Number(e.target.value || 0)))}
                  data-testid="grant-credits-input"
                />
              </FormControl>
              <ReasonPicker
                presets={ADMIN_REASON_PRESETS.organizationGrant}
                value={grantReason}
                onChange={setGrantReason}
                data-testid="org-grant-reason-input"
              />
            </>
          )}
        </Stack>
        <AdminDialogFooter>
          <Button variant="outlined" color="neutral" onClick={resetCreateModal}>
            Cancel
          </Button>
          <Button
            loading={createOrganizationMutation.isPending || grantOrgMutation.isPending}
            disabled={grantMode && !isAdminReasonComplete(grantReason)}
            onClick={handleCreateOrganization}
            data-testid={grantMode ? 'grant-org-submit' : 'create-org-submit'}
          >
            {grantMode ? 'Grant Free Org' : 'Create'}
          </Button>
        </AdminDialogFooter>
      </AdminDialog>

      <ActionDialog
        open={!!topUpOrg}
        onClose={() => setTopUpOrg(null)}
        title={`Top up credits for ${topUpOrg?.name ?? 'organization'}`}
        reasonPresets={ADMIN_REASON_PRESETS.creditAdjustment}
        confirmLabel={`Add ${topUpCredits.toLocaleString()} credits`}
        pending={topUpMutation.isPending}
        onConfirm={handleTopUp}
        data-testid="org-topup-dialog"
        testIds={{ reason: 'org-topup-reason-input', confirm: 'topup-submit' }}
      >
        <FormControl>
          <FormLabel>Credits to add</FormLabel>
          <Input
            type="number"
            slotProps={{ input: { min: 1, step: 10_000 } }}
            value={topUpCredits}
            onChange={e => setTopUpCredits(Math.max(1, Number(e.target.value || 1)))}
            data-testid="topup-credits-input"
          />
        </FormControl>
        {topUpOrg && (
          <Typography level="body-sm" data-testid="org-topup-preview">
            Balance: {(topUpOrg.currentCredits ?? 0).toLocaleString()} {'\u2192'}{' '}
            {((topUpOrg.currentCredits ?? 0) + topUpCredits).toLocaleString()} credits
          </Typography>
        )}
      </ActionDialog>

      {seatsOrg && (
        <AdjustSeatsModal
          org={seatsOrg}
          seatsValue={seatsValue}
          setSeatsValue={setSeatsValue}
          onClose={() => setSeatsOrg(null)}
          onSubmit={handleAdjustSeats}
          isPending={seatsMutation.isPending}
        />
      )}

      <ActionDialog
        open={!!revokeOrg}
        onClose={() => setRevokeOrg(null)}
        title={`Revoke grant for ${revokeOrg?.name ?? 'organization'}`}
        description="This will mark the org's active grant as canceled. Members keep access until you remove them."
        reasonPresets={ADMIN_REASON_PRESETS.compChange}
        confirmLabel="Revoke"
        tone="danger"
        pending={revokeMutation.isPending}
        onConfirm={handleRevoke}
        data-testid="org-revoke-dialog"
        testIds={{ reason: 'revoke-reason-input', confirm: 'revoke-submit' }}
      />

      <ActionDialog
        open={!!convertOrg}
        onClose={() => setConvertOrg(null)}
        title={`Convert ${convertOrg?.name ?? 'organization'} to paid`}
        description={`Creates a Stripe checkout link for ${convertOrg?.seats ?? 0} seats and copies it to your clipboard. Nothing is charged until the customer pays.`}
        reasonPresets={ADMIN_REASON_PRESETS.paidConversion}
        confirmLabel="Create checkout link"
        pending={convertMutation.isPending}
        onConfirm={handleConvertToPaid}
        data-testid="org-convert-to-paid-dialog"
      />
    </Stack>
  );
};

export default OrganizationsTab;
