import { ExternalLinks } from '@client/app/utils/externalLinks';

// Everything here is copied to the clipboard and pasted into third-party agents, so it must never
// carry a real key: every reference is to the B4M_API_KEY env var. Keep the auth guidance in sync
// with the "Authentication" section of apps/client/public/llms.txt.

const API_KEY_ENV_VAR = 'B4M_API_KEY';
const API_URL_ENV_VAR = 'B4M_API_URL';
// Must stay in sync with ProfileTab.ApiKeys (apps/client/app/routes/profile/index.tsx).
const API_KEYS_PAGE_PATH = '/profile?tab=api-keys';

const MCP_SERVER_NAME = 'bike4mind';
const MCP_COMMAND = 'npx';
// -y skips npx's install prompt, which would otherwise hang a stdio server launched by an MCP client.
// @latest because npx prefers an installed copy of a bare package name, and a CLI older than
// `mcp serve` fails with an unknown command.
const MCP_ARGS = ['-y', '@bike4mind/cli@latest', 'mcp', 'serve'];
const MCP_SERVE_COMMAND = `${MCP_COMMAND} ${MCP_ARGS.join(' ')}`;

export const buildAgentPrompt = (origin: string): string =>
  [
    `You are connecting to Bike4Mind at ${origin}.`,
    `1. Read ${origin}/llms.txt first. It indexes the API, the MCP server and the agent onboarding quest.`,
    `2. HTTP API: the OpenAPI 3.1 contract is ${origin}${ExternalLinks.openApiSpec}, rendered for reading at ${origin}${ExternalLinks.apiDocs}. Send the key as \`Authorization: Bearer $${API_KEY_ENV_VAR}\`, reading it from the environment variable ${API_KEY_ENV_VAR}.`,
    `3. MCP: run \`${MCP_SERVE_COMMAND}\` with ${API_KEY_ENV_VAR} set, and ${API_URL_ENV_VAR}=${origin}.`,
    `4. Never ask me to paste the key into this chat, and never print it. If ${API_KEY_ENV_VAR} is unset, tell me to create a key at ${origin}${API_KEYS_PAGE_PATH} (Profile > API Keys), with the narrowest scopes the task needs.`,
    '5. Some routes are not in the contract yet. If one you need is missing, say so. Do not guess its shape.',
  ].join('\n');

export type McpSetupSnippet = {
  id: 'claude-code' | 'codex';
  label: string;
  hint: string;
  code: string;
};

// Syntax checked against each vendor's MCP docs (Claude Code: code.claude.com/docs/en/mcp,
// Codex: developers.openai.com/codex/mcp, Cursor: cursor.com/docs/mcp/install-links).
export const buildMcpSetupSnippets = (origin: string): McpSetupSnippet[] => [
  {
    id: 'claude-code',
    label: 'Claude Code',
    hint: 'Run in a terminal.',
    // Single quotes keep the shell from expanding the key into the config; Claude Code expands
    // ${B4M_API_KEY} from the environment each time it launches the server.
    code: [
      `claude mcp add ${MCP_SERVER_NAME} --scope user \\`,
      `  -e '${API_KEY_ENV_VAR}=\${${API_KEY_ENV_VAR}}' -e ${API_URL_ENV_VAR}=${origin} \\`,
      `  -- ${MCP_SERVE_COMMAND}`,
    ].join('\n'),
  },
  {
    id: 'codex',
    label: 'Codex',
    hint: 'Add to ~/.codex/config.toml.',
    // `codex mcp add --env` only takes literal values, so the key is forwarded with env_vars instead.
    code: [
      `[mcp_servers.${MCP_SERVER_NAME}]`,
      `command = "${MCP_COMMAND}"`,
      `args = [${MCP_ARGS.map(arg => `"${arg}"`).join(', ')}]`,
      `env = { ${API_URL_ENV_VAR} = "${origin}" }`,
      `env_vars = ["${API_KEY_ENV_VAR}"]`,
    ].join('\n'),
  },
];

export const buildCursorInstallLink = (origin: string): string => {
  const serverConfig = {
    command: MCP_COMMAND,
    args: MCP_ARGS,
    env: { [API_KEY_ENV_VAR]: `\${env:${API_KEY_ENV_VAR}}`, [API_URL_ENV_VAR]: origin },
  };
  const params = new URLSearchParams({ name: MCP_SERVER_NAME, config: btoa(JSON.stringify(serverConfig)) });
  return `cursor://anysphere.cursor-deeplink/mcp/install?${params.toString()}`;
};
