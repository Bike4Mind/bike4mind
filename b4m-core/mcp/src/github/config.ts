/**
 * GitHub MCP Server Configuration
 *
 * Handles environment variable parsing and validation for the GitHub MCP server.
 */

// Get GitHub token from environment (OAuth token from database, not .env file)
export const githubToken = process.env.GITHUB_ACCESS_TOKEN;

if (!githubToken) {
  throw new Error('GITHUB_ACCESS_TOKEN environment variable is required');
}
