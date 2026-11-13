import { useState } from 'react';
import { Alert, Button, Card, Option, Select, Stack, Typography } from '@mui/joy';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrganizationLibraryKind } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useOrganizationLibrary } from '@client/app/hooks/data/organizationLibrary';
import { getErrorMessage } from '@client/app/utils/error';
import OrganizationLibraryPicker from './OrganizationLibraryPicker';

export default function OrganizationLibrarySection({
  organizationId,
  canManage,
}: {
  organizationId: string;
  canManage: boolean;
}) {
  const { data: items = [], isLoading, isError } = useOrganizationLibrary(undefined, organizationId);
  const qc = useQueryClient();
  const [kind, setKind] = useState<OrganizationLibraryKind>('agent');
  const [sourceId, setSourceId] = useState('');
  const url = `/api/organizations/${organizationId}/library`;
  const sources = useQuery({
    queryKey: ['organization-library-sources', organizationId, kind],
    enabled: canManage,
    queryFn: async () =>
      (await api.get<{ sources: { id: string; name: string }[] }>(url, { params: { sources: kind } })).data.sources,
  });
  const mutation = useMutation({
    mutationFn: async (
      action:
        { type: 'publish' } | { type: 'pin'; itemId: string; pinned: boolean } | { type: 'remove'; itemId: string }
    ) => {
      if (action.type === 'publish') await api.post(url, { kind, sourceId: sourceId.trim() });
      else if (action.type === 'pin') await api.patch(url, { itemId: action.itemId, pinned: action.pinned });
      else await api.delete(url, { data: { itemId: action.itemId } });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['organization-library'] });
    },
  });
  return (
    <Stack spacing={2} data-testid="organization-library-section">
      <Typography level="title-lg">Library</Typography>
      <Typography level="body-sm">
        Published definitions belong to the organization and remain available when their author leaves.
      </Typography>
      <OrganizationLibraryPicker organizationId={organizationId} />
      {canManage && (
        <Card variant="outlined">
          <Typography level="title-md">Publish a personal item</Typography>
          <Typography level="body-sm">
            Publishing saves a standalone copy, not a live link. Agents exclude projects, credits, memory, runtime
            state, and personal integrations. Voice agents are not supported.
          </Typography>
          <Select
            value={kind}
            onChange={(_, value) => {
              if (value) {
                setKind(value);
                setSourceId('');
              }
            }}
            data-testid="organization-library-kind-select"
          >
            {(['agent', 'skill', 'prompt', 'template'] as const).map(value => (
              <Option key={value} value={value}>
                {value}
              </Option>
            ))}
          </Select>
          <Select
            value={sourceId || null}
            onChange={(_, value) => setSourceId(value ?? '')}
            placeholder="Choose a personal item"
            data-testid="organization-library-source-select"
          >
            {(sources.data ?? []).map(source => (
              <Option key={source.id} value={source.id}>
                {source.name}
              </Option>
            ))}
          </Select>
          {sources.isError && <Alert color="danger">Could not load personal items.</Alert>}
          <Button
            disabled={!/^[a-f\d]{24}$/i.test(sourceId.trim())}
            loading={mutation.isPending}
            onClick={() => mutation.mutate({ type: 'publish' })}
            data-testid="organization-library-publish-btn"
          >
            Publish to organization
          </Button>
        </Card>
      )}
      {mutation.isError && <Alert color="danger">{getErrorMessage(mutation.error)}</Alert>}
      {mutation.isSuccess && <Alert color="success">Library updated.</Alert>}
      {isError && <Alert color="danger">Could not load the library.</Alert>}
      {!isLoading && !isError && items.length === 0 && <Typography>No published items yet.</Typography>}
      {items.map(item => (
        <Card key={item.id} variant="outlined" data-testid="organization-library-item">
          <Typography level="title-sm">
            {item.pinned ? 'Pinned: ' : ''}
            {item.name} ({item.kind})
          </Typography>
          <Typography level="body-sm">{item.description}</Typography>
          {canManage && (
            <Stack direction="row" spacing={1}>
              <Button
                size="sm"
                variant="outlined"
                disabled={mutation.isPending}
                data-testid="organization-library-pin-btn"
                onClick={() => mutation.mutate({ type: 'pin', itemId: item.id, pinned: !item.pinned })}
              >
                {item.pinned ? 'Unpin' : 'Pin'}
              </Button>
              <Button
                size="sm"
                color="danger"
                variant="outlined"
                disabled={mutation.isPending}
                data-testid="organization-library-remove-btn"
                onClick={() =>
                  window.confirm('Remove this published item? Existing personal copies are kept.') &&
                  mutation.mutate({ type: 'remove', itemId: item.id })
                }
              >
                Remove
              </Button>
            </Stack>
          )}
        </Card>
      ))}
    </Stack>
  );
}
