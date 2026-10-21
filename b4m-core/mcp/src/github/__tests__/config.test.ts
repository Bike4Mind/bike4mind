import { describe, it, expect, vi, afterEach } from 'vitest';
import { isRepositoryInScope } from '../repoScope.js';

async function loadConfig(selection: string | undefined) {
  vi.resetModules();
  vi.stubEnv('GITHUB_ACCESS_TOKEN', 'gho_token');
  if (selection !== undefined) vi.stubEnv('GITHUB_SELECTED_REPOSITORIES', selection);
  return import('../config.js');
}

describe('GitHub MCP config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds the repository scope from GITHUB_SELECTED_REPOSITORIES', async () => {
    const { repoScope } = await loadConfig(JSON.stringify(['acme/widgets']));

    expect(repoScope.mode).toBe('selected');
    expect(isRepositoryInScope(repoScope, 'acme/widgets')).toBe(true);
    expect(isRepositoryInScope(repoScope, 'other/secret')).toBe(false);
  });

  it('leaves every repository available when no selection is passed', async () => {
    vi.stubEnv('GITHUB_SELECTED_REPOSITORIES', undefined);
    const { repoScope } = await loadConfig(undefined);

    expect(repoScope.mode).toBe('all');
  });
});
