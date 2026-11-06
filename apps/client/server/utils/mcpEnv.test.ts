import { describe, it, expect, vi } from 'vitest';
import type { IMcpServerDocument } from '@bike4mind/common';

vi.mock('@bike4mind/database', () => ({ userRepository: { findById: vi.fn() } }));
vi.mock('@bike4mind/server-utils/integrations/jira/atlassianTokenManager', () => ({
  AtlassianTokenManager: { getValidTokens: vi.fn() },
  AtlassianReconnectRequiredError: class extends Error {},
}));
// Stored values are encrypted at rest; identity decryption keeps the fixtures readable.
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({
  decryptEnvVariables: (envVariables: unknown) => envVariables,
}));

import { buildMcpEnvVariables } from './mcpEnv';

const TOKEN = { key: 'GITHUB_ACCESS_TOKEN', value: 'gho_token' };

function githubServer(overrides: Partial<IMcpServerDocument> = {}): IMcpServerDocument {
  return { name: 'github', envVariables: [TOKEN], ...overrides } as unknown as IMcpServerDocument;
}

const repository = (fullName: string) => {
  const [owner, repo] = fullName.split('/');
  return { fullName, owner, repo };
};

describe('buildMcpEnvVariables', () => {
  it('passes the GitHub repository selection to the server as a JSON list', async () => {
    const env = await buildMcpEnvVariables(
      githubServer({ metadata: { selectedRepositories: [repository('acme/widgets'), repository('acme/gadgets')] } })
    );

    expect(env).toEqual([
      TOKEN,
      { key: 'GITHUB_SELECTED_REPOSITORIES', value: JSON.stringify(['acme/widgets', 'acme/gadgets']) },
    ]);
  });

  it('omits the selection when none is saved, leaving every repository available', async () => {
    expect(await buildMcpEnvVariables(githubServer({ metadata: { selectedRepositories: [] } }))).toEqual([TOKEN]);
    expect(await buildMcpEnvVariables(githubServer())).toEqual([TOKEN]);
  });

  it('ignores a stored selection variable so metadata stays the only source', async () => {
    const stored = { key: 'GITHUB_SELECTED_REPOSITORIES', value: JSON.stringify(['other/secret']) };

    expect(await buildMcpEnvVariables(githubServer({ envVariables: [TOKEN, stored] }))).toEqual([TOKEN]);

    const env = await buildMcpEnvVariables(
      githubServer({ envVariables: [TOKEN, stored], metadata: { selectedRepositories: [repository('acme/widgets')] } })
    );
    expect(env).toEqual([TOKEN, { key: 'GITHUB_SELECTED_REPOSITORIES', value: JSON.stringify(['acme/widgets']) }]);
  });

  it('leaves other servers untouched', async () => {
    const notionEnv = [{ key: 'NOTION_ACCESS_TOKEN', value: 'secret' }];
    const server = { name: 'notion', envVariables: notionEnv } as unknown as IMcpServerDocument;

    expect(await buildMcpEnvVariables(server)).toEqual(notionEnv);
  });

  it('drops a malformed saved name that the server could not parse', async () => {
    const env = await buildMcpEnvVariables(
      githubServer({ metadata: { selectedRepositories: [repository('acme'), repository('acme/widgets')] } })
    );

    expect(env).toEqual([TOKEN, { key: 'GITHUB_SELECTED_REPOSITORIES', value: JSON.stringify(['acme/widgets']) }]);
  });

  it('restricts to nothing when no saved name is usable, rather than leaving every repository open', async () => {
    const env = await buildMcpEnvVariables(
      githubServer({ metadata: { selectedRepositories: [repository('acme'), repository('a/b/c')] } })
    );

    expect(env).toEqual([TOKEN, { key: 'GITHUB_SELECTED_REPOSITORIES', value: '[]' }]);
  });
});
