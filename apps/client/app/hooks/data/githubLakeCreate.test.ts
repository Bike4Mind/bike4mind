import { beforeEach, describe, expect, it, vi } from 'vitest';
import { beginGitHubLakeCreate, GITHUB_LAKE_CREATE_PATH } from './githubLakeCreate';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: vi.fn() } }));

import { api } from '@client/app/contexts/ApiContext';

describe('beginGitHubLakeCreate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('posts the organization and unwraps the response', async () => {
    const payload = { dataLakeId: 'lake-1', authorizeUrl: 'https://github.test/authorize' };
    vi.mocked(api.post).mockResolvedValue({ data: payload });

    await expect(beginGitHubLakeCreate('org-1')).resolves.toEqual(payload);
    expect(api.post).toHaveBeenCalledWith(GITHUB_LAKE_CREATE_PATH, { organizationId: 'org-1' });
  });

  it('propagates transport failures', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('Network error'));

    await expect(beginGitHubLakeCreate('org-1')).rejects.toThrow('Network error');
  });
});
