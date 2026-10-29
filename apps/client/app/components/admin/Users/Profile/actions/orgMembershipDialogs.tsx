import React, { useMemo, useState } from 'react';
import { Autocomplete, FormControl, FormLabel, Typography } from '@mui/joy';
import { toast } from 'sonner';
import {
  organizationMemberRole,
  organizationSeatUsage,
  type IOrganizationDocument,
  type OrganizationMemberRole,
} from '@bike4mind/common';
import { useSearchOrganizations } from '@client/app/hooks/data/organizations';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import { ActionDialog, ADMIN_REASON_PRESETS, ChangePreview, SegmentedControl, useUndoToast } from '../../../shared';
import { useAdminUserOrgMembership, type OrgMemberRoleChoice } from './useAdminUserOrgMembership';
import { ORGANIZATION_ROLE_LABELS, displayName, type AdminUserProfile } from '../userProfileModel';

/** The slice of an organization the membership dialogs read. */
export type MembershipOrg = Pick<IOrganizationDocument, 'id' | 'name' | 'userId' | 'users' | 'adminUserIds' | 'seats'>;

type DialogProps = { user: AdminUserProfile; onClose: () => void; onAudit?: () => void };

const undoReason = (reason: string) => `Undo: ${reason}`.slice(0, 500);

export const seatBlockedReason = (org: MembershipOrg): string | null => {
  const { seats, full } = organizationSeatUsage(org);
  return full
    ? `${org.name} uses all ${seats} paid seats. Raise the seat count on its profile before adding anyone.`
    : null;
};

/** Personal orgs are left out: they belong to one person and take no members. */
export const AddToOrganizationDialog: React.FC<DialogProps & { memberOrgIds: readonly string[] }> = ({
  user,
  memberOrgIds,
  onClose,
  onAudit,
}) => {
  const membership = useAdminUserOrgMembership(user.id);
  const showUndo = useUndoToast();
  const { debouncedValue: search, setValue: setSearch } = useDebounceValue('', 400);
  const results = useSearchOrganizations({
    page: 1,
    limit: 20,
    search,
    filters: { personal: false },
    orderBy: { by: 'name', direction: 'asc' },
  });
  const [picked, setPicked] = useState<MembershipOrg | null>(null);
  const options = useMemo(
    () => (results.data?.data ?? []).filter(org => !memberOrgIds.includes(org.id)),
    [results.data, memberOrgIds]
  );
  const usage = picked && organizationSeatUsage(picked);

  const handleConfirm = async (reason: string) => {
    if (!picked) return;
    await membership.add(picked.id, reason);
    onClose();
    showUndo({
      message: `Added to ${picked.name}`,
      onUndo: () => membership.remove(picked.id, undoReason(reason)),
      onViewAudit: onAudit,
    });
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Add to organization"
      description={`${displayName(user)} joins as a member and can see what the organization shares with its members.`}
      reasonPresets={ADMIN_REASON_PRESETS.orgMembership}
      confirmLabel={picked ? `Add to ${picked.name}` : 'Add to organization'}
      blockedReason={picked ? seatBlockedReason(picked) : 'Pick an organization.'}
      onConfirm={handleConfirm}
      data-testid="org-add-dialog"
    >
      <FormControl required>
        <FormLabel>Organization</FormLabel>
        <Autocomplete<MembershipOrg>
          autoFocus
          placeholder="Search organizations"
          loading={results.isLoading}
          options={options}
          value={picked}
          onChange={(_event, org) => setPicked(org)}
          onInputChange={(_event, input, reason) => {
            // Selecting writes the label back with reason 'reset'; that is not a new search.
            if (reason !== 'reset') setSearch(input ?? '');
          }}
          filterOptions={items => items}
          isOptionEqualToValue={(option, value) => option.id === value.id}
          getOptionLabel={org => org.name}
          slotProps={{ input: { 'data-testid': 'org-add-dialog-org-input' } }}
          data-testid="org-add-dialog-org"
        />
      </FormControl>
      {usage && (
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="org-add-dialog-seats">
          {`${usage.used} of ${usage.seats} paid seats used`}
        </Typography>
      )}
    </ActionDialog>
  );
};

const ROLE_CHOICES: readonly { value: OrgMemberRoleChoice; label: string }[] = [
  { value: 'member', label: ORGANIZATION_ROLE_LABELS.member },
  { value: 'manager', label: ORGANIZATION_ROLE_LABELS.manager },
];

/** Managers administer the org's roster and groups; the owner's role is fixed. */
export const ChangeOrgRoleDialog: React.FC<DialogProps & { org: MembershipOrg }> = ({
  user,
  org,
  onClose,
  onAudit,
}) => {
  const membership = useAdminUserOrgMembership(user.id);
  const showUndo = useUndoToast();
  const current: OrganizationMemberRole | null = organizationMemberRole(org, user.id);
  const [next, setNext] = useState<OrgMemberRoleChoice>(current === 'manager' ? 'manager' : 'member');

  const handleConfirm = async (reason: string) => {
    if (current !== 'manager' && current !== 'member') return;
    await membership.setRole(org.id, next, reason);
    onClose();
    showUndo({
      message: `${ORGANIZATION_ROLE_LABELS[next]} of ${org.name}`,
      onUndo: () => membership.setRole(org.id, current, undoReason(reason)),
      onViewAudit: onAudit,
    });
  };

  const blockedReason =
    current === 'owner'
      ? `${displayName(user)} owns ${org.name}. The owner's role can't be changed.`
      : !current
        ? `${displayName(user)} is no longer in ${org.name}.`
        : next === current
          ? 'Pick a different role.'
          : null;

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Change organization role"
      description={`Managers of ${org.name} can add and remove its members and manage its groups.`}
      reasonPresets={ADMIN_REASON_PRESETS.orgRoleChange}
      confirmLabel={`Make ${ORGANIZATION_ROLE_LABELS[next]}`}
      blockedReason={blockedReason}
      onConfirm={handleConfirm}
      data-testid="org-role-dialog"
    >
      <SegmentedControl
        options={ROLE_CHOICES}
        value={next}
        onChange={setNext}
        aria-label="Organization role"
        data-testid="org-role-dialog-role"
      />
      <ChangePreview
        before={current ? ORGANIZATION_ROLE_LABELS[current] : '-'}
        after={ORGANIZATION_ROLE_LABELS[next]}
        data-testid="org-role-dialog-preview"
      />
    </ActionDialog>
  );
};

/**
 * No undo: removal lapses the member's grants on the org's data lakes and its groups, which adding
 * them back does not restore.
 */
export const RemoveFromOrganizationDialog: React.FC<DialogProps & { org: MembershipOrg; isActive: boolean }> = ({
  user,
  org,
  isActive,
  onClose,
}) => {
  const membership = useAdminUserOrgMembership(user.id);
  const name = displayName(user);
  const role = organizationMemberRole(org, user.id);

  const handleConfirm = async (reason: string) => {
    await membership.remove(org.id, reason);
    onClose();
    toast.success(`${name} was removed from ${org.name}.`);
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Remove from organization"
      description={[
        `${name} loses access to the data lakes and groups of ${org.name}.`,
        role === 'manager' && 'Their manager rights are removed.',
        isActive && 'It is their active organization, so that is cleared too.',
        'Adding them back does not restore what was shared with them.',
      ]
        .filter(Boolean)
        .join(' ')}
      reasonPresets={ADMIN_REASON_PRESETS.orgMembership}
      confirmLabel={`Remove from ${org.name}`}
      tone="danger"
      blockedReason={
        role === 'owner'
          ? `${name} owns ${org.name}. Transfer ownership before removing them.`
          : !role
            ? `${name} is no longer in ${org.name}.`
            : null
      }
      onConfirm={handleConfirm}
      data-testid="org-remove-dialog"
    />
  );
};
