/**
 * Slack to GitHub Username Mapper
 * Maps Slack User IDs to GitHub usernames for auto-assignment
 */

import { McpServerName } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { getSlackDb } from '../di/registry';

export interface SlackGitHubMapping {
  slackUserId: string;
  githubUsername: string | null;
  userDisplayName?: string;
}

/**
 * Maps a single Slack User ID to GitHub username
 * @param slackUserId - The Slack User ID (e.g., "U09JUQJ2KHC")
 * @returns GitHub username if found, null otherwise
 */
export async function mapSlackUserIdToGithubUsername(slackUserId: string): Promise<SlackGitHubMapping> {
  try {
    const { User, McpServer } = getSlackDb();
    // Find user by Slack User ID
    const user = await (User as any).findOne({ 'slackSettings.slackUserId': slackUserId });

    if (!user) {
      Logger.info(`[slack-github-mapper] No user found for Slack User ID: ${slackUserId}`);
      return {
        slackUserId,
        githubUsername: null,
      };
    }

    Logger.info(`[slack-github-mapper] Found user for Slack ID ${slackUserId}:`, {
      userId: user.id,
      userName: user.name,
    });

    // Find GitHub MCP server for this user
    const githubMcpServer = await (McpServer as any).findOne({
      userId: user.id,
      name: McpServerName.Github,
      enabled: true,
    });

    if (!githubMcpServer || !githubMcpServer.metadata?.githubLogin) {
      Logger.info(`[slack-github-mapper] User ${user.id} does not have GitHub connected`);
      return {
        slackUserId,
        githubUsername: null,
        userDisplayName: user.name,
      };
    }

    Logger.info(`[slack-github-mapper] ✅ Mapped ${slackUserId} → ${githubMcpServer.metadata.githubLogin}`);
    return {
      slackUserId,
      githubUsername: githubMcpServer.metadata.githubLogin,
      userDisplayName: user.name,
    };
  } catch (error) {
    Logger.error(`[slack-github-mapper] Error mapping Slack User ID ${slackUserId}:`, error);
    return {
      slackUserId,
      githubUsername: null,
    };
  }
}

/**
 * Maps multiple Slack User IDs to GitHub usernames in parallel
 * @param slackUserIds - Array of Slack User IDs
 * @returns Array of mappings
 */
export async function mapSlackUserIdsToGithubUsernames(slackUserIds: string[]): Promise<SlackGitHubMapping[]> {
  const uniqueIds = Array.from(new Set(slackUserIds)); // Remove duplicates
  return Promise.all(uniqueIds.map(id => mapSlackUserIdToGithubUsername(id)));
}

/**
 * Extracts Slack User IDs from thread context text
 * Matches patterns like <@U09JUQJ2KHC> or @U09JUQJ2KHC
 * @param text - Thread context text
 * @returns Array of unique Slack User IDs
 */
export function extractSlackUserIdsFromText(text: string): string[] {
  // Match patterns: <@U[A-Z0-9]{10}> or U[A-Z0-9]{10}
  const matches = text.match(/<@(U[A-Z0-9]{10})>|(?:^|[^<@])(U[A-Z0-9]{10})/g);

  if (!matches) return [];

  // Extract the User ID from the matches
  const userIds = matches
    .map(match => {
      const bracketMatch = match.match(/<@(U[A-Z0-9]{10})>/);
      if (bracketMatch) return bracketMatch[1];

      const plainMatch = match.match(/U[A-Z0-9]{10}/);
      return plainMatch ? plainMatch[0] : null;
    })
    .filter((id): id is string => id !== null);

  return Array.from(new Set(userIds)); // Return unique IDs
}

/**
 * Checks if thread context contains "I will" self-assignment patterns
 * @param text - Thread context text
 * @returns true if "I will" patterns found
 */
export function containsSelfAssignmentPattern(text: string): boolean {
  const patterns = [/\bI will\b/i, /\bI'll\b/i, /\bI can\b/i, /\blet me\b/i, /\bI'll take it\b/i, /\bI got this\b/i];

  return patterns.some(pattern => pattern.test(text));
}

/**
 * Builds a mapping context string for the LLM prompt
 * @param mappings - Array of Slack-to-GitHub mappings
 * @param commandSenderMapping - Optional mapping for the command sender
 * @returns Formatted string for LLM prompt, or empty string if no mappings
 */
export function buildMappingContext(mappings: SlackGitHubMapping[], commandSenderMapping?: SlackGitHubMapping): string {
  if (mappings.length === 0 && !commandSenderMapping) return '';

  const lines: string[] = [];

  lines.push('\n📋 SLACK-TO-GITHUB USERNAME MAPPING:');

  // Add command sender info first (most important for "I will handle" cases)
  if (commandSenderMapping && commandSenderMapping.githubUsername) {
    lines.push('\nCommand sender:');
    const displayName = commandSenderMapping.userDisplayName ? ` (${commandSenderMapping.userDisplayName})` : '';
    lines.push(
      `  • Slack <@${commandSenderMapping.slackUserId}>${displayName} → GitHub username: ${commandSenderMapping.githubUsername}`
    );
    lines.push(
      '\n✅ AUTO-ASSIGN RULE: If you see "I will handle this" or "I\'ll take it", assign to: ' +
        commandSenderMapping.githubUsername
    );
  }

  const withGithub = mappings.filter(m => m.githubUsername);
  const withoutGithub = mappings.filter(m => !m.githubUsername);

  if (withGithub.length > 0) {
    lines.push('\nUsers @mentioned in conversation (with GitHub connected):');
    withGithub.forEach(mapping => {
      const displayName = mapping.userDisplayName ? ` (${mapping.userDisplayName})` : '';
      lines.push(`  • Slack <@${mapping.slackUserId}>${displayName} → GitHub username: **${mapping.githubUsername}**`);
    });
    lines.push('\n✅ ASSIGNMENT RULES:');
    lines.push(
      '1. "assign to <@' + withGithub[0].slackUserId + '>" → assign to GitHub user: ' + withGithub[0].githubUsername
    );
    lines.push(
      '2. "<@' + withGithub[0].slackUserId + '> will handle" → assign to GitHub user: ' + withGithub[0].githubUsername
    );
    lines.push('3. Use the EXACT GitHub username from the mapping above (not the Slack ID)');
    lines.push('\nWhen creating/updating GitHub issues:');
    lines.push('1. Use these exact GitHub usernames (without @) in the assignees field');
    lines.push(
      '2. In the issue body, replace Slack User IDs like <@' +
        withGithub[0].slackUserId +
        '> with their name or GitHub username'
    );
  }

  if (withoutGithub.length > 0) {
    lines.push('\nUsers without GitHub connected:');
    withoutGithub.forEach(mapping => {
      const displayName = mapping.userDisplayName ? ` (${mapping.userDisplayName})` : '';
      lines.push(`  • Slack <@${mapping.slackUserId}>${displayName} - No GitHub account connected`);
    });
    lines.push(
      '\n❌ Do NOT assign these users to GitHub issues. Use generic language like "Team member will handle this".'
    );
  }

  // Add critical rule about plain text names
  lines.push('\n⚠️ CRITICAL RULE - PLAIN TEXT NAMES:');
  lines.push('If you see plain text names WITHOUT @mention (e.g., "John will fix" or "Sarah will handle"):');
  lines.push('• Do NOT auto-assign them (we cannot verify their GitHub username)');
  lines.push('• Only auto-assign when: (1) someone is @mentioned, or (2) "I will" (command sender)');
  lines.push('• For plain text names, include them in the issue body but leave assignees empty');

  return lines.join('\n');
}

/**
 * Check if assignee is a plain text name (not a Slack mention)
 */
export function isPlainTextAssignee(assignee: string): boolean {
  // Slack mentions look like <@U09JUQJ2KHC>
  return !assignee.startsWith('<@') && !assignee.match(/^U[A-Z0-9]{10}$/);
}

/**
 * Check if a string looks like a valid GitHub username
 * GitHub usernames: alphanumeric + hyphens, can't start/end with hyphen, max 39 chars
 * Examples: "octocat", "john-doe", "user123"
 * Non-examples: "John Doe" (has space), "-john" (starts with hyphen)
 */
export function looksLikeGithubUsername(text: string): boolean {
  if (!text || text.length > 39) return false;
  // GitHub username: alphanumeric and hyphens, can't start/end with hyphen
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(text) || /^[a-zA-Z0-9]$/.test(text);
}

/**
 * Find users by display name for @mention suggestions
 * @param displayName - Plain text name (e.g., first name or full name)
 * @returns Array of potential matches with their Slack User IDs
 */
export async function findUsersByDisplayName(
  displayName: string
): Promise<Array<{ name: string; slackUserId: string | null }>> {
  try {
    const searchTerm = displayName.trim().toLowerCase();
    if (!searchTerm) return [];

    // Escape regex special characters to prevent injection/errors
    const escapedTerm = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const { User } = getSlackDb();
    // Search users by name (case-insensitive) with Slack linked
    const users = await (User as any)
      .find({
        $or: [
          { name: { $regex: `^${escapedTerm}`, $options: 'i' } }, // Name starts with
          { name: { $regex: `\\b${escapedTerm}\\b`, $options: 'i' } }, // Word boundary match
        ],
        'slackSettings.slackUserId': { $exists: true, $ne: null },
      })
      .limit(5);

    return users.map((u: any) => ({
      name: u.name || 'Unknown',
      slackUserId: u.slackSettings?.slackUserId || null,
    }));
  } catch (error) {
    Logger.error('[slack-github-mapper] Error finding users by name:', error);
    return [];
  }
}

/**
 * Build a clarification message asking user to use @mention
 */
export function buildAssigneeClarificationMessage(
  plainTextName: string,
  matches: Array<{ name: string; slackUserId: string | null }>
): string {
  if (matches.length === 0) {
    return `I couldn't find a user matching "${plainTextName}". Please use an @mention to assign someone.`;
  }

  if (matches.length === 1 && matches[0].slackUserId) {
    return `Did you mean <@${matches[0].slackUserId}>? Please use @mention for assignment:\n\`assign to <@${matches[0].slackUserId}>\``;
  }

  // Multiple matches - list them
  const suggestions = matches
    .filter(m => m.slackUserId)
    .map(m => `• <@${m.slackUserId}> (${m.name})`)
    .join('\n');

  return `I found multiple users matching "${plainTextName}". Please use @mention:\n${suggestions}`;
}
