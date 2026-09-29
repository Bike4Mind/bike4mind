import { describe, it, expect } from 'vitest';
import { buildAgentPrompt, buildCursorInstallLink, buildMcpSetupSnippets } from './agentConnectPrompts';

const ORIGIN = 'https://b4m.example.test';
const LIVE_KEY_PREFIX = 'b4m_live_';

const decodeCursorConfig = (link: string): unknown => {
  const config = new URL(link).searchParams.get('config');
  if (!config) throw new Error('Cursor install link has no config param');
  return JSON.parse(atob(config));
};

describe('buildAgentPrompt', () => {
  it("points the agent at this origin's llms.txt, OpenAPI contract and API reference", () => {
    const prompt = buildAgentPrompt(ORIGIN);

    expect(prompt).toContain(`${ORIGIN}/llms.txt`);
    expect(prompt).toContain(`${ORIGIN}/api/v1/openapi.json`);
    expect(prompt).toContain(`${ORIGIN}/api/v1/docs`);
    expect(prompt).toContain(`B4M_API_URL=${ORIGIN}`);
  });

  it('tells the agent to read the key from the environment, never from the chat', () => {
    const prompt = buildAgentPrompt(ORIGIN);

    expect(prompt).toContain('X-API-Key');
    expect(prompt).toContain('B4M_API_KEY');
    expect(prompt).toMatch(/never ask me to paste the key/i);
    expect(prompt).not.toContain(LIVE_KEY_PREFIX);
  });
});

describe('buildMcpSetupSnippets', () => {
  const snippets = buildMcpSetupSnippets(ORIGIN);
  const snippetCode = (id: string) => snippets.find(snippet => snippet.id === id)?.code ?? '';

  it('never carries a key, only the B4M_API_KEY reference', () => {
    for (const { code } of snippets) {
      expect(code).not.toContain(LIVE_KEY_PREFIX);
      expect(code).toContain('B4M_API_KEY');
      expect(code).toContain(ORIGIN);
    }
  });

  // Double quotes would let the shell expand the key into Claude Code's config file on disk.
  it('single-quotes the Claude Code key reference so the shell leaves it unexpanded', () => {
    expect(snippetCode('claude-code')).toContain("-e 'B4M_API_KEY=${B4M_API_KEY}'");
    expect(snippetCode('claude-code')).toContain('-- npx -y @bike4mind/cli@latest mcp serve');
  });

  it('forwards the key to Codex by name rather than by value', () => {
    expect(snippetCode('codex')).toContain('env_vars = ["B4M_API_KEY"]');
  });
});

describe('buildCursorInstallLink', () => {
  it('encodes a server config that interpolates the key from the environment', () => {
    const link = buildCursorInstallLink(ORIGIN);

    expect(link.startsWith('cursor://anysphere.cursor-deeplink/mcp/install?')).toBe(true);
    expect(new URL(link).searchParams.get('name')).toBe('bike4mind');
    expect(decodeCursorConfig(link)).toEqual({
      command: 'npx',
      args: ['-y', '@bike4mind/cli@latest', 'mcp', 'serve'],
      env: { B4M_API_KEY: '${env:B4M_API_KEY}', B4M_API_URL: ORIGIN },
    });
  });
});
