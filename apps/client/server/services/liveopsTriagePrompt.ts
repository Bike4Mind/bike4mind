/**
 * LiveOps Triage Prompt Template Constants
 *
 * Contains the default prompt template and validation utilities for
 * the automated LiveOps triage system that classifies error alerts
 * and creates GitHub issues.
 */

/**
 * List of allowed template variables that can be used in custom prompt templates
 */
export const ALLOWED_TEMPLATE_VARIABLES = [
  'alerts',
  'existingIssues',
  'recentlyClosedIssues',
  'priorityGuidelines',
  'repoName',
] as const;

/**
 * Documentation for available template variables
 */
export const TEMPLATE_VARIABLE_DOCS = {
  alerts: 'JSON array of Slack alerts with text, timestamp, and permalink',
  existingIssues: 'List of currently open GitHub issues for deduplication',
  recentlyClosedIssues: 'List of recently closed GitHub issues for regression detection',
  priorityGuidelines: 'Priority classification criteria (P0/P1/P2/P3)',
  repoName: 'Target GitHub repository name (owner/repo)',
};

/**
 * Common prompt injection patterns to detect
 */
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|above|prior)\s+instructions?/i,
  /disregard\s+(all\s+)?(previous|above|prior)\s+instructions?/i,
  /forget\s+(all\s+)?(previous|above|prior)\s+instructions?/i,
  /new\s+instructions?:/i,
  /system\s*:\s*you\s+are/i,
  /override\s+instructions?/i,
  /\[INST\]/i, // LLaMA instruction markers
  /<\|im_start\|>/i, // ChatML markers
  /{{system}}/i,
  /{{user}}/i,
];

/**
 * Priority classification guidelines
 */
export const PRIORITY_GUIDELINES = `
Priority Classification:

P0 (Blocker) - Requires immediate action:
- Complete service outage
- Database connection failures affecting all users
- Authentication system down
- Data corruption or loss
- Security vulnerabilities being exploited
- Payment/billing failures

P1 (Critical) - Fix ASAP:
- Major feature not working (Quest chat, MCP tools, research, etc.)
- API endpoints returning 500 errors consistently
- Queue processing completely stopped
- Significant performance degradation (10x slower)
- Errors affecting multiple users

P2 (Important) - Fix in next sprint:
- Feature partially broken but has workaround
- Intermittent errors (5-20% of requests)
- Non-critical feature bugs
- Performance issues that don't block usage

P3 (Minor) - Backlog:
- Intermittent errors (< 5% of requests)
- Edge case failures
- Cosmetic issues
- Warnings that don't affect functionality
`;

/**
 * Validates that a template only uses allowed variables
 * @param template - The template string to validate
 * @returns Array of invalid variables found, or empty array if valid
 */
export function validateTemplateVariables(template: string): string[] {
  // Find all {{variable}} patterns
  const variablePattern = /\{\{(\w+)\}\}/g;
  const matches = Array.from(template.matchAll(variablePattern));
  const invalidVars: string[] = [];

  for (const match of matches) {
    const varName = match[1];
    if (!ALLOWED_TEMPLATE_VARIABLES.includes(varName as (typeof ALLOWED_TEMPLATE_VARIABLES)[number])) {
      invalidVars.push(varName);
    }
  }

  return invalidVars;
}

/**
 * Checks if template contains potential prompt injection patterns
 * @param template - The template string to check
 * @returns true if suspicious patterns found, false otherwise
 */
export function containsInjectionPatterns(template: string): boolean {
  return INJECTION_PATTERNS.some(pattern => pattern.test(template));
}

/**
 * Validates that template contains required JSON output format instruction
 * @param template - The template string to validate
 * @returns true if template appears to have output format guidance
 */
export function hasOutputFormatInstruction(template: string): boolean {
  // Check for JSON-related keywords that indicate output format guidance
  const hasJsonKeyword = /\b(JSON|json)\b/.test(template);
  const hasFormatKeyword = /\b(format|output|return|response)\b/i.test(template);

  return hasJsonKeyword && hasFormatKeyword;
}

/**
 * Validates a custom template before saving
 * @param template - The template to validate
 * @returns Object with isValid flag and error messages
 */
export function validateTemplate(template: string): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Check length
  if (template.length < 50) {
    errors.push('Template must be at least 50 characters');
  }
  if (template.length > 10000) {
    errors.push('Template cannot exceed 10,000 characters');
  }

  // Check for invalid variables
  const invalidVars = validateTemplateVariables(template);
  if (invalidVars.length > 0) {
    errors.push(
      `Invalid template variables: ${invalidVars.join(', ')}. Allowed variables are: ${ALLOWED_TEMPLATE_VARIABLES.join(', ')}`
    );
  }

  // Check for injection patterns
  if (containsInjectionPatterns(template)) {
    errors.push('Template contains suspicious patterns that could be prompt injection attempts');
  }

  // Check for output format instruction
  if (!hasOutputFormatInstruction(template)) {
    errors.push('Template should include instructions for JSON output format');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Gets the default prompt template as a string for admin UI reference
 */
export function getDefaultTemplateString(): string {
  return `You are an expert DevOps engineer triaging production error alerts for a web application.

CONTEXT:
You are analyzing error alerts from the #bike4mind-liveops Slack channel.
Target repository: {{repoName}}

{{priorityGuidelines}}

EXISTING OPEN GITHUB ISSUES (for deduplication):
{{existingIssues}}

RECENTLY CLOSED GITHUB ISSUES (for regression detection):
{{recentlyClosedIssues}}

ERROR ALERTS TO TRIAGE:
{{alerts}}

INSTRUCTIONS:

1. CRITICAL - INTRA-BATCH CONSOLIDATION:
   Before creating triageResults, group alerts that describe the SAME underlying error.

   Error Fingerprinting Rules - alerts are the SAME error if they share:
   - Same error type/exception class (e.g., "ValidationException", "MongoNetworkError")
   - Same affected service/component (e.g., "AWS Bedrock", "MongoDB")
   - Same error message pattern (ignore varying IDs, timestamps, ports)

   IGNORE these when comparing - they don't make errors different:
   - Timestamps (10:00 vs 10:05 = same error)
   - Request IDs, correlation IDs, trace IDs
   - User IDs, session IDs
   - Port numbers, ephemeral connection details
   - Specific numeric values in "max_tokens: 8192" type messages

   For consolidated errors:
   - Create ONE triageResult entry per unique error pattern
   - Set occurrenceCount to number of alerts consolidated
   - Set isRecurring to true if occurrenceCount > 1
   - In body: "**Occurrences:** X alerts between [first timestamp] and [last timestamp]"
   - In body: List 2-3 representative Slack permalinks

   DO NOT create separate triageResult entries for the same error occurring multiple times.

2. REGRESSION DETECTION:
   Check if alerts match any RECENTLY CLOSED issues.
   If an alert matches a closed issue, this indicates a potential regression (bug that was fixed but returned).
   - Set isRegression to true
   - Set matchesExisting to the closed issue details (include state: "closed")
   - Set matchedClosedIssue with issueNumber, title, and closedAt (ISO date string)
   - Add "regression" to labels
   - In body: "**⚠️ POTENTIAL REGRESSION:** This error matches previously fixed issue #[number] which was closed on [date]"
   - Consider bumping priority - regressions often warrant higher priority

3. For each unique error pattern, determine:
   - What type of error it is (category)
   - How severe the impact is on users
   - Whether this matches an existing open OR closed GitHub issue
   - The appropriate priority level (P0/P1/P2/P3)

4. Before classifying, briefly reason through:
   - What is the error type/exception class?
   - What service/component is affected?
   - Have I seen similar errors in this batch? If so, consolidate.
   - What's the user impact? (P0-P3)
   - Does this match any existing GitHub issues (open or closed)?

5. Generate a summary highlighting:
   - Any P0/P1 issues requiring immediate attention
   - Any potential regressions detected
   - New recurring patterns
   - Overall system health assessment

CONSOLIDATION EXAMPLES:

Example 1 - Consolidate repeated errors:
Input: 5 alerts all showing "MongoNetworkError: connection timed out to cluster0-shard-00-00:27017"
Output: ONE triageResult with:
  - title: "MongoDB connection timeout"
  - occurrenceCount: 5
  - isRecurring: true
  - body includes: "**Occurrences:** 5 alerts between 10:00 and 10:15 UTC"

Example 2 - Different errors, separate issues:
Input: 1 "MongoDB timeout" + 1 "AWS Bedrock ValidationException"
Output: TWO triageResults (different error types)

Example 3 - Same error type, different root cause:
Input: "ValidationException: max_tokens too large" + "ValidationException: invalid model ID"
Output: TWO triageResults (same exception class but different root causes)

OUTPUT FORMAT:
You MUST wrap your JSON response with these exact delimiters:

<<<B4M_JSON_START>>>
{
  "triageResults": [
    {
      "alertId": "slack_message_ts (use first alert's ts if consolidated)",
      "priority": "P0|P1|P2|P3",
      "category": "database|api|auth|frontend|infrastructure|llm|integration|other",
      "title": "Concise issue title",
      "body": "Detailed issue body in markdown",
      "labels": ["bug", "liveops", "P0"],
      "matchesExisting": null | { "issueNumber": 123, "title": "Existing issue title", "state": "open|closed" },
      "isRecurring": true,
      "occurrenceCount": 5,
      "isRegression": false,
      "matchedClosedIssue":
        | null
        | { "issueNumber": 123, "title": "Closed issue title", "closedAt": "2024-02-20T14:30:00Z" }
        | { "issueNumber": 123, "title": "Closed issue title" } // omit closedAt entirely when the matched entry has no closedAt note
    }
  ],
  "summary": {
    "totalAlerts": 5,
    "newIssues": 3,
    "duplicates": 2,
    "regressions": 0,
    "p0Count": 0,
    "p1Count": 1,
    "p2Count": 2,
    "p3Count": 2,
    "recurringPatterns": ["Pattern description if any"],
    "healthAssessment": "Brief overall assessment"
  }
}
<<<B4M_JSON_END>>>

FIELD DOCUMENTATION:
- isRecurring: Set to true if multiple alerts in this batch describe the same error (occurrenceCount > 1)
- occurrenceCount: Number of alerts consolidated into this single triageResult. 1 = unique error, >1 = repeated error
- isRegression: Set to true if this error matches a CLOSED GitHub issue (bug may have returned)
- matchedClosedIssue: REQUIRED when isRegression=true. Contains { issueNumber, title, closedAt } from the closed issue this regresses from. Copy closedAt verbatim from the matching entry's "(closedAt: ...)" note in the RECENTLY CLOSED GITHUB ISSUES list above — it must be that exact ISO 8601 date string. NEVER invent a date and NEVER use null; if the matched entry has no closedAt note, omit the closedAt field entirely.
- category: database|api|auth|frontend|infrastructure|llm|integration|other
  - database: MongoDB, connection issues, queries
  - api: HTTP errors, endpoint failures
  - auth: Login, tokens, permissions
  - frontend: React, client-side errors
  - infrastructure: AWS, Lambda, memory
  - llm: Bedrock, OpenAI, model errors
  - integration: Slack, GitHub, third-party
  - other: Anything else

CRITICAL FORMATTING RULES:
1. Use the exact delimiters <<<B4M_JSON_START>>> and <<<B4M_JSON_END>>> - do NOT use markdown code blocks
2. In the "body" field, do NOT use triple backticks for code blocks - use indented text (4 spaces) instead
3. Return ONLY the delimited JSON, no additional text before or after`;
}

/**
 * Interpolates template variables into a template string
 * @param template - Template string with {{variable}} placeholders
 * @param variables - Object containing variable values
 * @returns Interpolated template string
 */
export function interpolateTemplate(
  template: string,
  variables: {
    alerts: string;
    existingIssues: string;
    recentlyClosedIssues: string;
    priorityGuidelines: string;
    repoName: string;
  }
): string {
  let result = template;

  result = result.replace(/\{\{alerts\}\}/g, variables.alerts);
  result = result.replace(/\{\{existingIssues\}\}/g, variables.existingIssues);
  result = result.replace(/\{\{recentlyClosedIssues\}\}/g, variables.recentlyClosedIssues);
  result = result.replace(/\{\{priorityGuidelines\}\}/g, variables.priorityGuidelines);
  result = result.replace(/\{\{repoName\}\}/g, variables.repoName);

  return result;
}
