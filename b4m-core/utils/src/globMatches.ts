/**
 * Backtrack-free glob match where `*` is the only wildcard and every other character is a
 * literal. Deliberately not a compiled RegExp: escaping the pattern still leaves `*` live as
 * `.*`, and a chained-`*` pattern (`'*a'.repeat(12) + 'Z'`) then costs the regex engine
 * exponential time - measured at over 120s of blocked event loop against a 40-char subject.
 * This two-pointer walk is O(text * pattern) worst case with no backtracking stack, so a
 * hostile pattern cannot outrun its input.
 *
 * Use this anywhere a user-supplied glob is matched against a name on a request path:
 * lattice rule entity references, agent allowed/denied tool patterns. Reaching for
 * `escapeRegex` instead does NOT close the hole - the whole point of these patterns is that
 * `*` survives escaping.
 *
 * Import from the lightweight subpath (`@bike4mind/utils/globMatches`), NOT the package
 * barrel, which eagerly evaluates `Logger`/embedding-model code.
 *
 * @example
 * globMatches('mcp__github__create_issue', 'mcp__*__create_*') // true
 * globMatches('a.b', 'a.b')  // true  - `.` is a literal here, not "any char"
 * globMatches('axb', 'a.b')  // false - same reason
 */
export function globMatches(text: string, pattern: string): boolean {
  let textIndex = 0;
  let patternIndex = 0;
  let lastStarPattern = -1;
  let lastStarText = 0;

  while (textIndex < text.length) {
    if (patternIndex < pattern.length && pattern[patternIndex] === '*') {
      lastStarPattern = patternIndex++;
      lastStarText = textIndex;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === text[textIndex]) {
      patternIndex++;
      textIndex++;
    } else if (lastStarPattern >= 0) {
      // Let the most recent `*` absorb one more character, then resume just after it.
      patternIndex = lastStarPattern + 1;
      textIndex = ++lastStarText;
    } else {
      return false;
    }
  }

  while (patternIndex < pattern.length && pattern[patternIndex] === '*') patternIndex++;
  return patternIndex === pattern.length;
}
