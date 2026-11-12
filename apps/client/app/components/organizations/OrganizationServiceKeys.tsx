import { useState } from 'react';
import { Alert, Button, Card, Checkbox, FormControl, FormLabel, Input, Stack, Typography } from '@mui/joy';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiKeyScope } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';

interface ServiceKey {
  id: string;
  name: string;
  principalId: string;
  status: string;
  createdAt: string;
  createdByUserId?: string;
  lastUsedAt?: string;
  grants: { resourceType: string; resourceId: string; permission: string }[];
}

export default function OrganizationServiceKeys({ organizationId }: { organizationId: string }) {
  const client = useQueryClient();
  const queryKey = ['organizations', organizationId, 'service-keys'];
  const endpoint = `/api/organizations/${organizationId}/service-keys`;
  const [name, setName] = useState('');
  const [compute, setCompute] = useState(false);
  const [projects, setProjects] = useState('');
  const [secret, setSecret] = useState<string>();
  const keys = useQuery({ queryKey, queryFn: async () => (await api.get<ServiceKey[]>(endpoint)).data });
  const mutation = useMutation({
    mutationFn: async ({ action, id }: { action: 'create' | 'rotate' | 'revoke'; id?: string }) => {
      if (action === 'revoke') {
        await api.delete(`${endpoint}/${id}`);
        return;
      }
      const projectIds = [...new Set(projects.split(/[\s,]+/).filter(Boolean))];
      const result =
        action === 'rotate'
          ? await api.post<{ key: string }>(`${endpoint}/${id}`, {})
          : await api.post<{ key: string }>(endpoint, {
              name,
              scopes: [
                ...(compute ? [ApiKeyScope.AI_CHAT] : []),
                ...(projectIds.length ? [ApiKeyScope.READ_PROJECTS] : []),
              ],
              grants: [
                ...(compute
                  ? [{ resourceType: 'organization', resourceId: organizationId, permission: 'compute' }]
                  : []),
                ...projectIds.map(resourceId => ({ resourceType: 'project', resourceId, permission: 'read' })),
              ],
            });
      return result.data.key;
    },
    onSuccess: async key => {
      setSecret(key);
      await client.invalidateQueries({ queryKey });
    },
  });
  return (
    <Card data-testid="org-service-keys-section">
      <Typography level="title-lg">Organization service keys</Typography>
      <Typography level="body-sm">
        Non-login service accounts use no seats and keep working when their creator leaves. No human permissions are
        inherited. Compute grants allow only POST /api/lattice/chat (no server-side tool execution). Project grants read
        only that org-bound project details, not its notebooks or files. All other endpoints are denied. Revoke and
        recreate to change grants.
      </Typography>
      <FormControl>
        <FormLabel>Name</FormLabel>
        <Input value={name} onChange={e => setName(e.target.value)} data-testid="org-service-keys-name-input" />
      </FormControl>
      <Checkbox
        label="Allow organization-billed lattice compute"
        checked={compute}
        onChange={e => setCompute(e.target.checked)}
        data-testid="org-service-keys-compute-checkbox"
      />
      <FormControl>
        <FormLabel>Project IDs (read only, comma separated)</FormLabel>
        <Input
          value={projects}
          onChange={e => setProjects(e.target.value)}
          data-testid="org-service-keys-projects-input"
        />
      </FormControl>
      <Button
        disabled={!name.trim() || (!compute && !projects.trim())}
        loading={mutation.isPending}
        onClick={() => mutation.mutate({ action: 'create' })}
        data-testid="org-service-keys-create-btn"
      >
        Create service key
      </Button>
      {secret && (
        <Alert color="warning" data-testid="org-service-keys-secret-alert">
          <Stack>
            <Typography>Copy now; this secret is shown only once.</Typography>
            <Typography sx={{ wordBreak: 'break-all' }}>{secret}</Typography>
            <Button onClick={() => setSecret(undefined)} data-testid="org-service-keys-dismiss-btn">
              Dismiss secret
            </Button>
          </Stack>
        </Alert>
      )}
      {(keys.isError || mutation.isError) && (
        <Alert color="danger">Could not complete the request. Check your permissions and org-bound project IDs.</Alert>
      )}
      {keys.isPending && <Typography>Loading service keys...</Typography>}
      {keys.data?.map(key => (
        <Card key={key.id} variant="outlined" data-testid="org-service-keys-row">
          <Typography>
            {key.name} ({key.status})
          </Typography>
          <Typography level="body-xs">
            Principal: {key.principalId}. Created by: {key.createdByUserId}. Created: {key.createdAt}. Last used:{' '}
            {key.lastUsedAt ?? 'Never'}.
          </Typography>
          <Typography level="body-xs">
            {key.grants.map(grant => `${grant.resourceType}:${grant.resourceId} ${grant.permission}`).join(', ')}
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button
              disabled={key.status !== 'active' || mutation.isPending}
              onClick={() => mutation.mutate({ action: 'rotate', id: key.id })}
              data-testid="org-service-keys-rotate-btn"
            >
              Rotate
            </Button>
            <Button
              color="danger"
              disabled={key.status === 'disabled' || mutation.isPending}
              onClick={() => mutation.mutate({ action: 'revoke', id: key.id })}
              data-testid="org-service-keys-revoke-btn"
            >
              Revoke
            </Button>
          </Stack>
        </Card>
      ))}
    </Card>
  );
}
