#!/usr/bin/env node

/**
 * Notion MCP Server
 *
 * A Model Context Protocol server providing Notion integration tools.
 * Supports search and page creation.
 *
 * Tool categories and counts are defined in constants.ts.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerSearchTools } from './tools/search.js';
import { registerPageTools } from './tools/pages.js';
import { debug } from './logger.js';
import { createStderrLogger } from '../shared/stderrLog.js';

const log = createStderrLogger('notion');

const server = new McpServer({
  name: 'notion',
  version: '1.0.0',
  description: 'Notion integration for Lumina MCP server',
});

registerSearchTools(server);
registerPageTools(server);

const transport = new StdioServerTransport();
debug('starting Notion MCP Server');
await server.connect(transport);
debug('Notion MCP Server connected via stdio');

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
