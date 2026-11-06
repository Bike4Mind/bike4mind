import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Option,
  Radio,
  RadioGroup,
  Select,
  Stack,
  Typography,
} from '@mui/joy';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import {
  MCP_API_KEY_SCHEMES,
  MCP_CONNECTION_TRANSPORTS,
  McpConnectionSlugSchema,
  getMcpPresetUrl,
  mcpApiKeyHeaderNameProblem,
  mcpApiKeyValueProblem,
  type IMcpConnectionPublic,
  type McpApiKeyScheme,
  type McpConnectionTransport,
  type McpPresetId,
} from '@bike4mind/common';
import {
  mcpConnectionErrorMessage,
  useCreateMcpConnection,
  type McpConnectionAuthInput,
} from '@client/app/hooks/data/mcpConnections';

type AuthChoice = McpConnectionAuthInput['kind'];

const AUTH_LABELS: Record<AuthChoice, string> = {
  oauth: 'Sign in with the provider',
  api_key: 'API key',
  none: 'No authentication',
};

const TRANSPORT_LABELS: Record<McpConnectionTransport, string> = {
  auto: 'Detect automatically',
  'streamable-http': 'Streamable HTTP',
  sse: 'Server-sent events (legacy)',
};

/**
 * Adds one connection. For a preset the server address and sign-in method are the catalog's
 * (the server refuses anything else); otherwise the user supplies the URL and picks how to sign in.
 * The server probes the address on create, so the result already says whether it answered.
 */
const AddMcpConnectorForm = ({
  presetId,
  presetName,
  onCreated,
  onCancel,
}: {
  presetId?: McpPresetId;
  presetName?: string;
  onCreated: (connection: IMcpConnectionPublic) => void;
  onCancel?: () => void;
}) => {
  const presetUrl = getMcpPresetUrl(presetId);
  const create = useCreateMcpConnection();
  const [url, setUrl] = useState(presetUrl ?? '');
  const [displayName, setDisplayName] = useState(presetName ?? '');
  const [auth, setAuth] = useState<AuthChoice>(presetUrl ? 'api_key' : 'oauth');
  const [apiKey, setApiKey] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [slug, setSlug] = useState('');
  const [transport, setTransport] = useState<McpConnectionTransport>('auto');
  const [headerName, setHeaderName] = useState('Authorization');
  const [scheme, setScheme] = useState<McpApiKeyScheme>('Bearer');
  const [error, setError] = useState<string | null>(null);

  const slugProblem = slug ? McpConnectionSlugSchema.safeParse(slug).error?.issues[0]?.message : undefined;
  const headerProblem = auth === 'api_key' ? mcpApiKeyHeaderNameProblem(headerName) : null;
  const keyProblem = auth === 'api_key' && apiKey ? mcpApiKeyValueProblem(apiKey) : null;
  const canSubmit =
    url.trim() !== '' &&
    displayName.trim() !== '' &&
    (auth !== 'api_key' || apiKey !== '') &&
    !slugProblem &&
    !headerProblem &&
    !keyProblem;

  const submit = () => {
    setError(null);
    const authInput: McpConnectionAuthInput =
      auth === 'api_key' ? { kind: 'api_key', value: apiKey, headerName, scheme } : { kind: auth };
    create.mutate(
      {
        ...(presetId ? { presetId } : {}),
        url: url.trim(),
        displayName: displayName.trim(),
        ...(slug ? { slug } : {}),
        transport,
        auth: authInput,
      },
      {
        onSuccess: connection => {
          setApiKey('');
          onCreated(connection);
        },
        onError: failure => setError(mcpConnectionErrorMessage(failure, 'Could not add the connector. Try again.')),
      }
    );
  };

  return (
    <Stack
      gap="14px"
      component="form"
      data-testid="custom-mcp-add-form"
      onSubmit={event => {
        event.preventDefault();
        if (canSubmit) submit();
      }}
    >
      {!presetUrl && (
        <Alert
          size="sm"
          color="warning"
          variant="soft"
          startDecorator={<WarningAmberIcon />}
          data-testid="custom-mcp-add-warning"
        >
          Bike4Mind has not reviewed this server. Its tools can read and change data in the account you connect, and
          their descriptions come from the server.
        </Alert>
      )}
      <FormControl required>
        <FormLabel>Name</FormLabel>
        <Input
          size="sm"
          value={displayName}
          onChange={event => setDisplayName(event.target.value)}
          slotProps={{ input: { maxLength: 100, 'data-testid': 'custom-mcp-add-name-input' } }}
        />
      </FormControl>
      <FormControl required>
        <FormLabel>Server URL</FormLabel>
        <Input
          size="sm"
          value={url}
          readOnly={!!presetUrl}
          onChange={event => setUrl(event.target.value)}
          placeholder="https://example.com/mcp"
          slotProps={{ input: { maxLength: 2048, inputMode: 'url', 'data-testid': 'custom-mcp-add-url-input' } }}
        />
      </FormControl>

      {!presetUrl && (
        <FormControl>
          <FormLabel>Authentication</FormLabel>
          <RadioGroup
            value={auth}
            onChange={event => setAuth(event.target.value as AuthChoice)}
            data-testid="custom-mcp-add-auth"
          >
            {(Object.keys(AUTH_LABELS) as AuthChoice[]).map(kind => (
              <Radio
                key={kind}
                value={kind}
                label={AUTH_LABELS[kind]}
                size="sm"
                slotProps={{ input: { 'data-testid': `custom-mcp-add-auth-${kind}` } }}
              />
            ))}
          </RadioGroup>
        </FormControl>
      )}

      {auth === 'api_key' && (
        <FormControl required error={!!keyProblem}>
          <FormLabel>API key</FormLabel>
          <Input
            size="sm"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={event => setApiKey(event.target.value)}
            slotProps={{ input: { 'data-testid': 'custom-mcp-add-api-key-input' } }}
          />
          <FormHelperText>
            {keyProblem ?? 'Stored encrypted. Only its last four characters are shown again.'}
          </FormHelperText>
        </FormControl>
      )}

      {!presetUrl && (
        <Box>
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => setShowAdvanced(open => !open)}
            data-testid="custom-mcp-add-advanced-btn"
            sx={{ px: 0 }}
          >
            {showAdvanced ? 'Hide advanced settings' : 'Advanced settings'}
          </Button>
          {showAdvanced && (
            <Stack gap="12px" sx={{ mt: '8px' }}>
              <FormControl error={!!slugProblem}>
                <FormLabel>Tool prefix</FormLabel>
                <Input
                  size="sm"
                  value={slug}
                  onChange={event => setSlug(event.target.value.trim())}
                  placeholder="Derived from the name"
                  slotProps={{ input: { 'data-testid': 'custom-mcp-add-slug-input' } }}
                />
                <FormHelperText>
                  {slugProblem ?? 'Tools appear to the model as prefix__tool. Lowercase letters, digits and _.'}
                </FormHelperText>
              </FormControl>
              <FormControl>
                <FormLabel>Transport</FormLabel>
                <Select<McpConnectionTransport>
                  size="sm"
                  value={transport}
                  onChange={(_, value) => value && setTransport(value)}
                  slotProps={{ button: { 'data-testid': 'custom-mcp-add-transport' } }}
                >
                  {MCP_CONNECTION_TRANSPORTS.map(value => (
                    <Option key={value} value={value}>
                      {TRANSPORT_LABELS[value]}
                    </Option>
                  ))}
                </Select>
              </FormControl>
              {auth === 'api_key' && (
                <Stack direction="row" gap="8px">
                  <FormControl error={!!headerProblem} sx={{ flex: 1 }}>
                    <FormLabel>Header</FormLabel>
                    <Input
                      size="sm"
                      value={headerName}
                      onChange={event => setHeaderName(event.target.value)}
                      slotProps={{ input: { 'data-testid': 'custom-mcp-add-header-input' } }}
                    />
                    {headerProblem && <FormHelperText>{headerProblem}</FormHelperText>}
                  </FormControl>
                  <FormControl sx={{ flex: 1 }}>
                    <FormLabel>Scheme</FormLabel>
                    <Select<McpApiKeyScheme>
                      size="sm"
                      value={scheme}
                      onChange={(_, value) => value && setScheme(value)}
                      slotProps={{ button: { 'data-testid': 'custom-mcp-add-scheme' } }}
                    >
                      {MCP_API_KEY_SCHEMES.map(value => (
                        <Option key={value} value={value}>
                          {value === 'raw' ? 'Key only' : value}
                        </Option>
                      ))}
                    </Select>
                  </FormControl>
                </Stack>
              )}
            </Stack>
          )}
        </Box>
      )}

      {error && (
        <Typography level="body-sm" color="danger" data-testid="custom-mcp-add-error">
          {error}
        </Typography>
      )}
      <Stack direction="row" gap="8px">
        <Button
          size="sm"
          type="submit"
          loading={create.isPending}
          disabled={!canSubmit}
          data-testid="custom-mcp-add-submit-btn"
        >
          {presetUrl ? `Connect ${presetName ?? ''}`.trim() : 'Check and add'}
        </Button>
        {onCancel && (
          <Button size="sm" variant="plain" color="neutral" onClick={onCancel} data-testid="custom-mcp-add-cancel-btn">
            Cancel
          </Button>
        )}
      </Stack>
    </Stack>
  );
};

export default AddMcpConnectorForm;
