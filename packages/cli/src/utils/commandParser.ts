import matter from 'gray-matter';
import { z } from 'zod';
import type { CustomCommand, CustomCommandFrontmatter } from '../storage/types.js';
import { logger } from './Logger.js';

/**
 * Transforms a value that could be a string or array into a string
 * YAML can parse [value] as an array, so we normalize to string
 */
const flexibleString = z
  .union([z.string(), z.array(z.string())])
  .transform(val => (Array.isArray(val) ? val.join(' ') : val))
  .optional();

/**
 * Transforms a value that could be a string or array into an array
 * Handles YAML quirks where single values aren't wrapped in brackets
 */
const flexibleStringArray = z
  .union([z.string(), z.array(z.string())])
  .transform(val => (Array.isArray(val) ? val : [val]))
  .optional();

/**
 * Checks if a YAML value needs quoting
 * Values need quoting if they contain colons and aren't already quoted or structured
 */
function needsQuoting(value: string): boolean {
  const firstChar = value.charAt(0);
  const isProtected = firstChar === '"' || firstChar === "'" || firstChar === '[' || firstChar === '{';
  return value.includes(':') && !isProtected;
}

/**
 * Preprocesses frontmatter content to fix common YAML issues
 * - Quotes values containing colons that aren't already quoted
 * This handles cases like: argument-hint: <optional: title>
 */
function preprocessFrontmatter(content: string): string {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatterMatch) return content;

  const frontmatter = frontmatterMatch[1];
  const processedLines = frontmatter.split('\n').map(line => {
    const trimmedLine = line.trim();

    // Skip empty lines or comments
    if (!trimmedLine || trimmedLine.startsWith('#')) return line;

    // Match key: value pattern
    const match = line.match(/^(\s*)([a-zA-Z-_]+):\s*(.+)$/);
    if (!match) return line;

    const [, indent, key, value] = match;
    const trimmedValue = value.trim();

    if (!needsQuoting(trimmedValue)) return line;

    // Quote the value to prevent YAML parsing issues
    const escapedValue = trimmedValue.replace(/"/g, '\\"');
    return `${indent}${key}: "${escapedValue}"`;
  });

  const processedFrontmatter = processedLines.join('\n');
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---/, `---\n${processedFrontmatter}\n---`);
}

/**
 * Schema for skill lifecycle hooks
 * Hooks are shell commands executed at different points in skill lifecycle
 */
const HooksSchema = z
  .object({
    /** Script to run before skill execution */
    'pre-invoke': z.string().optional(),
    /** Script to run after successful skill execution */
    'post-invoke': z.string().optional(),
    /** Script to run when skill execution fails */
    'on-error': z.string().optional(),
  })
  .optional();

/**
 * Schema for agent configuration
 * Can be a simple string (agent name) or a detailed config object
 */
const AgentConfigSchema = z.union([
  z.string(), // Simple: "explore"
  z.object({
    // Complex config
    type: z.string(), // Agent type name
    thoroughness: z.enum(['quick', 'medium', 'very_thorough']).optional(),
    config: z.record(z.string(), z.unknown()).optional(), // Additional agent-specific config
  }),
]);

/**
 * Valid model values from Claude Code specification
 */
const VALID_MODELS = ['opus', 'sonnet', 'haiku'] as const;

/**
 * Zod schema for custom command frontmatter validation
 * Validates the YAML/JSON frontmatter in command markdown files
 * Uses flexible parsing to handle YAML quirks (e.g., [value] parsed as array)
 *
 * Implements Claude Code frontmatter specification for compatibility.
 */
const FrontmatterSchema = z.object({
  // Display name for the skill (defaults to filename if not specified)
  name: z.string().optional(),
  // Command description
  description: flexibleString,
  'argument-hint': flexibleString,
  // Model override - validated against allowed values (opus, sonnet, haiku)
  model: z.string().optional(),

  // Agent integration fields
  agent: AgentConfigSchema.optional(),
  thoroughness: z.enum(['quick', 'medium', 'very_thorough']).optional(),
  variables: z.record(z.string(), z.string()).optional(),

  // Tool filtering - restrict which tools are available during skill execution
  'allowed-tools': flexibleStringArray,

  // Execution context: 'inline' (default) runs in main context, 'fork' runs in subagent
  context: z.enum(['fork', 'inline']).prefault('inline'),

  // Visibility controls
  /** When true, skill is hidden from AI's auto-loading in system prompt */
  'disable-model-invocation': z.boolean().prefault(false),
  /** When false, skill is hidden from /commands menu but still callable */
  'user-invocable': z.boolean().prefault(true),

  // Lifecycle hooks
  hooks: HooksSchema,
});

const DESCRIPTION_MAX_LENGTH = 100;
const DEFAULT_DESCRIPTION = 'Custom command';

/**
 * Extracts the description from command body if not in frontmatter
 * Uses the first non-empty, non-heading line as the description
 */
function extractDescriptionFromBody(body: string): string {
  const lines = body.trim().split('\n');
  const firstContentLine = lines.find(line => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith('#');
  });

  if (!firstContentLine) {
    return DEFAULT_DESCRIPTION;
  }

  const trimmed = firstContentLine.trim();
  if (trimmed.length <= DESCRIPTION_MAX_LENGTH) {
    return trimmed;
  }
  return trimmed.substring(0, DESCRIPTION_MAX_LENGTH - 3) + '...';
}

/**
 * Parses a custom command markdown file with frontmatter
 *
 * @param fileContent - Raw markdown file content
 * @param filePath - Full path to the command file
 * @param commandName - Command name (derived from filename)
 * @param source - Source location ('global' or 'project')
 * @returns Parsed CustomCommand object
 * @throws Error if parsing fails or validation fails
 */
export function parseCommandFile(
  fileContent: string,
  filePath: string,
  commandName: string,
  source: 'global' | 'project'
): CustomCommand {
  try {
    // Preprocess to fix common YAML issues (unquoted colons, etc.)
    const processedContent = preprocessFrontmatter(fileContent);

    // Parse frontmatter using gray-matter
    const { data: frontmatter, content: body } = matter(processedContent);

    // Validate frontmatter against schema
    const validationResult = FrontmatterSchema.safeParse(frontmatter);

    if (!validationResult.success) {
      // Log warning but continue with empty frontmatter
      logger.warn(
        `Invalid frontmatter in ${filePath}: ${validationResult.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(', ')}`
      );
    }

    const validFrontmatter = (validationResult.success ? validationResult.data : {}) as CustomCommandFrontmatter;

    // Extract description: frontmatter > first line of body > default
    const description = validFrontmatter.description || extractDescriptionFromBody(body);

    // Validate model value against allowed set
    const modelValue = validFrontmatter.model;
    if (modelValue && !VALID_MODELS.includes(modelValue as (typeof VALID_MODELS)[number])) {
      logger.warn(`Invalid model "${modelValue}" in ${filePath}. Valid values: ${VALID_MODELS.join(', ')}`);
    }

    // Warn if agent is specified without context: fork
    if (validFrontmatter.agent && validFrontmatter.context !== 'fork') {
      logger.warn(
        `Skill "${commandName}" has "agent" specified but "context" is not "fork". ` +
          `The agent field is only used when context is "fork". Consider adding "context: fork" to the frontmatter.`
      );
    }

    return {
      name: commandName,
      displayName: validFrontmatter.name,
      description,
      argumentHint: validFrontmatter['argument-hint'],
      model: validFrontmatter.model,
      body: body.trim(),
      source,
      filePath,
      agent: validFrontmatter.agent,
      thoroughness: validFrontmatter.thoroughness,
      variables: validFrontmatter.variables,
      // New Claude Code spec fields
      allowedTools: validFrontmatter['allowed-tools'],
      context: validFrontmatter.context || 'inline',
      disableModelInvocation: validFrontmatter['disable-model-invocation'] || false,
      userInvocable: validFrontmatter['user-invocable'] !== false, // Default true
      hooks: validFrontmatter.hooks,
    };
  } catch (error) {
    throw new Error(
      `Failed to parse command file ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Pattern for valid command names: alphanumeric, hyphens, colons, underscores */
const COMMAND_NAME_PATTERN = /^[a-z0-9-_:]+$/i;

/**
 * Validates that a command name is allowed
 * Command names must not be empty and must match allowed patterns
 *
 * @param name - Command name to validate
 * @returns true if valid, false otherwise
 */
export function isValidCommandName(name: string): boolean {
  return Boolean(name) && COMMAND_NAME_PATTERN.test(name);
}

/**
 * Extracts command name from filename
 * Removes the .md extension and validates the name
 *
 * @param filename - Filename (e.g., "review.md")
 * @returns Command name (e.g., "review") or null if invalid
 */
export function extractCommandName(filename: string): string | null {
  if (!filename.endsWith('.md')) {
    return null;
  }

  const name = filename.slice(0, -3); // Remove .md extension

  if (!isValidCommandName(name)) {
    return null;
  }

  return name;
}
