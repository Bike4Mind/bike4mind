/**
 * Skill body argument substitution. Shared by the server-side SkillsFeature,
 * the LLM `skill` tool, and the CLI's skill executor so the same patterns
 * resolve identically across surfaces.
 *
 * Supports Claude Code's substitution syntax:
 *   - `$ARGUMENTS` - all positional args joined by spaces
 *   - `$1`, `$2`, ... - individual positional args
 *
 * Why a shared helper: the CLI already implemented this in
 * `packages/cli/src/utils/argumentSubstitution.ts`. Centralizing here avoids a
 * second drift surface - a skill body authored on the web and run in the CLI
 * (or vice versa) must expand identically.
 */

export function substituteArguments(template: string, args: string[]): string {
  let result = template;

  // Substitute positional args in reverse so `$1` doesn't consume part of `$10`.
  for (let i = args.length; i >= 1; i--) {
    const pattern = new RegExp(`\\$${i}`, 'g');
    result = result.replace(pattern, args[i - 1] ?? '');
  }

  return result.replace(/\$ARGUMENTS/g, args.join(' '));
}

/**
 * Shell-style argument splitter - supports double / single quotes for
 * grouping. Identical semantics to the CLI's `parseArguments`.
 *
 *   parseSkillArguments('hello world')               => ['hello', 'world']
 *   parseSkillArguments('"hello world" test')        => ['hello world', 'test']
 *   parseSkillArguments("'one two' three")           => ['one two', 'three']
 *   parseSkillArguments('')                          => []
 *
 * Unclosed quotes are forgiven, not flagged: `parseSkillArguments('"unclosed')`
 * returns `['unclosed']`. This matches the CLI's pre-existing behavior and is
 * deliberate - skills are user-authored prose, not a shell, and surfacing a
 * parse error for a stray `"` would punish a typo more than the cost of a
 * slightly-wrong split warrants.
 */
export function parseSkillArguments(input: string): string[] {
  if (!input) return [];

  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (!inQuotes && (char === '"' || char === "'")) {
      inQuotes = true;
      quoteChar = char;
    } else if (inQuotes && char === quoteChar) {
      inQuotes = false;
      quoteChar = '';
    } else if (!inQuotes && /\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current.length > 0) args.push(current);
  return args;
}
