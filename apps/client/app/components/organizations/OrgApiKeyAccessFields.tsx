import { FC, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  DialogContent,
  DialogTitle,
  FormControl,
  FormHelperText,
  FormLabel,
  Modal,
  ModalClose,
  ModalDialog,
  Radio,
  RadioGroup,
  Sheet,
  Stack,
  Typography,
} from '@mui/joy';
import type { IOrgApiKeyView, OrgApiKeyGrant } from '@bike4mind/common';
import { GENERIC_MODAL_API_KEY_SCOPES } from '@bike4mind/server-utils/app/constants/apiKeyScopes';
import { useOrgApiKeyOptions, useUpdateOrgApiKey } from '@client/app/hooks/data/orgApiKeys';
import { toast } from 'sonner';

export type OrgApiKeyReachMode = 'none' | 'organization' | 'groups';

export const reachModeOf = (grants: readonly OrgApiKeyGrant[]): OrgApiKeyReachMode => {
  if (grants.some(grant => grant.resourceType === 'organization')) return 'organization';
  return grants.some(grant => grant.resourceType === 'group') ? 'groups' : 'none';
};

export const grantsFor = (
  mode: OrgApiKeyReachMode,
  organizationId: string,
  groupIds: readonly string[]
): OrgApiKeyGrant[] => {
  if (mode === 'organization')
    return [{ resourceType: 'organization', resourceId: organizationId, permission: 'read' }];
  if (mode === 'groups') {
    return groupIds.map(resourceId => ({ resourceType: 'group' as const, resourceId, permission: 'read' as const }));
  }
  return [];
};

/** A one-line summary of a key's reach for the key table. */
export const describeReach = (
  grants: readonly OrgApiKeyGrant[],
  groupNames: ReadonlyMap<string, string> | undefined
): string => {
  const mode = reachModeOf(grants);
  if (mode === 'organization') return 'All org-shared content';
  if (mode === 'none') return 'Own content only';
  if (!groupNames) return `${grants.length} selected group(s)`;
  return grants
    .flatMap(grant => (grant.resourceType === 'group' ? [groupNames.get(grant.resourceId) ?? 'Removed group'] : []))
    .join(', ');
};

const toggle = (values: readonly string[], value: string): string[] =>
  values.includes(value) ? values.filter(existing => existing !== value) : [...values, value];

/** The picker's state. `mode` is kept apart from `grants` so "selected groups" with none picked yet stays visible. */
export type OrgApiKeyAccessValue = { scopes: string[]; grants: OrgApiKeyGrant[]; mode: OrgApiKeyReachMode };

export const accessValueOf = (scopes: readonly string[], grants: readonly OrgApiKeyGrant[]): OrgApiKeyAccessValue => ({
  scopes: [...scopes],
  grants: [...grants],
  mode: reachModeOf(grants),
});

/**
 * The scope and reach pickers for an org-owned key. Scopes come from the org's entitlement, not the
 * viewer's (GET /api/organizations/[id]/api-keys/options); reach is read-only access to content
 * shared with the org's groups (and its data lakes, for the whole-org option), never a member's own.
 */
export const OrgApiKeyAccessFields: FC<{
  organizationId: string;
  value: OrgApiKeyAccessValue;
  onChange: (value: OrgApiKeyAccessValue) => void;
}> = ({ organizationId, value, onChange }) => {
  const { data: options, isLoading, isError } = useOrgApiKeyOptions(organizationId);
  const groupIds = value.grants.flatMap(grant => (grant.resourceType === 'group' ? [grant.resourceId] : []));
  // Remembers the group picks across a switch to another reach mode and back.
  const [lastGroupIds, setLastGroupIds] = useState<string[]>(groupIds);

  if (isLoading) return <CircularProgress size="sm" />;
  if (isError || !options) {
    return (
      <Alert color="danger" variant="soft">
        Failed to load the scopes and groups available to this organization.
      </Alert>
    );
  }

  // A scope the key already holds but the org's plan no longer covers stays listed, so the admin can drop it.
  const listed = GENERIC_MODAL_API_KEY_SCOPES.filter(
    option => options.scopes.includes(option.value) || value.scopes.includes(option.value)
  );
  const setReach = (nextMode: OrgApiKeyReachMode, nextGroupIds: readonly string[]) => {
    if (nextMode === 'groups') setLastGroupIds([...nextGroupIds]);
    onChange({ ...value, mode: nextMode, grants: grantsFor(nextMode, organizationId, nextGroupIds) });
  };

  return (
    <Stack spacing={2}>
      <FormControl required>
        <FormLabel>Scopes</FormLabel>
        <Sheet variant="outlined" sx={{ borderRadius: 'sm', p: 1.5, maxHeight: 240, overflow: 'auto' }}>
          <Stack spacing={1}>
            {listed.map(option => (
              <Checkbox
                key={option.value}
                size="sm"
                label={options.scopes.includes(option.value) ? option.label : `${option.label} (not in plan)`}
                checked={value.scopes.includes(option.value)}
                onChange={() => onChange({ ...value, scopes: toggle(value.scopes, option.value) })}
                slotProps={{ input: { 'data-testid': `org-api-key-scope-${option.value}` } }}
              />
            ))}
          </Stack>
        </Sheet>
        <FormHelperText>Product scopes appear when the organization&apos;s plan includes the product.</FormHelperText>
      </FormControl>
      <FormControl>
        <FormLabel>Access to shared content</FormLabel>
        <RadioGroup
          value={value.mode}
          onChange={event => setReach(event.target.value as OrgApiKeyReachMode, lastGroupIds)}
          data-testid="org-api-key-reach"
        >
          <Radio
            value="none"
            label="Only what this key creates"
            slotProps={{ input: { 'data-testid': 'org-api-key-reach-none' } }}
          />
          <Radio
            value="organization"
            label="Everything shared with the organization's groups, and its data lakes"
            slotProps={{ input: { 'data-testid': 'org-api-key-reach-organization' } }}
          />
          <Radio
            value="groups"
            label="Only content shared with selected groups"
            disabled={options.groups.length === 0}
            slotProps={{ input: { 'data-testid': 'org-api-key-reach-groups' } }}
          />
        </RadioGroup>
        {value.mode === 'groups' && (
          <Sheet variant="outlined" sx={{ borderRadius: 'sm', p: 1.5, mt: 1, maxHeight: 180, overflow: 'auto' }}>
            <Stack spacing={1}>
              {options.groups.map(group => (
                <Checkbox
                  key={group.id}
                  size="sm"
                  label={group.name}
                  checked={groupIds.includes(group.id)}
                  onChange={() => setReach('groups', toggle(groupIds, group.id))}
                  slotProps={{ input: { 'data-testid': `org-api-key-group-${group.id}` } }}
                />
              ))}
            </Stack>
          </Sheet>
        )}
        <FormHelperText>
          Read-only. A member&apos;s personal content is never reachable, and access ends as soon as content stops being
          shared.
        </FormHelperText>
      </FormControl>
    </Stack>
  );
};

/** A key's access is valid to submit: some scope, and a group pick when reach is by group. */
export const isAccessComplete = (value: OrgApiKeyAccessValue): boolean =>
  value.scopes.length > 0 && (value.mode !== 'groups' || value.grants.length > 0);

/** Edits an active org key's scopes and reach in place; the server audits the change. */
export const EditOrgApiKeyAccessModal: FC<{
  organizationId: string;
  apiKey: IOrgApiKeyView | null;
  onClose: () => void;
}> = ({ organizationId, apiKey, onClose }) => {
  const updateKey = useUpdateOrgApiKey(organizationId);
  const [value, setValue] = useState<OrgApiKeyAccessValue>(() => accessValueOf([], []));

  useEffect(() => {
    if (apiKey) setValue(accessValueOf(apiKey.scopes, apiKey.grants));
  }, [apiKey]);

  const submit = async () => {
    if (!apiKey) return;
    const updated = await updateKey
      .mutateAsync({ keyId: apiKey.id, scopes: value.scopes, grants: value.grants })
      .catch(() => null);
    if (!updated) return;
    toast.success(`Updated "${updated.name}"`);
    onClose();
  };

  return (
    <Modal open={!!apiKey} onClose={onClose}>
      <ModalDialog sx={{ maxWidth: 560, width: '100%' }} data-testid="org-api-key-edit-modal">
        <ModalClose />
        <DialogTitle>Edit access for &quot;{apiKey?.name}&quot;</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Typography level="body-sm">
              Changes apply to the key&apos;s next request. The secret stays the same.
            </Typography>
            {apiKey && <OrgApiKeyAccessFields organizationId={organizationId} value={value} onChange={setValue} />}
            <Box display="flex" justifyContent="flex-end" gap={1}>
              <Button variant="plain" color="neutral" onClick={onClose}>
                Cancel
              </Button>
              <Button
                onClick={submit}
                loading={updateKey.isPending}
                disabled={!isAccessComplete(value)}
                data-testid="org-api-key-edit-submit-btn"
              >
                Save
              </Button>
            </Box>
          </Stack>
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
};
