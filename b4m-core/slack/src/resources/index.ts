/**
 * Resource Integration Layer
 *
 * This module provides a consistent interface for interacting with
 * 3rd party services (GitHub, Jira, Confluence) and internal resources.
 *
 * Benefits:
 * - Easy to add new integrations (Google Calendar, Email, Linear, etc.)
 * - Consistent interface for all resources
 * - Centralized connection status checking
 * - Mockable for testing
 * - Isolates MCP server initialization logic
 */

export * from './BaseResource';
export * from './InternalResource';
export * from './GitHubResource';
export * from './JiraResource';
export * from './ConfluenceResource';
