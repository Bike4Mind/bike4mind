#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Tool registrations
import { registerJiraIssueTools } from './tools/jira-issues.js';
import { registerJiraProjectTools } from './tools/jira-projects.js';
import { registerJiraWorkflowTools } from './tools/jira-workflows.js';
import { registerJiraUserTools } from './tools/jira-users.js';
import { registerJiraLinkTools } from './tools/jira-links.js';
import { registerJiraAttachmentTools } from './tools/jira-attachments.js';
import { registerJiraAgileTools } from './tools/jira-agile.js';
import { registerConfluencePageTools } from './tools/confluence-pages.js';
import { registerConfluenceCommentTools } from './tools/confluence-comments.js';
import { registerConfluenceRestrictionTools } from './tools/confluence-restrictions.js';
import { registerConfluenceAttachmentTools } from './tools/confluence-attachments.js';
import { createStderrLogger } from '../shared/stderrLog.js';

const log = createStderrLogger('atlassian');

// ============================================================================
// MCP Server Setup
// ============================================================================

const server = new McpServer({
  name: 'atlassian',
  version: '1.0.0',
  description: 'Unified Atlassian (Jira + Confluence) integration for Lumina MCP server',
});

// Register all tools
registerJiraIssueTools(server);
registerJiraProjectTools(server);
registerJiraWorkflowTools(server);
registerJiraUserTools(server);
registerJiraLinkTools(server);
registerJiraAttachmentTools(server);
registerJiraAgileTools(server);
registerConfluencePageTools(server);
registerConfluenceCommentTools(server);
registerConfluenceRestrictionTools(server);
registerConfluenceAttachmentTools(server);

// ============================================================================
// Server Startup
// ============================================================================

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

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

process.on('uncaughtException', error => {
  log.error('uncaught exception', { error });
  shutdown();
});

process.on('unhandledRejection', reason => {
  log.error('unhandled rejection', { reason });
  shutdown();
});
