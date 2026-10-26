import React, { useState, useEffect, useMemo } from 'react';
import {
  Box,
  Button,
  Card,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  Dropdown,
  FormControl,
  FormLabel,
  Input,
  Menu,
  MenuButton,
  MenuItem,
  Modal,
  ModalClose,
  ModalDialog,
  Select,
  Sheet,
  Stack,
  Option,
  Table,
  Textarea,
  Typography,
} from '@mui/joy';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { IOrganizationDocument, WithId, isValidAdminActionReason, hasAdminPermission } from '@bike4mind/common';
import { AdminReasonField } from '@client/app/components/admin/shared/AdminReasonField';
import { useTeamSeatLimits } from '@client/app/hooks/data/teamPlanSettings';
import { toast } from 'sonner';
import OrganizationProfileModal from './OrganizationProfileModal';
import OrganizationMembers from '@client/app/components/organizations/Member';
import AddIcon from '@mui/icons-material/Add';
import SortIcon from '@mui/icons-material/Sort';
import EditIcon from '@mui/icons-material/Edit';
import GroupOutlinedIcon from '@mui/icons-material/GroupOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { useSearchOrganizations, useCreateOrganization } from '@client/app/hooks/data/organizations';
import PaginationControls from '@client/app/components/admin/Subscriptions/components/PaginationControls';
import {
  useAdjustOrgSeats,
  useAdminOrgGrants,
  useConvertOrgToPaid,
  useGrantOrganization,
  useReconcileOrgSeats,
  useRevokeOrganization,
  useTopUpOrganization,
} from '@client/app/hooks/data/adminOrganizations';
import { useGetPendingOrganizationUsers } from '@client/app/hooks/data/user';
import SearchBar from '@client/app/components/Session/SearchBar';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { openInNewTab } from '@client/app/utils/externalLinks';
import { ORGS_PAGE_LIMIT_OPTIONS, organizationsPageToClampTo } from './organizationsTabSearch';
import { useOpenOrganizationId, useOrganizationsParams, useOrganizationsTabUrlSync } from './useOrganizationsTabParams';
import { useUser } from '@client/app/contexts/UserContext';
import { requireOrganizationAdminPermission } from './organizationAdminPermissions';

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
  onSubmit: () => void;
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
  const canAdjustCredits = useUser(state => hasAdminPermission(state.currentUser, 'credits:adjust'));
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
    <Modal open onClose={onClose}>
      <ModalDialog>
        <ModalClose />
        <Typography level="h4">Adjust seats — {org.name}</Typography>
        <Divider sx={{ my: 2 }} />
        <Typography level="body-sm" sx={{ mb: 1 }}>
          Current seats: {org.seats}. Members: {acceptedTeamSize}
          {pendingHint}. Minimum allowed: {minAllowed} (remove members or revoke pending invites to go lower).
        </Typography>
        <FormControl>
          <FormLabel>New seat count</FormLabel>
          <Input
            type="number"
            slotProps={{ input: { min: minAllowed, max: maxSeats } }}
            value={seatsValue}
            onChange={e => setSeatsValue(Math.max(minAllowed, Number(e.target.value || minAllowed)))}
            data-testid="seats-input"
          />
        </FormControl>
        <Stack direction="row" spacing={2} justifyContent="flex-end" sx={{ mt: 3 }}>
          <Button variant="outlined" color="neutral" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!canAdjustCredits}
            title={canAdjustCredits ? undefined : 'Missing permission: credits:adjust'}
            loading={isPending}
            onClick={onSubmit}
            data-testid="seats-submit"
          >
            Update seats
          </Button>
        </Stack>
      </ModalDialog>
    </Modal>
  );
};

const OrganizationsTab: React.FC = () => {
  const isMobile = useIsMobile();
  const { setOrgId } = useOpenOrganizationId();
  const currentUser = useUser(state => state.currentUser);
  const canRead = hasAdminPermission(currentUser, 'support:read');
  const canManageSettings = canRead && hasAdminPermission(currentUser, 'settings:manage');
  const canAdjustCredits = canRead && hasAdminPermission(currentUser, 'credits:adjust');
  const settingsDenied = canManageSettings ? undefined : 'Missing permission: settings:manage';
  const creditsDenied = canAdjustCredits ? undefined : 'Missing permission: credits:adjust';
  const [membersOrg, setMembersOrg] = useState<WithId<IOrganizationDocument> | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newOrgName, setNewOrgName] = useState('');

  // Grant Free Org mode (toggle in the create modal)
  const [grantMode, setGrantMode] = useState(false);
  const [grantOwnerEmail, setGrantOwnerEmail] = useState('');
  const [grantSeats, setGrantSeats] = useState<number>(4);
  const [grantInitialCredits, setGrantInitialCredits] = useState<number>(200_000);
  const [grantReason, setGrantReason] = useState('');

  // Row action dialog state
  const [topUpOrg, setTopUpOrg] = useState<WithId<IOrganizationDocument> | null>(null);
  const [topUpCredits, setTopUpCredits] = useState<number>(50_000);
  const [topUpReason, setTopUpReason] = useState('');

  const [seatsOrg, setSeatsOrg] = useState<WithId<IOrganizationDocument> | null>(null);
  const [seatsValue, setSeatsValue] = useState<number>(4);

  const [revokeOrg, setRevokeOrg] = useState<WithId<IOrganizationDocument> | null>(null);
  const [revokeReason, setRevokeReason] = useState('');

  useOrganizationsTabUrlSync();
  const [params, setParams] = useOrganizationsParams();

  const [totalOrganizations, setTotalOrganizations] = useState<number>(0);

  const { data, isLoading, isFetching, refetch } = useSearchOrganizations({
    page: params.page,
    limit: params.limit,
    search: params.search,
    filters: { personal: params.personal },
    orderBy: { by: params.sortBy, direction: params.sortDirection },
  });

  const { data: grants } = useAdminOrgGrants();
  const grantedOrgIds = useMemo(() => new Set((grants ?? []).map(g => g.ownerId)), [grants]);

  const organizations = data?.data ?? [];
  // The modal opens from a row snapshot; read the refreshed row once a write inside it (e.g. a
  // member credit limit) invalidates the list, or the modal keeps showing the old values.
  const liveMembersOrg = membersOrg ? (organizations.find(org => org.id === membersOrg.id) ?? membersOrg) : null;

  useEffect(() => {
    setTotalOrganizations(curr => data?.totalOrganizations ?? curr);
  }, [data?.totalOrganizations]);

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
  const reconcileMutation = useReconcileOrgSeats();
  const convertMutation = useConvertOrgToPaid();
  const revokeMutation = useRevokeOrganization();

  const resetCreateModal = () => {
    setIsCreateModalOpen(false);
    setNewOrgName('');
    setGrantMode(false);
    setGrantOwnerEmail('');
    setGrantSeats(4);
    setGrantInitialCredits(200_000);
    setGrantReason('');
  };

  const handleCreateOrganization = async () => {
    if (!requireOrganizationAdminPermission(grantMode ? 'credits:adjust' : 'settings:manage')) return;
    if (grantMode) {
      if (!newOrgName.trim() || !grantOwnerEmail.trim() || !isValidAdminActionReason(grantReason)) {
        toast.error('Name, owner email, and a reason of at least 5 characters are required for grants');
        return;
      }
      try {
        await grantOrgMutation.mutateAsync({
          name: newOrgName.trim(),
          ownerEmail: grantOwnerEmail.trim(),
          seats: grantSeats,
          initialCredits: grantInitialCredits,
          reason: grantReason.trim(),
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

  const handleTopUp = async () => {
    if (!requireOrganizationAdminPermission('credits:adjust')) return;
    if (!topUpOrg) return;
    try {
      await topUpMutation.mutateAsync({
        organizationId: topUpOrg.id,
        credits: topUpCredits,
        reason: topUpReason.trim(),
      });
      setTopUpOrg(null);
      setTopUpCredits(50_000);
      setTopUpReason('');
      refetch();
    } catch {
      // toast handled
    }
  };

  const handleAdjustSeats = async () => {
    if (!requireOrganizationAdminPermission('credits:adjust')) return;
    if (!seatsOrg) return;
    try {
      await seatsMutation.mutateAsync({ organizationId: seatsOrg.id, seats: seatsValue });
      setSeatsOrg(null);
      refetch();
    } catch {
      // toast handled
    }
  };

  const handleReconcileSeats = async (org: WithId<IOrganizationDocument>) => {
    if (!requireOrganizationAdminPermission('credits:adjust')) return;
    try {
      await reconcileMutation.mutateAsync({ organizationId: org.id });
      refetch();
    } catch {
      // toast handled
    }
  };

  const handleConvertToPaid = async (org: WithId<IOrganizationDocument>) => {
    if (!requireOrganizationAdminPermission('credits:adjust')) return;
    try {
      const { checkoutUrl } = await convertMutation.mutateAsync({
        organizationId: org.id,
        callbackUrl: window.location.href,
      });
      if (checkoutUrl) {
        await navigator.clipboard?.writeText(checkoutUrl).catch(() => undefined);
        toast.success('Checkout URL copied to clipboard');
        openInNewTab(checkoutUrl);
      }
    } catch {
      // toast handled
    }
  };

  const handleRevoke = async () => {
    if (!requireOrganizationAdminPermission('credits:adjust')) return;
    if (!revokeOrg) return;
    try {
      await revokeMutation.mutateAsync({
        organizationId: revokeOrg.id,
        reason: revokeReason.trim() || undefined,
      });
      setRevokeOrg(null);
      setRevokeReason('');
      refetch();
    } catch {
      // toast handled
    }
  };

  const handleSearchChange = (value: string) => {
    setParams({ search: value, page: 1 });
  };

  const handleSortChange = (_event: React.SyntheticEvent | null, value: 'name' | 'createdAt' | 'updatedAt' | null) => {
    if (value) {
      setParams({ sortBy: value, page: 1 });
    }
  };

  const handleSortDirectionChange = (_event: React.SyntheticEvent | null, value: 'asc' | 'desc' | null) => {
    if (value) {
      setParams({ sortDirection: value, page: 1 });
    }
  };

  const handlePersonalFilterChange = (_event: React.SyntheticEvent | null, value: string | null) => {
    if (value === 'all') {
      setParams({ personal: undefined, page: 1 });
    } else if (value === 'personal') {
      setParams({ personal: true, page: 1 });
    } else if (value === 'organization') {
      setParams({ personal: false, page: 1 });
    }
  };

  return (
    <Sheet sx={{ height: '100%', p: { xs: 1, sm: 2 } }}>
      {/* Filters and Search */}
      <Card variant="outlined" sx={{ mb: '8px', px: 2, py: 1 }}>
        <Stack spacing={1}>
          {/* Row 1: Search */}
          <FormControl sx={{ width: '100%' }}>
            <FormLabel sx={{ fontSize: 'sm' }}>Search by name</FormLabel>
            <SearchBar
              handleChange={handleSearchChange}
              placeHolder="Search organizations..."
              slotProps={{ input: { 'data-testid': 'admin-organizations-search-input' } }}
              debounceTimeout={300}
              endDecorator={isLoading && <CircularProgress size="sm" />}
            />
          </FormControl>

          {/* Row 2: Type + Sort by */}
          <Stack direction="row" spacing={1}>
            <FormControl sx={{ flex: 1 }}>
              <FormLabel sx={{ fontSize: 'sm' }}>Type</FormLabel>
              <Select
                placeholder="All types"
                onChange={handlePersonalFilterChange}
                value={params.personal === undefined ? 'all' : params.personal ? 'personal' : 'organization'}
                size="sm"
              >
                <Option value="all">All types</Option>
                <Option value="personal">Personal</Option>
                <Option value="organization">Organization</Option>
              </Select>
            </FormControl>

            <FormControl sx={{ flex: 1 }}>
              <FormLabel sx={{ fontSize: 'sm' }}>Sort by</FormLabel>
              <Select
                placeholder="Sort by"
                startDecorator={<SortIcon />}
                value={params.sortBy}
                onChange={handleSortChange}
                size="sm"
              >
                <Option value="name">Name</Option>
                <Option value="createdAt">Created Date</Option>
                <Option value="updatedAt">Updated Date</Option>
              </Select>
            </FormControl>
          </Stack>

          {/* Row 3: Direction + Create + Help */}
          <Stack direction="row" spacing={1} alignItems="flex-end">
            <FormControl sx={{ flex: 1 }}>
              <FormLabel sx={{ fontSize: 'sm' }}>Direction</FormLabel>
              <Select
                placeholder="Direction"
                value={params.sortDirection}
                onChange={handleSortDirectionChange}
                size="sm"
              >
                <Option value="asc">Ascending</Option>
                <Option value="desc">Descending</Option>
              </Select>
            </FormControl>
            <Button
              size="sm"
              startDecorator={<AddIcon />}
              disabled={!canManageSettings}
              title={settingsDenied}
              data-testid="admin-org-create-open"
              onClick={() => {
                if (!requireOrganizationAdminPermission('settings:manage')) return;
                setGrantMode(false);
                setIsCreateModalOpen(true);
              }}
              sx={{ flex: { xs: 1, sm: 'unset' } }}
            >
              Create Organization
            </Button>
            <Button
              size="sm"
              disabled={!canAdjustCredits}
              title={creditsDenied}
              data-testid="admin-org-grant-open"
              onClick={() => {
                if (!requireOrganizationAdminPermission('credits:adjust')) return;
                setGrantMode(true);
                setIsCreateModalOpen(true);
              }}
            >
              Grant Free Organization
            </Button>
            <ContextHelpButton helpId="admin/organizations" tooltipText="Organizations Help" />
          </Stack>
        </Stack>
      </Card>

      {/* Top pagination */}
      <PaginationControls
        currentPage={params.page}
        totalPages={data?.totalPages ?? 0}
        onPageChange={p => setParams({ page: p })}
        itemsPerPage={params.limit}
        onItemsPerPageChange={l => setParams({ limit: l, page: 1 })}
        totalItems={totalOrganizations}
        pageLimitOptions={ORGS_PAGE_LIMIT_OPTIONS}
      />

      {isMobile ? (
        <Stack spacing={1} sx={{ mt: 1 }}>
          {organizations.length > 0 ? (
            organizations.map(org => {
              const isGranted = grantedOrgIds.has(org.id);
              return (
                <Card key={org.id} variant="outlined" sx={{ p: 1.5 }}>
                  <Stack spacing={1}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Typography level="title-sm" fontWeight="lg">
                          {org.name}
                        </Typography>
                        {isGranted && (
                          <Chip size="sm" color="warning" variant="soft" data-testid="granted-org-badge">
                            Granted
                          </Chip>
                        )}
                      </Stack>
                      <Chip color={org.personal ? 'primary' : 'success'} variant="soft" size="sm">
                        {org.personal ? 'Personal' : 'Organization'}
                      </Chip>
                    </Stack>
                    <Stack direction="row" spacing={2}>
                      <Typography level="body-xs">
                        Users: {org.personal ? 1 : (org.users?.filter(u => u.userId !== org.userId).length ?? 0) + 1}
                      </Typography>
                      <Typography level="body-xs">Credits: {org.currentCredits || 0}</Typography>
                    </Stack>
                    {org.billingContact && <Typography level="body-xs">Billing: {org.billingContact}</Typography>}
                    <Stack direction="row" spacing={1}>
                      <Button
                        variant="outlined"
                        color="primary"
                        size="sm"
                        startDecorator={<EditIcon sx={{ fontSize: 14 }} />}
                        disabled={!canManageSettings}
                        title={settingsDenied}
                        data-testid={`admin-org-edit-${org.id}`}
                        onClick={() => {
                          if (requireOrganizationAdminPermission('settings:manage')) setOrgId(org.id);
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="outlined"
                        color="neutral"
                        size="sm"
                        startDecorator={<GroupOutlinedIcon sx={{ fontSize: 14 }} />}
                        disabled={!canManageSettings}
                        title={settingsDenied}
                        data-testid={`admin-org-members-${org.id}`}
                        onClick={() => {
                          if (requireOrganizationAdminPermission('settings:manage')) setMembersOrg(org);
                        }}
                      >
                        Members
                      </Button>
                      <Dropdown>
                        <MenuButton
                          slots={{ root: Button }}
                          slotProps={{ root: { variant: 'outlined', color: 'neutral', size: 'sm' } }}
                          data-testid={`org-actions-${org.id}`}
                        >
                          <MoreVertIcon sx={{ fontSize: 16 }} />
                        </MenuButton>
                        <Menu>
                          <MenuItem
                            disabled={!canAdjustCredits}
                            title={creditsDenied}
                            data-testid={`topup-credits-${org.id}`}
                            onClick={() => {
                              if (!requireOrganizationAdminPermission('credits:adjust')) return;
                              setTopUpOrg(org);
                              setTopUpCredits(50_000);
                              setTopUpReason('');
                            }}
                          >
                            Top up credits
                          </MenuItem>
                          {isGranted && (
                            <MenuItem
                              disabled={!canAdjustCredits}
                              title={creditsDenied}
                              data-testid={`adjust-seats-${org.id}`}
                              onClick={() => {
                                if (!requireOrganizationAdminPermission('credits:adjust')) return;
                                setSeatsOrg(org);
                                setSeatsValue(org.seats ?? 1);
                              }}
                            >
                              Adjust seats
                            </MenuItem>
                          )}
                          {!isGranted && !org.personal && (
                            <MenuItem
                              disabled={!canAdjustCredits}
                              title={creditsDenied}
                              data-testid={`reconcile-seats-${org.id}`}
                              onClick={() => handleReconcileSeats(org)}
                            >
                              Reconcile seats from Stripe
                            </MenuItem>
                          )}
                          {isGranted && (
                            <MenuItem
                              disabled={!canAdjustCredits}
                              title={creditsDenied}
                              data-testid={`convert-to-paid-${org.id}`}
                              onClick={() => handleConvertToPaid(org)}
                            >
                              Convert to paid
                            </MenuItem>
                          )}
                          {isGranted && (
                            <MenuItem
                              disabled={!canAdjustCredits}
                              title={creditsDenied}
                              data-testid={`revoke-grant-${org.id}`}
                              color="danger"
                              onClick={() => {
                                if (!requireOrganizationAdminPermission('credits:adjust')) return;
                                setRevokeOrg(org);
                                setRevokeReason('');
                              }}
                            >
                              Revoke grant
                            </MenuItem>
                          )}
                        </Menu>
                      </Dropdown>
                    </Stack>
                  </Stack>
                </Card>
              );
            })
          ) : (
            <Typography level="body-sm" textAlign="center">
              {isLoading ? 'Loading...' : 'No organizations found'}
            </Typography>
          )}
        </Stack>
      ) : (
        <Box sx={{ overflow: 'auto', maxHeight: 'calc(110vh - 400px)', flexGrow: 1 }}>
          <Table stickyHeader sx={{ minWidth: { xs: '900px', sm: 'auto' } }}>
            <thead>
              <tr>
                <th style={{ width: '25%' }}>Name</th>
                <th style={{ width: '10%' }}>Type</th>
                <th style={{ width: '8%' }}>Users</th>
                <th style={{ width: '22%' }}>Billing Contact</th>
                <th style={{ width: '12%' }}>Credits</th>
                <th style={{ width: '23%' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {organizations.length > 0 ? (
                organizations.map(org => {
                  const isGranted = grantedOrgIds.has(org.id);
                  return (
                    <tr key={org.id}>
                      <td>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Typography level="body-sm">{org.name}</Typography>
                          {isGranted && (
                            <Chip size="sm" color="warning" variant="soft" data-testid="granted-org-badge">
                              Granted
                            </Chip>
                          )}
                        </Stack>
                      </td>
                      <td>
                        <Chip color={org.personal ? 'primary' : 'success'} variant="soft" size="sm">
                          {org.personal ? 'Personal' : 'Organization'}
                        </Chip>
                      </td>
                      <td>{org.personal ? 1 : (org.users?.filter(u => u.userId !== org.userId).length ?? 0) + 1}</td>
                      <td>{org.billingContact || '-'}</td>
                      <td>{org.currentCredits || 0}</td>
                      <td>
                        <Box display="flex" gap={1} alignItems="center">
                          <Button
                            variant="outlined"
                            color="primary"
                            size="sm"
                            startDecorator={<EditIcon sx={{ fontSize: 14 }} />}
                            disabled={!canManageSettings}
                            title={settingsDenied}
                            data-testid={`admin-org-edit-${org.id}`}
                            onClick={() => {
                              if (requireOrganizationAdminPermission('settings:manage')) setOrgId(org.id);
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="outlined"
                            color="neutral"
                            size="sm"
                            startDecorator={<GroupOutlinedIcon sx={{ fontSize: 14 }} />}
                            disabled={!canManageSettings}
                            title={settingsDenied}
                            data-testid={`admin-org-members-${org.id}`}
                            onClick={() => {
                              if (requireOrganizationAdminPermission('settings:manage')) setMembersOrg(org);
                            }}
                          >
                            Members
                          </Button>
                          <Dropdown>
                            <MenuButton
                              slots={{ root: Button }}
                              slotProps={{ root: { variant: 'outlined', color: 'neutral', size: 'sm' } }}
                              data-testid={`org-actions-${org.id}`}
                            >
                              <MoreVertIcon sx={{ fontSize: 16 }} />
                            </MenuButton>
                            <Menu>
                              <MenuItem
                                disabled={!canAdjustCredits}
                                title={creditsDenied}
                                data-testid={`topup-credits-${org.id}`}
                                onClick={() => {
                                  if (!requireOrganizationAdminPermission('credits:adjust')) return;
                                  setTopUpOrg(org);
                                  setTopUpCredits(50_000);
                                  setTopUpReason('');
                                }}
                              >
                                Top up credits
                              </MenuItem>
                              {isGranted && (
                                <MenuItem
                                  disabled={!canAdjustCredits}
                                  title={creditsDenied}
                                  data-testid={`adjust-seats-${org.id}`}
                                  onClick={() => {
                                    if (!requireOrganizationAdminPermission('credits:adjust')) return;
                                    setSeatsOrg(org);
                                    setSeatsValue(org.seats ?? 1);
                                  }}
                                >
                                  Adjust seats
                                </MenuItem>
                              )}
                              {!isGranted && !org.personal && (
                                <MenuItem
                                  disabled={!canAdjustCredits}
                                  title={creditsDenied}
                                  data-testid={`reconcile-seats-${org.id}`}
                                  onClick={() => handleReconcileSeats(org)}
                                >
                                  Reconcile seats from Stripe
                                </MenuItem>
                              )}
                              {isGranted && (
                                <MenuItem
                                  disabled={!canAdjustCredits}
                                  title={creditsDenied}
                                  data-testid={`convert-to-paid-${org.id}`}
                                  onClick={() => handleConvertToPaid(org)}
                                >
                                  Convert to paid
                                </MenuItem>
                              )}
                              {isGranted && (
                                <MenuItem
                                  disabled={!canAdjustCredits}
                                  title={creditsDenied}
                                  data-testid={`revoke-grant-${org.id}`}
                                  color="danger"
                                  onClick={() => {
                                    if (!requireOrganizationAdminPermission('credits:adjust')) return;
                                    setRevokeOrg(org);
                                    setRevokeReason('');
                                  }}
                                >
                                  Revoke grant
                                </MenuItem>
                              )}
                            </Menu>
                          </Dropdown>
                        </Box>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center' }}>
                    <Typography level="body-sm">{isLoading ? 'Loading...' : 'No organizations found'}</Typography>
                  </td>
                </tr>
              )}
            </tbody>
          </Table>
        </Box>
      )}

      {/* Bottom pagination */}
      <Box sx={{ pb: 1 }}>
        <PaginationControls
          currentPage={params.page}
          totalPages={data?.totalPages ?? 0}
          onPageChange={p => setParams({ page: p })}
          itemsPerPage={params.limit}
          onItemsPerPageChange={l => setParams({ limit: l, page: 1 })}
          totalItems={totalOrganizations}
          pageLimitOptions={ORGS_PAGE_LIMIT_OPTIONS}
        />
      </Box>

      {/* Organization Profile Modal */}
      {canManageSettings && <OrganizationProfileModal onClosed={refetch} />}

      {/* Members Modal */}
      {membersOrg && canManageSettings && (
        <Modal
          open={!!membersOrg}
          onClose={() => {
            setMembersOrg(null);
            refetch();
          }}
        >
          <ModalDialog size="lg" sx={{ width: { xs: '95vw', sm: '800px' }, maxHeight: '80vh', overflow: 'auto' }}>
            <ModalClose />
            <Typography level="h4" sx={{ mb: 2 }}>
              {membersOrg.name} - Members
            </Typography>
            <OrganizationMembers
              organization={liveMembersOrg ?? membersOrg}
              beforeMutation={() => requireOrganizationAdminPermission('settings:manage')}
            />
          </ModalDialog>
        </Modal>
      )}

      {/* Create Organization Modal */}
      <Modal open={isCreateModalOpen && (grantMode ? canAdjustCredits : canManageSettings)} onClose={resetCreateModal}>
        <ModalDialog>
          <ModalClose />
          <Typography level="h4">Create New Organization</Typography>
          <Divider sx={{ my: 2 }} />
          <Stack spacing={2}>
            <Checkbox
              checked={grantMode}
              disabled={!canAdjustCredits || !canManageSettings}
              title={!canAdjustCredits ? creditsDenied : settingsDenied}
              onChange={e => {
                if (requireOrganizationAdminPermission(e.target.checked ? 'credits:adjust' : 'settings:manage'))
                  setGrantMode(e.target.checked);
              }}
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
                <AdminReasonField
                  value={grantReason}
                  onChange={setGrantReason}
                  placeholder="Why this org is being granted (e.g. 'demo for ACME')"
                  data-testid="org-grant-reason-input"
                />
              </>
            )}
          </Stack>
          <Stack direction="row" spacing={2} justifyContent="flex-end" sx={{ mt: 3 }}>
            <Button variant="outlined" color="neutral" onClick={resetCreateModal}>
              Cancel
            </Button>
            <Button
              loading={createOrganizationMutation.isPending || grantOrgMutation.isPending}
              disabled={grantMode ? !canAdjustCredits || !isValidAdminActionReason(grantReason) : !canManageSettings}
              title={grantMode ? creditsDenied : settingsDenied}
              onClick={handleCreateOrganization}
              data-testid={grantMode ? 'grant-org-submit' : 'create-org-submit'}
            >
              {grantMode ? 'Grant Free Org' : 'Create'}
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>

      {/* Top Up Credits Modal */}
      {topUpOrg && canAdjustCredits && (
        <Modal open onClose={() => setTopUpOrg(null)}>
          <ModalDialog>
            <ModalClose />
            <Typography level="h4">Top up credits — {topUpOrg.name}</Typography>
            <Divider sx={{ my: 2 }} />
            <Stack spacing={2}>
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
              <AdminReasonField value={topUpReason} onChange={setTopUpReason} data-testid="org-topup-reason-input" />
            </Stack>
            <Stack direction="row" spacing={2} justifyContent="flex-end" sx={{ mt: 3 }}>
              <Button variant="outlined" color="neutral" onClick={() => setTopUpOrg(null)}>
                Cancel
              </Button>
              <Button
                loading={topUpMutation.isPending}
                disabled={!canAdjustCredits || !isValidAdminActionReason(topUpReason)}
                title={creditsDenied}
                onClick={handleTopUp}
                data-testid="topup-submit"
              >
                Add credits
              </Button>
            </Stack>
          </ModalDialog>
        </Modal>
      )}

      {/* Adjust Seats Modal */}
      {seatsOrg && canAdjustCredits && (
        <AdjustSeatsModal
          org={seatsOrg}
          seatsValue={seatsValue}
          setSeatsValue={setSeatsValue}
          onClose={() => setSeatsOrg(null)}
          onSubmit={handleAdjustSeats}
          isPending={seatsMutation.isPending}
        />
      )}

      {/* Revoke Modal */}
      {revokeOrg && canAdjustCredits && (
        <Modal open onClose={() => setRevokeOrg(null)}>
          <ModalDialog>
            <ModalClose />
            <Typography level="h4">Revoke grant — {revokeOrg.name}</Typography>
            <Divider sx={{ my: 2 }} />
            <Typography level="body-sm" sx={{ mb: 1 }}>
              This will mark the org&apos;s active grant as canceled. Members keep access until you remove them.
            </Typography>
            <FormControl>
              <FormLabel>Reason (optional)</FormLabel>
              <Textarea
                minRows={2}
                value={revokeReason}
                onChange={e => setRevokeReason(e.target.value)}
                data-testid="revoke-reason-input"
              />
            </FormControl>
            <Stack direction="row" spacing={2} justifyContent="flex-end" sx={{ mt: 3 }}>
              <Button variant="outlined" color="neutral" onClick={() => setRevokeOrg(null)}>
                Cancel
              </Button>
              <Button
                color="danger"
                loading={revokeMutation.isPending}
                onClick={handleRevoke}
                disabled={!canAdjustCredits}
                title={creditsDenied}
                data-testid="revoke-submit"
              >
                Revoke
              </Button>
            </Stack>
          </ModalDialog>
        </Modal>
      )}
    </Sheet>
  );
};

export default OrganizationsTab;
