import { EntityMentionSource } from '../types';
import { EntityExtractor, ExtractionResult } from './types';

/**
 * Common words to skip when extracting project mentions (case-insensitive matching can capture these)
 */
const SKIP_PROJECT_KEYS = new Set([
  'AT',
  'IN',
  'ON',
  'TO',
  'OF',
  'BY',
  'IS',
  'IT',
  'OR',
  'AS',
  'AN',
  'A',
  'BE',
  'DO',
  'GO',
  'IF',
  'NO',
  'SO',
  'UP',
  'WE',
  'MY',
  'HE',
  'ME',
  'THE',
  'AND',
  'FOR',
  'ARE',
  'BUT',
  'NOT',
  'YOU',
  'ALL',
  'CAN',
  'HAD',
  'HER',
  'WAS',
  'ONE',
  'OUR',
  'OUT',
  'HAS',
  'HIS',
  'HOW',
  'ITS',
  'MAY',
  'NEW',
  'NOW',
  'OLD',
  'SEE',
  'WAY',
  'WHO',
  'BOY',
  'DID',
  'GET',
  'LET',
]);

const JIRA_PATTERNS = {
  // Jira issue key format: PROJECT-123 (2-10 uppercase letters followed by hyphen and number)
  issueKey: /\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/g,

  // Jira URL patterns
  // https://company.atlassian.net/browse/PROJECT-123
  issueUrl: /https?:\/\/[a-zA-Z0-9_-]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9]{1,9})-(\d+)/gi,

  // https://company.atlassian.net/jira/software/projects/PROJECT/...
  projectUrl:
    /https?:\/\/[a-zA-Z0-9_-]+\.atlassian\.net\/jira\/(?:software|core|servicedesk)\/projects\/([A-Z][A-Z0-9]{1,9})/gi,

  // Project key mentioned in context (e.g., "in the PROJ project")
  projectMention: /(?:project|board)\s+([A-Z][A-Z0-9]{1,9})\b/gi,
};

/**
 * Jira entity extractor using regex patterns
 */
export class JiraExtractor implements EntityExtractor {
  /**
   * Extract Jira entities from text
   */
  extract(text: string, source: EntityMentionSource): ExtractionResult {
    const entities: ExtractionResult['entities'] = [];
    const seenProjects = new Set<string>();
    const seenIssues = new Set<string>();

    // Extract issue URLs
    let match;
    JIRA_PATTERNS.issueUrl.lastIndex = 0;
    while ((match = JIRA_PATTERNS.issueUrl.exec(text)) !== null) {
      const [, projectKey, number] = match;
      const issueKey = `${projectKey.toUpperCase()}-${number}`;
      if (!seenIssues.has(issueKey)) {
        seenIssues.add(issueKey);
        entities.push({
          entity: {
            type: 'jira_issue',
            entity: { key: issueKey },
          },
          source,
        });
        // Also add the project
        const projectKeyUpper = projectKey.toUpperCase();
        if (!seenProjects.has(projectKeyUpper)) {
          seenProjects.add(projectKeyUpper);
          entities.push({
            entity: {
              type: 'jira_project',
              entity: { key: projectKeyUpper },
            },
            source,
          });
        }
      }
    }

    // Extract project URLs
    JIRA_PATTERNS.projectUrl.lastIndex = 0;
    while ((match = JIRA_PATTERNS.projectUrl.exec(text)) !== null) {
      const [, projectKey] = match;
      const projectKeyUpper = projectKey.toUpperCase();
      if (!seenProjects.has(projectKeyUpper)) {
        seenProjects.add(projectKeyUpper);
        entities.push({
          entity: {
            type: 'jira_project',
            entity: { key: projectKeyUpper },
          },
          source,
        });
      }
    }

    // Extract issue keys (PROJECT-123 format)
    JIRA_PATTERNS.issueKey.lastIndex = 0;
    while ((match = JIRA_PATTERNS.issueKey.exec(text)) !== null) {
      const [, projectKey, number] = match;
      // Normalize to uppercase for consistency with URL extraction
      const issueKey = `${projectKey.toUpperCase()}-${number}`;
      if (!seenIssues.has(issueKey)) {
        seenIssues.add(issueKey);
        entities.push({
          entity: {
            type: 'jira_issue',
            entity: { key: issueKey },
          },
          source,
        });
        // Also add the project
        const projectKeyUpper = projectKey.toUpperCase();
        if (!seenProjects.has(projectKeyUpper)) {
          seenProjects.add(projectKeyUpper);
          entities.push({
            entity: {
              type: 'jira_project',
              entity: { key: projectKeyUpper },
            },
            source,
          });
        }
      }
    }

    // Extract project mentions
    JIRA_PATTERNS.projectMention.lastIndex = 0;
    while ((match = JIRA_PATTERNS.projectMention.exec(text)) !== null) {
      const [, projectKey] = match;
      const projectKeyUpper = projectKey.toUpperCase();
      // Skip common words that aren't valid project keys
      if (SKIP_PROJECT_KEYS.has(projectKeyUpper)) {
        continue;
      }
      if (!seenProjects.has(projectKeyUpper)) {
        seenProjects.add(projectKeyUpper);
        entities.push({
          entity: {
            type: 'jira_project',
            entity: { key: projectKeyUpper },
          },
          source,
        });
      }
    }

    return { entities };
  }
}

/**
 * Singleton instance for convenience
 */
export const jiraExtractor = new JiraExtractor();
