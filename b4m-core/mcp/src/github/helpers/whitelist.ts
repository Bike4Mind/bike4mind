/**
 * GitHub MCP Server - Repository Info Helpers
 *
 * Helpers for resolving repository information from GitHub node IDs.
 */

import { octokit } from '../client.js';
import type { RepositoryInfo } from '../types.js';
import { GET_REPOSITORY_FROM_ISSUE_NODE_ID_QUERY, GET_REPOSITORY_FROM_PROJECT_ITEM_ID_QUERY } from './queries.js';

/**
 * Get repository info from an issue node ID using GraphQL
 */
export async function getRepositoryFromIssueNodeId(issueNodeId: string): Promise<RepositoryInfo | null> {
  try {
    interface IssueRepoQueryResult {
      node: {
        repository: {
          owner: { login: string };
          name: string;
        } | null;
      } | null;
    }

    const result = await octokit.graphql<IssueRepoQueryResult>(GET_REPOSITORY_FROM_ISSUE_NODE_ID_QUERY, {
      nodeId: issueNodeId,
    });

    if (result.node?.repository) {
      const owner = result.node.repository.owner.login;
      const repo = result.node.repository.name;
      return { owner, repo, fullName: `${owner}/${repo}` };
    }
    return null;
  } catch (error) {
    console.error('[getRepositoryFromIssueNodeId] Error:', error);
    return null;
  }
}

/**
 * Get repository info from a project item ID using GraphQL
 */
export async function getRepositoryFromProjectItemId(itemId: string): Promise<RepositoryInfo | null> {
  try {
    interface ProjectItemRepoQueryResult {
      node: {
        content: {
          repository: {
            owner: { login: string };
            name: string;
          } | null;
        } | null;
      } | null;
    }

    const result = await octokit.graphql<ProjectItemRepoQueryResult>(GET_REPOSITORY_FROM_PROJECT_ITEM_ID_QUERY, {
      itemId,
    });

    if (result.node?.content?.repository) {
      const owner = result.node.content.repository.owner.login;
      const repo = result.node.content.repository.name;
      return { owner, repo, fullName: `${owner}/${repo}` };
    }
    return null;
  } catch (error) {
    console.error('[getRepositoryFromProjectItemId] Error:', error);
    return null;
  }
}
