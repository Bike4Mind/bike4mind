import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../client.js', () => ({ octokit: { graphql: vi.fn() } }));

import { octokit } from '../../client.js';
import { GET_REPOSITORY_FROM_PROJECT_ITEM_ID_QUERY } from '../../helpers/queries.js';
import { getRepositoryFromIssueNodeId, getRepositoryFromProjectItemId } from '../../helpers/whitelist.js';

const graphql = vi.mocked(octokit.graphql);

const repository = (owner: string, name: string) => ({ repository: { owner: { login: owner }, name } });

describe('repository lookup helpers', () => {
  beforeEach(() => {
    graphql.mockReset();
  });

  describe('getRepositoryFromProjectItemId', () => {
    it('resolves the repository of a pull request project item', async () => {
      graphql.mockResolvedValueOnce({ node: { content: repository('acme', 'widgets') } } as never);

      await expect(getRepositoryFromProjectItemId('PVTI_1')).resolves.toEqual({
        owner: 'acme',
        repo: 'widgets',
        fullName: 'acme/widgets',
      });
    });

    it('resolves the repository of an issue project item', async () => {
      graphql.mockResolvedValueOnce({ node: { content: repository('acme', 'gadgets') } } as never);

      await expect(getRepositoryFromProjectItemId('PVTI_2')).resolves.toEqual({
        owner: 'acme',
        repo: 'gadgets',
        fullName: 'acme/gadgets',
      });
    });

    it('returns null for a draft item, whose content has no repository', async () => {
      graphql.mockResolvedValueOnce({ node: { content: null } } as never);

      await expect(getRepositoryFromProjectItemId('PVTI_draft')).resolves.toBeNull();
    });

    it('returns null when the query fails', async () => {
      graphql.mockRejectedValueOnce(new Error('graphql unavailable'));

      await expect(getRepositoryFromProjectItemId('PVTI_3')).resolves.toBeNull();
    });

    it('looks up pull request content as well as issue content', () => {
      expect(GET_REPOSITORY_FROM_PROJECT_ITEM_ID_QUERY).toContain('... on PullRequest');
    });
  });

  describe('getRepositoryFromIssueNodeId', () => {
    it('resolves the repository of an issue node', async () => {
      graphql.mockResolvedValueOnce({ node: repository('acme', 'widgets') } as never);

      await expect(getRepositoryFromIssueNodeId('I_1')).resolves.toEqual({
        owner: 'acme',
        repo: 'widgets',
        fullName: 'acme/widgets',
      });
    });

    it('returns null when the node carries no repository', async () => {
      graphql.mockResolvedValueOnce({ node: {} } as never);

      await expect(getRepositoryFromIssueNodeId('I_2')).resolves.toBeNull();
    });

    it('returns null when the query fails', async () => {
      graphql.mockRejectedValueOnce(new Error('graphql unavailable'));

      await expect(getRepositoryFromIssueNodeId('I_3')).resolves.toBeNull();
    });
  });
});
