/**
 * GitHub MCP Server - Tool Registration
 */

import type { McpServer } from './types.js';
import { repoScope } from './config.js';
import { withRepoScope, type RepositoryResolvers } from './repoGuard.js';
import { registerUserTools } from './tools/user.js';
import { registerIssueTools } from './tools/issues.js';
import { registerSearchTools } from './tools/search.js';
import { registerRepoTools } from './tools/repos.js';
import { registerPullTools } from './tools/pulls.js';
import { registerBranchTools } from './tools/branches.js';
import { registerContentsTools } from './tools/contents.js';
import { registerCommitTools } from './tools/commits.js';
import { registerIssueTypeTools } from './tools/issue-types.js';
import { registerProjectTools } from './tools/projects.js';
import { registerLabelTools } from './tools/labels.js';
import { registerMilestoneTools } from './tools/milestones.js';
import { registerWorkflowTools } from './tools/workflows.js';
import { registerReviewTools } from './tools/reviews.js';

/**
 * Registers every GitHub tool through the repository guard, so the user's selection applies to all
 * of them. The scope comes from config rather than a parameter so no caller can register unscoped.
 */
export function registerGitHubTools(server: McpServer, resolvers: RepositoryResolvers): void {
  const guardedServer = withRepoScope(server, repoScope, resolvers);

  registerUserTools(guardedServer);
  registerIssueTools(guardedServer);
  registerSearchTools(guardedServer, repoScope);
  registerRepoTools(guardedServer, repoScope);
  registerPullTools(guardedServer);
  registerBranchTools(guardedServer);
  registerContentsTools(guardedServer);
  registerCommitTools(guardedServer);
  registerIssueTypeTools(guardedServer);
  registerProjectTools(guardedServer);
  registerLabelTools(guardedServer);
  registerMilestoneTools(guardedServer);
  registerWorkflowTools(guardedServer);
  registerReviewTools(guardedServer);
}
