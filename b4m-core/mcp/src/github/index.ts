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
