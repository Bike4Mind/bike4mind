import { useState } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import FormControl from '@mui/joy/FormControl';
import FormHelperText from '@mui/joy/FormHelperText';
import FormLabel from '@mui/joy/FormLabel';
import Input from '@mui/joy/Input';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ChatApprovalAnswer } from '@shared/chat';
import type { McpSecretKey, McpServerRequest } from '@shared/mcp';
import { WarningIcon } from './icons';

type Secrets = NonNullable<ChatApprovalAnswer['secrets']>;

function filled(values: Record<string, string>, keys: readonly McpSecretKey[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = values[key.name];
    if (value) out[key.name] = value;
  }
  return out;
}

/**
 * The card for mcp_add_server and mcp_update_server: the turn is parked on it until the user
 * approves or declines, and no approval mode answers it for them.
 *
 * Everything that decides what runs is shown as main normalized it, never as the model described
 * it: the command and each argument on a line of its own, or the URL. The secret fields are the
 * one place the user types a value; it stays in this component's state until the approve click
 * sends it to main, and unmounting the card - a stop, a new message, leaving the conversation -
 * drops it. There is deliberately no Enter shortcut: starting a program needs a click.
 */
export function McpServerRequestCard({
  request,
  update,
  current,
  warning,
  onApprove,
  onDecline,
}: {
  request: McpServerRequest;
  update: boolean;
  /** On an update, the config being replaced. */
  current?: string;
  /** Set when an argument or the URL looks like it holds a secret. */
  warning?: string;
  onApprove: (secrets: Secrets) => void;
  onDecline: () => void;
}) {
  const [answered, setAnswered] = useState(false);
  const [env, setEnv] = useState<Record<string, string>>({});
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const stdio = request.transport === 'stdio';
  const keys = stdio ? request.env_keys : request.header_keys;
  const values = stdio ? env : headers;
  const setValues = stdio ? setEnv : setHeaders;
  const stored = new Set(request.stored_keys ?? []);

  const approve = () => {
    if (answered) return;
    setAnswered(true);
    onApprove(stdio ? { env: filled(env, request.env_keys) } : { headers: filled(headers, request.header_keys) });
    setEnv({});
    setHeaders({});
  };
  const decline = () => {
    if (answered) return;
    setAnswered(true);
    setEnv({});
    setHeaders({});
    onDecline();
  };

  return (
    <Sheet
      variant="soft"
      color="warning"
      sx={{ borderRadius: 'sm', px: 1.5, py: 1.25, my: 0.5 }}
      data-testid="mcp-request-card"
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          decline();
        }
      }}
    >
      <Typography level="body-sm" fontWeight="lg">
        {update
          ? `The agent wants to change the MCP server "${request.name}":`
          : `The agent wants to add an MCP server named "${request.name}":`}
      </Typography>

      <Alert
        size="sm"
        color="danger"
        variant="soft"
        startDecorator={<WarningIcon />}
        sx={{ mt: 0.75 }}
        data-testid="mcp-request-risk"
      >
        {stdio
          ? 'This runs a third-party program on this computer with your permissions. It can read and change your files and use the network. Only approve a program you trust.'
          : 'This connects the app to a third-party server and sends it the headers below. Only approve a server you trust.'}
      </Alert>

      <Box sx={{ mt: 0.75, p: 1, borderRadius: 'sm', bgcolor: 'background.surface' }} data-testid="mcp-request-command">
        {stdio ? (
          <>
            <Typography level="body-xs" textColor="text.tertiary">
              Command
            </Typography>
            <Typography level="body-sm" fontFamily="monospace" sx={{ overflowWrap: 'anywhere' }}>
              {request.command}
            </Typography>
            {(request.args ?? []).length > 0 && (
              <>
                <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                  Arguments, one per line
                </Typography>
                {(request.args ?? []).map((arg, index) => (
                  <Typography
                    // Arguments repeat (two `-y` flags), so the position is part of the identity.
                    key={`${index}:${arg}`}
                    level="body-sm"
                    fontFamily="monospace"
                    sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}
                    data-testid="mcp-request-arg"
                  >
                    {arg}
                  </Typography>
                ))}
              </>
            )}
          </>
        ) : (
          <>
            <Typography level="body-xs" textColor="text.tertiary">
              URL
            </Typography>
            <Typography level="body-sm" fontFamily="monospace" sx={{ overflowWrap: 'anywhere' }}>
              {request.url}
            </Typography>
          </>
        )}
      </Box>

      {current && (
        <Typography
          level="body-xs"
          textColor="text.tertiary"
          fontFamily="monospace"
          sx={{ mt: 0.5, overflowWrap: 'anywhere' }}
          data-testid="mcp-request-current"
        >
          {current}
        </Typography>
      )}

      {warning && (
        <Typography
          level="body-sm"
          color="danger"
          fontWeight="lg"
          startDecorator={<WarningIcon />}
          sx={{ mt: 0.75 }}
          data-testid="mcp-request-warning"
        >
          {warning}
        </Typography>
      )}

      {keys.length > 0 && (
        <Stack spacing={0.75} sx={{ mt: 1 }}>
          <Typography level="body-xs" textColor="text.secondary">
            {stdio ? 'Environment variables' : 'Headers'}: the values go to your OS keychain and are never shown to the
            agent.
          </Typography>
          {keys.map(key => (
            <FormControl key={key.name} size="sm">
              <FormLabel sx={{ fontFamily: 'monospace' }}>{key.name}</FormLabel>
              <Input
                type="password"
                autoComplete="off"
                disabled={answered}
                value={values[key.name] ?? ''}
                placeholder={stored.has(key.name) ? 'Leave blank to keep the current value' : ''}
                onChange={event => {
                  const next = event.target.value;
                  setValues(previous => ({ ...previous, [key.name]: next }));
                }}
                slotProps={{ input: { 'data-testid': 'mcp-request-secret-input', 'aria-label': key.name } }}
              />
              {key.description && <FormHelperText>{key.description}</FormHelperText>}
            </FormControl>
          ))}
        </Stack>
      )}

      <Typography
        level="body-sm"
        textColor="text.secondary"
        sx={{ mt: 0.75, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
        data-testid="mcp-request-reason"
      >
        {"The agent's reason: "}
        {request.reason}
      </Typography>

      <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          disabled={answered}
          onClick={decline}
          data-testid="mcp-request-decline-btn"
        >
          Decline
        </Button>
        <Button
          size="sm"
          color={warning ? 'danger' : 'warning'}
          disabled={answered}
          onClick={approve}
          data-testid="mcp-request-approve-btn"
        >
          {update ? 'Save and restart' : warning ? 'Add anyway' : 'Add server'}
        </Button>
      </Stack>
    </Sheet>
  );
}
