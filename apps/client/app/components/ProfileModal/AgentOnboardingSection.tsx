import { Box, Button, IconButton, Link, Stack, Tooltip, Typography } from '@mui/joy';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import { useCopyToClipboard } from '@client/app/hooks/useCopyToClipboard';
import SectionContainer from './SectionContainer';
import {
  CODEX_ENV_VARS_LINE,
  buildAgentPrompt,
  buildClaudeCodeCommand,
  buildCodexCommand,
  buildCursorInstallLink,
} from './agentOnboarding';

const CopyableSnippet = ({ label, text, testId }: { label: string; text: string; testId: string }) => {
  const { copied, handleCopyToClipboard } = useCopyToClipboard({ showToast: true });

  return (
    <Stack spacing={0.5}>
      <Typography level="title-sm">{label}</Typography>
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <Box
          component="pre"
          data-testid={`${testId}-snippet`}
          sx={{
            flex: 1,
            minWidth: 0,
            m: 0,
            p: 1,
            borderRadius: 'sm',
            bgcolor: 'background.level1',
            fontFamily: 'code',
            fontSize: 'xs',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {text}
        </Box>
        <Tooltip title={copied ? 'Copied' : `Copy ${label}`}>
          <IconButton
            size="sm"
            variant="outlined"
            aria-label={`Copy ${label}`}
            data-testid={`${testId}-copy-btn`}
            onClick={() => handleCopyToClipboard(text)}
          >
            {copied ? <CheckIcon /> : <ContentCopyIcon />}
          </IconButton>
        </Tooltip>
      </Stack>
    </Stack>
  );
};

const AgentOnboardingSection = () => {
  const origin = window.location.origin;
  const { copied, handleCopyToClipboard } = useCopyToClipboard({ showToast: true });
  const cursorLink = buildCursorInstallLink(origin);

  return (
    <SectionContainer
      title="Use Bike4Mind from an AI agent"
      subtitle="Hand this workspace to a coding agent. Nothing below contains a key: export one you created above as B4M_API_KEY in the agent's environment, and never paste it into a chat."
    >
      <Stack spacing={2} data-testid="agent-onboarding-card">
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Button
            startDecorator={copied ? <CheckIcon /> : <ContentCopyIcon />}
            onClick={() => handleCopyToClipboard(buildAgentPrompt(origin))}
            data-testid="agent-onboarding-copy-prompt-btn"
          >
            Copy agent prompt
          </Button>
          <Typography level="body-sm">
            Points the agent at <Link href={`${origin}/llms.txt`}>llms.txt</Link>, the{' '}
            <Link href={`${origin}/api/v1/openapi.json`}>OpenAPI contract</Link> and the{' '}
            <Link href={`${origin}/api/v1/docs`}>API reference</Link>.
          </Typography>
        </Stack>

        <Typography level="title-sm">MCP server setup</Typography>

        <CopyableSnippet
          label="Claude Code command"
          text={buildClaudeCodeCommand(origin)}
          testId="agent-onboarding-claude-code"
        />

        <CopyableSnippet label="Codex command" text={buildCodexCommand(origin)} testId="agent-onboarding-codex" />
        <Typography level="body-xs">
          Codex does not pass your shell environment to MCP servers. To forward the key, add this line in{' '}
          <code>~/.codex/config.toml</code> directly below the <code>[mcp_servers.bike4mind]</code> header, above{' '}
          <code>[mcp_servers.bike4mind.env]</code>:
        </Typography>
        <CopyableSnippet label="Codex config line" text={CODEX_ENV_VARS_LINE} testId="agent-onboarding-codex-env" />

        <Stack spacing={0.5}>
          <Button
            component="a"
            href={cursorLink}
            variant="outlined"
            sx={{ alignSelf: 'flex-start' }}
            data-testid="agent-onboarding-cursor-install-link"
          >
            Add to Cursor
          </Button>
          <CopyableSnippet label="Cursor install link" text={cursorLink} testId="agent-onboarding-cursor" />
        </Stack>
      </Stack>
    </SectionContainer>
  );
};

export default AgentOnboardingSection;
