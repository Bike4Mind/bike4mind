import { useState } from 'react';
import { Box, Button, Chip, Input, Stack, Switch, Typography } from '@mui/joy';
import { toast } from 'sonner';
import type { IMcpConnectionPublic } from '@bike4mind/common';
import {
  mcpConnectionErrorCode,
  mcpConnectionErrorMessage,
  useDeleteMcpConnection,
  useRefreshMcpConnectionTools,
  useRotateMcpConnectionApiKey,
  useStartMcpConnectionOAuth,
  useUpdateMcpConnection,
} from '@client/app/hooks/data/mcpConnections';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import McpToolReview from './McpToolReview';
import { connectionChip, needsSignIn, offeredToolCount, pendingReviewCount } from './customMcpModel';

type Panel = 'none' | 'review' | 'api-key' | 'client';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * One custom connection in the manage list: status, how many tools are offered, and the actions
 * that fit its state. `reviewOnMount` opens the tool review straight away (right after adding).
 */
const McpConnectionItem = ({
  connection,
  reviewOnMount = false,
}: {
  connection: IMcpConnectionPublic;
  reviewOnMount?: boolean;
}) => {
  const confirm = useConfirmation();
  const update = useUpdateMcpConnection();
  const refresh = useRefreshMcpConnectionTools();
  const rotate = useRotateMcpConnectionApiKey();
  const remove = useDeleteMcpConnection();
  const startOAuth = useStartMcpConnectionOAuth();
  const [panel, setPanel] = useState<Panel>(
    reviewOnMount && connection.status === 'connected' && connection.tools.length > 0 ? 'review' : 'none'
  );
  const [reviewConnection, setReviewConnection] = useState<IMcpConnectionPublic | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');

  const testId = `custom-mcp-connection-${connection.id}`;
  const chip = connectionChip(connection);
  const pending = pendingReviewCount(connection);
  const blocked = connection.status === 'blocked_by_policy';
  const busy = update.isPending || refresh.isPending || rotate.isPending || remove.isPending || startOAuth.isPending;

  const signIn = (manual?: { clientId: string; clientSecret?: string }) =>
    startOAuth.mutate(
      { id: connection.id, ...manual },
      {
        onError: error => {
          // The server offers no client registration: the user brings the client they made with the provider.
          if (mcpConnectionErrorCode(error) === 'client_required') {
            setPanel('client');
            toast.info('This server needs a client id from the provider to sign in.');
            return;
          }
          toast.error(mcpConnectionErrorMessage(error, 'Could not start sign-in. Try again.'));
        },
      }
    );

  const refreshTools = () =>
    refresh.mutate(connection.id, {
      onSuccess: ({ discovery, connection: refreshed }) => {
        const changes = discovery.added.length + discovery.changed.length;
        toast.success(changes > 0 ? `${plural(changes, 'tool', 'tools')} to review.` : 'Tools are up to date.');
        if (pendingReviewCount(refreshed) > 0) {
          setReviewConnection(refreshed);
          setPanel('review');
        }
      },
      onError: error => toast.error(mcpConnectionErrorMessage(error, 'Could not refresh the tools.')),
    });

  const saveApiKey = () =>
    rotate.mutate(
      { id: connection.id, value: apiKey },
      {
        onSuccess: rotated => {
          setApiKey('');
          setReviewConnection(rotated);
          setPanel(rotated.status === 'connected' && pendingReviewCount(rotated) > 0 ? 'review' : 'none');
          if (rotated.status === 'connected') toast.success('API key replaced.');
          else toast.error(rotated.lastError?.message ?? 'The server did not accept the key.');
        },
        onError: error => toast.error(mcpConnectionErrorMessage(error, 'Could not replace the API key.')),
      }
    );

  const setEnabled = (enabled: boolean) =>
    update.mutate(
      { id: connection.id, enabled },
      { onError: error => toast.error(mcpConnectionErrorMessage(error, 'Could not update the connector.')) }
    );

  const deleteConnection = () =>
    confirm({
      type: 'danger',
      title: `Remove ${connection.displayName}`,
      description:
        connection.auth.kind === 'oauth'
          ? 'This signs Bike4Mind out of the server and removes the connector and its tool settings.'
          : connection.auth.kind === 'api_key'
            ? 'This removes the connector and its tool settings. Revoke the API key at the provider if you no longer need it.'
            : 'This removes the connector and its tool settings.',
      okLabel: 'Remove',
      onOk: () =>
        remove.mutate(connection.id, {
          onSuccess: () => toast.success(`${connection.displayName} removed.`),
          onError: error => toast.error(mcpConnectionErrorMessage(error, 'Could not remove the connector.')),
        }),
    });

  const lastUsed = connection.lastUsedAt ? new Date(connection.lastUsedAt).toLocaleDateString() : null;

  return (
    <Box data-testid={testId} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: '8px', p: '12px' }}>
      <Stack direction="row" alignItems="flex-start" gap="12px">
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" alignItems="center" gap="8px" flexWrap="wrap">
            <Typography level="title-sm" sx={{ wordBreak: 'break-word' }}>
              {connection.displayName}
            </Typography>
            <Chip size="sm" variant="soft" color={chip.color} data-testid={`${testId}-status`}>
              {chip.label}
            </Chip>
          </Stack>
          <Typography level="body-xs" sx={{ color: 'text.tertiary', wordBreak: 'break-all' }}>
            {connection.displayUrl}
          </Typography>
          <Typography level="body-xs" sx={{ mt: '4px', color: 'text.secondary' }} data-testid={`${testId}-summary`}>
            {`${offeredToolCount(connection)} of ${plural(connection.tools.length, 'tool', 'tools')} on`}
            {pending > 0 ? `, ${pending} waiting for review` : ''}
            {lastUsed ? `. Last used ${lastUsed}` : ''}
          </Typography>
        </Box>
        <Switch
          size="sm"
          checked={connection.enabled}
          disabled={busy || blocked}
          onChange={event => setEnabled(event.target.checked)}
          slotProps={{
            input: { 'aria-label': `Use ${connection.displayName}`, 'data-testid': `${testId}-enabled-switch` },
          }}
        />
      </Stack>

      {connection.lastError && connection.status !== 'connected' && (
        <Typography level="body-sm" color="danger" sx={{ mt: '8px' }} data-testid={`${testId}-error`}>
          {connection.lastError.message}
        </Typography>
      )}
      {blocked && (
        <Typography level="body-sm" sx={{ mt: '8px', color: 'text.secondary' }}>
          Your organization&apos;s connector policy does not allow this server.
        </Typography>
      )}

      <Stack direction="row" gap="8px" flexWrap="wrap" sx={{ mt: '10px' }}>
        {!blocked && needsSignIn(connection) && (
          <Button
            size="sm"
            loading={startOAuth.isPending}
            disabled={busy}
            onClick={() => signIn()}
            data-testid={`${testId}-sign-in-btn`}
          >
            {connection.status === 'needs_reconnect' ? 'Reconnect' : 'Sign in'}
          </Button>
        )}
        {!blocked && connection.status === 'connected' && connection.tools.length > 0 && (
          <Button
            size="sm"
            variant={pending > 0 ? 'solid' : 'outlined'}
            color={pending > 0 ? 'primary' : 'neutral'}
            disabled={busy}
            onClick={() => {
              setReviewConnection(null);
              setPanel(panel === 'review' ? 'none' : 'review');
            }}
            data-testid={`${testId}-review-btn`}
          >
            Review tools
          </Button>
        )}
        {!blocked && connection.status !== 'pending_auth' && (
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            loading={refresh.isPending}
            disabled={busy || panel === 'review'}
            onClick={refreshTools}
            data-testid={`${testId}-refresh-btn`}
          >
            Refresh tools
          </Button>
        )}
        {!blocked && connection.auth.kind === 'api_key' && (
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            disabled={busy}
            onClick={() => setPanel(panel === 'api-key' ? 'none' : 'api-key')}
            data-testid={`${testId}-api-key-btn`}
          >
            Replace API key
          </Button>
        )}
        <Button
          size="sm"
          variant="plain"
          color="danger"
          loading={remove.isPending}
          disabled={busy}
          onClick={deleteConnection}
          data-testid={`${testId}-delete-btn`}
        >
          Remove
        </Button>
      </Stack>

      {panel === 'review' && (
        <Box sx={{ mt: '12px' }}>
          <McpToolReview connection={reviewConnection ?? connection} onDone={() => setPanel('none')} />
        </Box>
      )}

      {panel === 'api-key' && (
        <Stack direction="row" gap="8px" sx={{ mt: '12px' }}>
          <Input
            size="sm"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={event => setApiKey(event.target.value)}
            placeholder={connection.auth.apiKey ? `Replaces the key ending ${connection.auth.apiKey.last4}` : 'API key'}
            slotProps={{ input: { 'aria-label': 'New API key', 'data-testid': `${testId}-api-key-input` } }}
            sx={{ flex: 1 }}
          />
          <Button
            size="sm"
            loading={rotate.isPending}
            disabled={!apiKey.trim()}
            onClick={saveApiKey}
            data-testid={`${testId}-api-key-save-btn`}
          >
            Save key
          </Button>
        </Stack>
      )}

      {panel === 'client' && (
        <Stack gap="8px" sx={{ mt: '12px' }}>
          <Input
            size="sm"
            value={clientId}
            onChange={event => setClientId(event.target.value)}
            placeholder="Client id"
            slotProps={{ input: { 'aria-label': 'Client id', 'data-testid': `${testId}-client-id-input` } }}
          />
          <Input
            size="sm"
            type="password"
            autoComplete="off"
            value={clientSecret}
            onChange={event => setClientSecret(event.target.value)}
            placeholder="Client secret (if the provider issued one)"
            slotProps={{ input: { 'aria-label': 'Client secret', 'data-testid': `${testId}-client-secret-input` } }}
          />
          <Box>
            <Button
              size="sm"
              loading={startOAuth.isPending}
              disabled={!clientId.trim()}
              onClick={() => signIn({ clientId: clientId.trim(), clientSecret: clientSecret || undefined })}
              data-testid={`${testId}-client-sign-in-btn`}
            >
              Sign in
            </Button>
          </Box>
        </Stack>
      )}
    </Box>
  );
};

export default McpConnectionItem;
