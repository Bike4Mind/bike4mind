import { FC, useState } from 'react';
import { Alert, Button, Chip, CircularProgress, Sheet, Stack, Table, Typography } from '@mui/joy';
import { ApiKeyStatus, type IOrgMemberApiKeyView } from '@bike4mind/common';
import ConfirmationModal from '@client/app/components/common/ConfirmationModal';
import { useOrgMemberApiKeys, useRevokeOrgMemberApiKey } from '@client/app/hooks/data/orgApiKeys';
import { toast } from 'sonner';
import { STATUS_LABEL, effectiveStatus, formatDate } from './orgApiKeyDisplay';

interface OrgMemberApiKeysSectionProps {
  organizationId: string;
}

const creatorName = (key: IOrgMemberApiKeyView): string => key.createdBy.name ?? 'Deleted user';

/**
 * Members' own API keys billed to this organization. Owner, managers and platform admins can see and revoke
 * them (the same gate as the routes, manageKeys permission); the member who created a key is told when it is revoked.
 */
const OrgMemberApiKeysSection: FC<OrgMemberApiKeysSectionProps> = ({ organizationId }) => {
  const { data: keys, isLoading, isError } = useOrgMemberApiKeys(organizationId);
  const revokeKey = useRevokeOrgMemberApiKey(organizationId);
  const [pending, setPending] = useState<IOrgMemberApiKeyView | null>(null);

  const confirm = async () => {
    if (!pending) return;
    const revoked = await revokeKey
      .mutateAsync(pending.id)
      .then(() => true)
      .catch(() => false);
    if (revoked) toast.success(`Revoked "${pending.name}"`);
    setPending(null);
  };

  return (
    <Stack spacing={2} data-testid="org-member-api-keys-section">
      <Typography level="body-sm" color="neutral">
        Keys members created for themselves and billed to the organization. Revoking one stops it working immediately
        and notifies the member who created it.
      </Typography>

      {isLoading && <CircularProgress size="sm" />}
      {isError && (
        <Alert color="danger" variant="soft" data-testid="org-member-api-keys-error">
          Failed to load the members&apos; API keys.
        </Alert>
      )}
      {keys && keys.length === 0 && (
        <Typography level="body-sm" data-testid="org-member-api-keys-empty">
          No member API keys are billed to this organization.
        </Typography>
      )}
      {keys && keys.length > 0 && (
        <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
          <Table size="sm" data-testid="org-member-api-keys-table" sx={{ minWidth: 840 }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Created by</th>
                <th>Scopes</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Credits used (lifetime)</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {keys.map(key => {
                const status = effectiveStatus(key);
                return (
                  <tr key={key.id} data-testid={`org-member-api-key-row-${key.id}`}>
                    <td>
                      <Typography level="body-sm">{key.name}</Typography>
                      <Typography level="body-xs" fontFamily="code">
                        {key.keyPrefix}...
                      </Typography>
                    </td>
                    <td>{creatorName(key)}</td>
                    <td>
                      <Stack direction="row" flexWrap="wrap" gap={0.5}>
                        {key.scopes.map(scope => (
                          <Chip key={scope} size="sm" variant="soft">
                            {scope}
                          </Chip>
                        ))}
                      </Stack>
                    </td>
                    <td>{formatDate(key.createdAt)}</td>
                    <td>{key.lastUsedAt ? formatDate(key.lastUsedAt) : 'Never'}</td>
                    <td>{key.creditsUsed.toLocaleString()}</td>
                    <td>
                      <Chip size="sm" variant="soft" color={STATUS_LABEL[status].color}>
                        {STATUS_LABEL[status].label}
                      </Chip>
                    </td>
                    <td>
                      {status === ApiKeyStatus.ACTIVE && (
                        <Button
                          size="sm"
                          variant="plain"
                          color="danger"
                          onClick={() => setPending(key)}
                          data-testid={`org-member-api-key-revoke-btn-${key.id}`}
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Sheet>
      )}

      <ConfirmationModal
        open={!!pending}
        onClose={() => setPending(null)}
        onConfirm={confirm}
        loading={revokeKey.isPending}
        showToast={false}
        title="Revoke member API key?"
        description={
          pending
            ? `"${pending.name}", created by ${creatorName(pending)}, stops working immediately. This cannot be undone.`
            : ''
        }
        confirmText="Revoke"
        confirmColor="danger"
      />
    </Stack>
  );
};

export default OrgMemberApiKeysSection;
