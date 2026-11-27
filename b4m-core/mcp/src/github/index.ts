#!/usr/bin/env node

/**
 * GitHub MCP Server
 *
 * A Model Context Protocol server providing GitHub integration tools.
 * Supports issues, pull requests, repositories, branches, commits, and Projects v2.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerGitHubTools } from './registerTools.js';
import { getRepositoryFromIssueNodeId, getRepositoryFromProjectItemId } from './helpers/whitelist.js';
import { createStderrLogger } from '../shared/stderrLog.js';

const log = createStderrLogger('github');

const server = new McpServer({
  name: 'github-mcp',
  version: '1.0.0',
});

registerGitHubTools(server, {
  fromIssueNodeId: getRepositoryFromIssueNodeId,
  fromProjectItemId: getRepositoryFromProjectItemId,
});

// Start the MCP server
const transport = new StdioServerTransport();
await server.connect(transport);

// Handle graceful shutdown
const shutdown = async () => {
  log.info('shutting down');
  try {
    await server.close();
  } catch (error) {
    log.error('error during shutdown', { error });
  }
  process.exit(0);
};

// Register signal handlers
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

// Handle uncaught errors
process.on('uncaughtException', error => {
  log.error('uncaught exception', { error });
  shutdown();
});

process.on('unhandledRejection', reason => {
  log.error('unhandled rejection', { reason });
  shutdown();
});
