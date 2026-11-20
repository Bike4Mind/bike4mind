import { useEffect, useState } from 'react';
import { Alert, Button, Card, FormControl, FormLabel, Input, Stack, Typography } from '@mui/joy';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  canAdministerOrganization,
  MAX_RETENTION_DAYS,
  foreverRetention,
  retentionKinds,
  shortensRetention,
  type IOrganizationDocument,
  type OrganizationRetentionPolicy,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';

const labels = { chats: 'Chat history', files: 'Uploaded files', media: 'Generated media' };
type Estimate = { token: string; counts: Record<keyof OrganizationRetentionPolicy, number> };

export default function OrganizationRetentionSection({ organization }: { organization: IOrganizationDocument }) {
  const { currentUser } = useUser();
  const queryClient = useQueryClient();
  const queryKey = ['organization-retention', organization.id];
  const { data } = useQuery<{ policy: OrganizationRetentionPolicy; version: number }>({
    queryKey,
    queryFn: async () => (await api.get(`/api/organizations/${organization.id}/retention`)).data,
  });
  const [draft, setDraft] = useState<OrganizationRetentionPolicy | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setDraft(null);
    setEstimate(null);
  }, [data?.version, organization.id]);
  const policy = data?.policy ?? organization.retentionPolicy ?? foreverRetention;
  const next = draft ?? policy;
  const canEdit = !!currentUser && canAdministerOrganization(currentUser, organization) && !organization.personal;
  const shortening = shortensRetention(policy, next);
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const body = { policy: next, version: data?.version ?? 0 };
      if (shortening && !estimate) {
        setEstimate((await api.post(`/api/organizations/${organization.id}/retention`, body)).data);
      } else {
        await api.put(`/api/organizations/${organization.id}/retention`, {
          ...body,
          confirmationToken: estimate?.token,
        });
        setDraft(null);
        setEstimate(null);
        await queryClient.invalidateQueries({ queryKey });
      }
    } catch {
      setError('Could not update retention. Reload the policy and request a new estimate.');
      setEstimate(null);
      await queryClient.invalidateQueries({ queryKey });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card variant="outlined" data-testid="organization-retention-section">
      <Stack spacing={2}>
        <Typography level="title-md">Data retention</Typography>
        <Typography level="body-sm">
          Only explicitly organization-owned content is eligible. Personal and older unbound chats are excluded. Chat
          history is aged per message; generated media has its own period. Shared media stays while another live copy
          references it.
        </Typography>
        {retentionKinds.map(kind => (
          <FormControl key={kind}>
            <FormLabel>
              {labels[kind]}: {policy[kind] === null ? 'Keep forever' : `${policy[kind]} days`}
            </FormLabel>
            {canEdit && (
              <Input
                type="number"
                placeholder="Keep forever"
                value={next[kind] ?? ''}
                disabled={busy || !data}
                slotProps={{
                  input: { min: 1, max: MAX_RETENTION_DAYS, 'data-testid': `organization-retention-${kind}-input` },
                }}
                onChange={event => {
                  setDraft({ ...next, [kind]: event.target.value === '' ? null : Number(event.target.value) });
                  setEstimate(null);
                }}
              />
            )}
          </FormControl>
        ))}
        {estimate && (
          <Alert color="warning" data-testid="organization-retention-estimate">
            Estimated eligible deletions: {estimate.counts.chats} messages, {estimate.counts.files} uploaded files,{' '}
            {estimate.counts.media} generated files/objects. Counts can change before scheduled cleanup. Confirming
            enables automatic deletion; this cannot be undone.
          </Alert>
        )}
        {error && (
          <Alert color="danger" data-testid="organization-retention-error">
            {error}
          </Alert>
        )}
        {canEdit && (
          <Button
            data-testid="organization-retention-save-btn"
            color={estimate ? 'danger' : 'primary'}
            loading={busy}
            disabled={!data || !draft}
            onClick={save}
          >
            {estimate ? 'Confirm shorter retention' : shortening ? 'Estimate deletions' : 'Save retention'}
          </Button>
        )}
      </Stack>
    </Card>
  );
}
