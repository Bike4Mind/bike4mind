// Everything here is copied to the clipboard, so it must never embed a real key:
// the key is always referenced as the B4M_API_KEY environment variable.

// `@latest` because an older globally installed CLI shadows a bare package name
// under npx, and releases before `mcp serve` existed fail with an unknown command.
const MCP_PACKAGE = '@bike4mind/cli@latest';
const MCP_SERVER_NAME = 'bike4mind';

export const buildAgentPrompt = (origin: string): string =>
  [
    `You are connecting to Bike4Mind at ${origin}.`,
    `1. Read ${origin}/llms.txt first. It indexes the API, the MCP server and the agent onboarding quest.`,
    `2. HTTP API: the OpenAPI 3.1 contract is ${origin}/api/v1/openapi.json (readable reference at ${origin}/api/v1/docs). Send the key in the X-API-Key header, read from the environment variable B4M_API_KEY.`,
    `3. MCP: run \`npx -y ${MCP_PACKAGE} mcp serve\` with B4M_API_KEY set, and B4M_API_URL=${origin}.`,
    `4. Never ask me to paste the key into this chat, and never print it. If B4M_API_KEY is unset, tell me to create a key at ${origin} under Profile > API, with the narrowest scopes the task needs.`,
    '5. Some routes are not in the contract yet. If one you need is missing, say so. Do not guess its shape.',
  ].join('\n');

// Single-quoted so the shell leaves `${B4M_API_KEY}` alone; `--scope project` writes
// it to .mcp.json, where Claude Code expands it at launch. The trailing `--scope`
// also keeps the server name from being parsed as another `--env` pair.
export const buildClaudeCodeCommand = (origin: string): string =>
  `claude mcp add --env 'B4M_API_KEY=\${B4M_API_KEY}' --env B4M_API_URL=${origin} --transport stdio --scope project ${MCP_SERVER_NAME} -- npx -y ${MCP_PACKAGE} mcp serve`;

// Codex does not inherit the parent environment and `codex mcp add` has no flag to
// forward a variable by name, so the key is forwarded via `env_vars` in config.toml.
export const buildCodexCommand = (origin: string): string =>
  `codex mcp add ${MCP_SERVER_NAME} --env B4M_API_URL=${origin} -- npx -y ${MCP_PACKAGE} mcp serve`;

export const CODEX_ENV_VARS_LINE = `env_vars = ["B4M_API_KEY"]`;

export const buildCursorInstallLink = (origin: string): string => {
  const config = {
    type: 'stdio',
    command: 'npx',
    args: ['-y', MCP_PACKAGE, 'mcp', 'serve'],
    env: { B4M_API_KEY: '${env:B4M_API_KEY}', B4M_API_URL: origin },
  };
  // btoa is safe here: origins are ASCII (IDNs arrive punycoded).
  const encoded = btoa(JSON.stringify(config));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${MCP_SERVER_NAME}&config=${encodeURIComponent(encoded)}`;
};
