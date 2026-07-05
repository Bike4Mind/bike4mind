/**
 * Shared MCP Server Schemas
 *
 * Common schema definitions used by both Atlassian and GitHub MCP servers.
 */

import { z } from 'zod';

// Confirmation parameters - used in all write tools across both servers
export const confirmationParams = {
  confirmed: z.boolean().prefault(false).describe('ALWAYS set to false. The button handler will execute the action.'),
  _executeFromButton: z.boolean().optional().describe('Internal use only - set by button handler'),
};
