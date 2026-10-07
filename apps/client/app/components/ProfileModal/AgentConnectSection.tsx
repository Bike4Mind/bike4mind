import { useMemo } from 'react';
import { Box, Button, IconButton, Stack, Tooltip, Typography } from '@mui/joy';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import { copyTextWithToast } from '@client/app/utils/copyToClipboard';
import SectionContainer from './SectionContainer';
import { cardSurfaceSx } from './settingsStyles';
import { buildAgentPrompt, buildCursorInstallLink, buildMcpSetupSnippets } from './agentConnectPrompts';

const SnippetBlock = ({ id, label, hint, code }: { id: string; label: string; hint: string; code: string }) => (
  <Stack spacing={0.75} data-testid={`agent-connect-snippet-${id}`}>
    <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
      <Box>
        <Typography level="title-sm">{label}</Typography>
        <Typography level="body-xs">{hint}</Typography>
      </Box>
      <Tooltip title={`Copy ${label} setup`}>
        <IconButton
          size="sm"
          variant="plain"
          aria-label={`Copy ${label} setup`}
          onClick={() => copyTextWithToast(code, `${label} setup copied to clipboard!`)}
          data-testid={`agent-connect-copy-${id}-btn`}
        >
          <ContentCopyIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
    <Box
      component="pre"
      sx={theme => ({
        ...cardSurfaceSx(theme),
        m: 0,
        p: 1.5,
        overflowX: 'auto',
        fontFamily: 'code',
        fontSize: 'xs',
        whiteSpace: 'pre',
      })}
    >
      {code}
    </Box>
  </Stack>
);

/**
 * Hands the API and MCP server to a coding agent. Every copied string references the B4M_API_KEY
 * env var rather than a key, so nothing here can leak one into an agent's chat.
 */
const AgentConnectSection = () => {
  const origin = window.location.origin;
  const agentPrompt = useMemo(() => buildAgentPrompt(origin), [origin]);
  const snippets = useMemo(() => buildMcpSetupSnippets(origin), [origin]);
  const cursorInstallLink = useMemo(() => buildCursorInstallLink(origin), [origin]);

  return (
    <SectionContainer
      title={
        <Stack direction="row" alignItems="center" spacing={1}>
          <SmartToyOutlinedIcon fontSize="small" />
          <Typography level="title-md">Use Bike4Mind from an AI agent</Typography>
        </Stack>
      }
      subtitle="Paste the prompt into Claude Code, Codex, Cursor or any coding agent. It points the agent at the API contract and MCP server, and tells it to read your key from the B4M_API_KEY environment variable - never from the chat."
      action={
        <Button
          size="sm"
          startDecorator={<ContentCopyIcon fontSize="small" />}
          onClick={() => copyTextWithToast(agentPrompt, 'Agent prompt copied to clipboard!')}
          data-testid="agent-connect-copy-prompt-btn"
        >
          Copy agent prompt
        </Button>
      }
    >
      <Stack spacing={2} data-testid="agent-connect-section">
        <Typography level="body-sm">
          To connect the MCP server directly, export <code>B4M_API_KEY</code> in your shell first, then:
        </Typography>
        {snippets.map(snippet => (
          <SnippetBlock key={snippet.id} {...snippet} />
        ))}
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
          <Box>
            <Typography level="title-sm">Cursor</Typography>
            {/* ${env:...} resolves from Cursor's own environment; a Dock-launched app never sees shell exports. */}
            <Typography level="body-xs">
              Opens Cursor and installs the server. Launch Cursor from a shell where <code>B4M_API_KEY</code> is
              exported (e.g. <code>cursor .</code>) so it can read the key.
            </Typography>
          </Box>
          <Button
            size="sm"
            variant="outlined"
            component="a"
            href={cursorInstallLink}
            data-testid="agent-connect-cursor-install-link"
          >
            Add to Cursor
          </Button>
        </Stack>
      </Stack>
    </SectionContainer>
  );
};

export default AgentConnectSection;
