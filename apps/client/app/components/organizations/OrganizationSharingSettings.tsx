import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  FormControl,
  FormHelperText,
  FormLabel,
  Stack,
  Switch,
  Textarea,
  Typography,
} from '@mui/joy';
import {
  isOrgOwnerOrCurrentAdmin,
  organizationSharingPolicy,
  OrganizationSharingPolicySchema,
  type IOrganizationDocument,
} from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useUpdateOrganization } from '@client/app/hooks/data/organizations';

export function OrganizationSharingSettings({ organization }: { organization: IOrganizationDocument }) {
  const { currentUser } = useUser();
  const mutation = useUpdateOrganization();
  const [policy, setPolicy] = useState(() => organizationSharingPolicy(organization));
  const [domains, setDomains] = useState(policy.allowedDomains.join('\n'));
  useEffect(() => {
    const next = organizationSharingPolicy(organization);
    setPolicy(next);
    setDomains(next.allowedDomains.join('\n'));
  }, [organization.id, organization.sharingPolicy]);
  const canEdit = !!currentUser && isOrgOwnerOrCurrentAdmin(currentUser, organization);
  const parsed = OrganizationSharingPolicySchema.safeParse({
    ...policy,
    allowedDomains: [...new Set(domains.split(/[\s,]+/).filter(Boolean))],
  });
  return (
    <Card variant="outlined" data-testid="organization-sharing-settings">
      <Typography level="title-sm">Sharing policy</Typography>
      <Typography level="body-sm">
        Applies to content created in this organization context. Existing content without an organization remains
        personal. These settings control new links and grants; existing shares are not revoked.
      </Typography>
      {!canEdit && <Alert color="neutral">Only organization owners and managers can change sharing policy.</Alert>}
      <Stack spacing={2}>
        <FormControl>
          <FormLabel>Allow public links</FormLabel>
          <Switch
            checked={policy.allowPublicLinks}
            disabled={!canEdit}
            onChange={event => setPolicy({ ...policy, allowPublicLinks: event.target.checked })}
            slotProps={{ input: { 'data-testid': 'organization-sharing-public-switch' } }}
          />
          <FormHelperText>When blocked, public publication and anonymous share links are unavailable.</FormHelperText>
        </FormControl>
        <FormControl>
          <FormLabel>Allow sharing outside the organization</FormLabel>
          <Switch
            checked={policy.allowExternalSharing}
            disabled={!canEdit}
            onChange={event => setPolicy({ ...policy, allowExternalSharing: event.target.checked })}
            slotProps={{ input: { 'data-testid': 'organization-sharing-external-switch' } }}
          />
          <FormHelperText>
            When blocked, only members and approved email domains can receive new shares. Anonymous links are also
            blocked.
          </FormHelperText>
        </FormControl>
        <FormControl error={!parsed.success}>
          <FormLabel>Approved external email domains</FormLabel>
          <Textarea
            value={domains}
            disabled={!canEdit}
            onChange={event => setDomains(event.target.value)}
            placeholder="example.com"
            slotProps={{ textarea: { 'data-testid': 'organization-sharing-domains-input' } }}
          />
          <FormHelperText>
            {parsed.success
              ? 'Optional exceptions when outside sharing is blocked. Exact email domains only; one per line or separated by commas.'
              : parsed.error.issues[0]?.message}
          </FormHelperText>
        </FormControl>
        <Button
          disabled={!canEdit || !parsed.success}
          loading={mutation.isPending}
          data-testid="organization-sharing-save-btn"
          onClick={async () => {
            if (parsed.success)
              await mutation.mutateAsync({ orgId: organization.id, data: { sharingPolicy: parsed.data } });
          }}
        >
          Save sharing policy
        </Button>
      </Stack>
    </Card>
  );
}
