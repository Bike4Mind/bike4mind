/**
 * Substitutes command arguments into a command template
 * Supports Claude Code's substitution patterns:
 * - $ARGUMENTS: All arguments as a single string
 * - $1, $2, $3, etc.: Individual positional arguments
 *
 * @param template - Command body template with substitution patterns
 * @param args - Array of argument strings
 * @returns Template with arguments substituted
 *
 * @example
 * substituteArguments("Review $1 with priority $2", ["file.ts", "high"])
 * // Returns: "Review file.ts with priority high"
 *
 * @example
 * substituteArguments("Fix issue $ARGUMENTS", ["123", "urgent"])
 * // Returns: "Fix issue 123 urgent"
 */
export function substituteArguments(template: string, args: string[]): string {
  let result = template;

  // First, substitute positional arguments ($1, $2, etc.)
  // We need to handle up to a reasonable number of arguments
  // Process in reverse order to avoid $1 matching $10, $11, etc.
  for (let i = args.length; i >= 1; i--) {
    const pattern = new RegExp(`\\$${i}`, 'g');
    result = result.replace(pattern, args[i - 1] || '');
  }

  // Then substitute $ARGUMENTS with all arguments joined by space
  const allArgsString = args.join(' ');
  result = result.replace(/\$ARGUMENTS/g, allArgsString);

  return result;
}

/**
 * Checks if a template contains any argument substitution patterns
 *
 * @param template - Command body template
 * @returns true if template contains $ARGUMENTS or $N patterns
 */
export function hasArgumentPatterns(template: string): boolean {
  return /\$ARGUMENTS|\$\d+/.test(template);
}

/**
 * Extracts all positional argument patterns from a template
 * Useful for validation and debugging
 *
 * @param template - Command body template
 * @returns Array of unique positional argument numbers found (e.g., [1, 2, 3])
 */
export function extractPositionalArguments(template: string): number[] {
  const matches = template.matchAll(/\$(\d+)/g);
  const positions = new Set<number>();

  for (const match of matches) {
    const position = parseInt(match[1], 10);
    if (!isNaN(position) && position > 0) {
      positions.add(position);
    }
  }

  return Array.from(positions).sort((a, b) => a - b);
}
