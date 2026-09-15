import { FC, useMemo, useState } from 'react';
import {
  Autocomplete,
  Box,
  Button,
  Card,
  Chip,
  FormControl,
  FormHelperText,
  FormLabel,
  Stack,
  Typography,
} from '@mui/joy';
import GroupWorkOutlinedIcon from '@mui/icons-material/GroupWorkOutlined';
import { GROUP_TYPE_CATALOG, getGroupType, IOrganizationDocument, WithId } from '@bike4mind/common';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { fetchOrganizationGroups, setOrganizationGroupTypes } from '@client/app/utils/groupsAPICalls';
import { getErrorMessage, sanitizeErrorMessage } from '@client/app/utils/error';

const GROUP_TYPE_KEYS = GROUP_TYPE_CATALOG.map(type => type.key);
const labelFor = (key: string) => getGroupType(key)?.label ?? key;

/**
 * Platform-admin card to grant/revoke an org's allowed group types (org-groups #1172, Phase 5).
 * Sources its options from the code-defined GROUP_TYPE_CATALOG - the same single source the grant
 * route validates against - and lists the provisioned Group instances with their member counts.
 * Personal orgs cannot have group types (enforced server-side), so we surface that instead of a picker.
 */
const OrganizationGroupTypesCard: FC<{ org: WithId<IOrganizationDocument> }> = ({ org }) => {
  const queryClient = useQueryClient();

  // `baseline` is the last-known-saved set. We keep it in local state rather than reading
  // `org.allowedGroupTypes` directly because the admin org profile passes a snapshot prop that does
  // NOT refresh after a save while the modal stays open - deriving the dirty-check from it would go
  // stale and (e.g.) leave Save disabled when revoking a type just granted in the same session.
  // It resyncs when a different org loads (allowedKey) and on each successful save.
  const [selected, setSelected] = useState<string[]>(org.allowedGroupTypes ?? []);
  const [baseline, setBaseline] = useState<string[]>(org.allowedGroupTypes ?? []);
  // Resync when a DIFFERENT org loads into this card (React's adjust-state-during-render pattern,
  // not an effect). Defensive: today OrganizationsTab renders the profile modal conditionally, so
  // the card unmounts between orgs and useState re-initializes anyway. Keyed on org.id rather than
  // the allowed-set contents, because two orgs commonly share the same set (both empty) and a
  // contents key would then fail to resync. setBaseline in the save handler covers the same-org
  // case where the snapshot prop never refreshes.
  // Keyed on org id AND set contents. Either alone is incomplete: an id-only key misses a
  // same-org change if this prop ever becomes a live query result, and a contents-only key misses
  // an org switch between two orgs that happen to share a set (commonly both empty).
  const orgKey = `${org.id}|${[...(org.allowedGroupTypes ?? [])].sort().join(',')}`;
  const [syncedOrgKey, setSyncedOrgKey] = useState(orgKey);
  if (orgKey !== syncedOrgKey) {
    setSyncedOrgKey(orgKey);
    const next = org.allowedGroupTypes ?? [];
    setSelected(next);
    setBaseline(next);
  }

  const groupsQuery = useQuery({
    queryKey: ['organizations', org.id, 'groups'],
    queryFn: () => fetchOrganizationGroups(org.id),
    enabled: !org.personal,
  });

  const saveMutation = useMutation({
    mutationFn: (allowedGroupTypes: string[]) => setOrganizationGroupTypes(org.id, allowedGroupTypes),
    onSuccess: (result, allowedGroupTypes) => {
      setBaseline(allowedGroupTypes);
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.invalidateQueries({ queryKey: ['organizations', org.id, 'groups'] });
      const parts = [
        result.added.length ? `granted ${result.added.map(labelFor).join(', ')}` : '',
        result.removed.length ? `revoked ${result.removed.map(labelFor).join(', ')}` : '',
      ].filter(Boolean);
      toast.success(parts.length ? `Group types updated: ${parts.join('; ')}` : 'Group types unchanged');
    },
    onError: error => toast.error(getErrorMessage(error)),
  });

  const isDirty = useMemo(
    () => selected.length !== baseline.length || selected.some(key => !baseline.includes(key)),
    [selected, baseline]
  );

  if (org.personal) {
    return (
      <Card variant="outlined" sx={{ p: 2, mt: 2 }} data-testid="org-group-types-card">
        <Stack spacing={1}>
          <Typography level="title-md" startDecorator={<GroupWorkOutlinedIcon fontSize="small" />}>
            Group Types
          </Typography>
          <Typography level="body-sm" color="neutral">
            Personal organizations cannot be granted group types.
          </Typography>
        </Stack>
      </Card>
    );
  }

  const groups = groupsQuery.data ?? [];

  return (
    <Card variant="outlined" sx={{ p: 2, mt: 2 }} data-testid="org-group-types-card">
      <Stack spacing={1.5}>
        <Typography level="title-md" startDecorator={<GroupWorkOutlinedIcon fontSize="small" />}>
          Group Types
        </Typography>

        <FormControl>
          <FormLabel>Allowed group types</FormLabel>
          <Autocomplete
            multiple
            options={GROUP_TYPE_KEYS}
            value={selected}
            getOptionLabel={labelFor}
            onChange={(_event, value) => setSelected(value)}
            placeholder={selected.length ? '' : 'Grant group types to this organization'}
            data-testid="org-group-types-input"
          />
          <FormHelperText>
            Granting a type provisions a group; revoking one removes it and unassigns every member.
          </FormHelperText>
        </FormControl>

        <Box>
          <Button
            size="sm"
            onClick={() => saveMutation.mutate(selected)}
            loading={saveMutation.isPending}
            disabled={!isDirty}
            data-testid="org-group-types-save-btn"
          >
            Save group types
          </Button>
        </Box>

        <Stack spacing={0.5}>
          <Typography level="body-xs" textColor="text.tertiary">
            Provisioned groups
          </Typography>
          {groupsQuery.isPending ? (
            <Typography level="body-sm" color="neutral" data-testid="org-group-types-loading">
              Loading provisioned groups...
            </Typography>
          ) : groupsQuery.isError && !groupsQuery.data ? (
            // Not the empty state: "no groups provisioned" would invite a platform admin to
            // re-grant types the org may already have. Gated on having no data for the same reason
            // as the customer-side list: isError also covers a failed refetch that still holds the
            // previous result, and dropping a rendered list on a blip is worse than a stale one.
            <Typography level="body-sm" color="danger" data-testid="org-group-types-error">
              Could not load provisioned groups. {sanitizeErrorMessage(getErrorMessage(groupsQuery.error))}
            </Typography>
          ) : groups.length === 0 ? (
            <Typography level="body-sm" color="neutral" data-testid="org-group-types-empty">
              No groups provisioned yet.
            </Typography>
          ) : (
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {groups.map(group => (
                <Chip
                  key={group.id}
                  variant="soft"
                  color="primary"
                  data-testid={`org-group-types-provisioned-${group.type}`}
                >
                  {group.name} ({group.memberCount})
                </Chip>
              ))}
            </Stack>
          )}
        </Stack>
      </Stack>
    </Card>
  );
};

export default OrganizationGroupTypesCard;
