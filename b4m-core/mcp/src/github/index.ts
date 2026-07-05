#!/usr/bin/env node

/**
 * GitHub MCP Server
 *
 * A Model Context Protocol server providing GitHub integration tools.
 * Supports issues, pull requests, repositories, branches, commits, and Projects v2.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Tool registrations
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

const server = new McpServer({
  name: 'github-mcp',
  version: '1.0.0',
});

// Register all tools
registerUserTools(server);
registerIssueTools(server);
registerSearchTools(server);
registerRepoTools(server);
registerPullTools(server);
registerBranchTools(server);
registerContentsTools(server);
registerCommitTools(server);
registerIssueTypeTools(server);
registerProjectTools(server);
registerLabelTools(server);
registerMilestoneTools(server);
registerWorkflowTools(server);
registerReviewTools(server);

// Start the MCP server
const transport = new StdioServerTransport();
await server.connect(transport);

// Handle graceful shutdown
const shutdown = async () => {
  console.error('GitHub MCP Server shutting down...');
  try {
    await server.close();
  } catch (error) {
    console.error('Error during shutdown:', error);
  }
  process.exit(0);
};

// Register signal handlers
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

// Handle uncaught errors
process.on('uncaughtException', error => {
  console.error('Uncaught exception in GitHub MCP Server:', error);
  shutdown();
});

process.on('unhandledRejection', reason => {
  console.error('Unhandled rejection in GitHub MCP Server:', reason);
  shutdown();
});
