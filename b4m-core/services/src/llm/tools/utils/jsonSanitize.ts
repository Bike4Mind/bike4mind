/**
 * Sanitize a JSON string by escaping control characters inside string literals.
 * LLMs sometimes return JSON with unescaped newlines/tabs inside string values,
 * which causes JSON.parse to fail with "Bad control character in string literal".
 *
 * Covers all U+0000-U+001F control characters per JSON RFC 8259.
 *
 * Also applies a lookahead heuristic to escape unescaped double-quotes inside
 * string values - the most common LLM JSON failure mode (e.g., code snippets
 * containing logger.error("msg") inside a JSON string).
 *
 * Returns the sanitized string and the number of quotes repaired.
 * If the JSON is already valid, it is returned unchanged (zero repairs).
 */
export function sanitizeJsonString(jsonStr: string): string {
  const { result } = sanitizeJsonStringWithMeta(jsonStr);
  return result;
}

export interface SanitizeResult {
  result: string;
  repairedQuotes: number;
  truncationRepaired?: boolean;
}

export function sanitizeJsonStringWithMeta(
  jsonStr: string,
  options?: { attemptTruncationRepair?: boolean }
): SanitizeResult {
  // Fast path: try JSON.parse first. If valid, return unchanged with no repairs.
  try {
    JSON.parse(jsonStr);
    return { result: jsonStr, repairedQuotes: 0 };
  } catch {
    // Fall through to heuristic repair
  }

  let result = '';
  let inString = false;
  /**
   * Tracks whether we are in a key position (true) or value position (false).
   * Starts as true - the first string in valid JSON must be a key.
   * Flips to false after a key-closing quote + colon pair.
   * Flips back to true after a value-closing quote (or structural char) + comma/`{`/`[`.
   *
   * This is used to disambiguate `:` after a `"` inside a string:
   *   - In key position: `"` + `:` -> structural (closes the key, colon follows)
   *   - In value position: `"` + `:` -> embedded (e.g., `"status": it was null"`)
   */
  let inKey = true;
  /** Tracks nested structure context for truncation repair. */
  const structureStack: Array<'{' | '['> = [];
  let repairedQuotes = 0;
  let i = 0;

  while (i < jsonStr.length) {
    const char = jsonStr[i];

    // Handle escape sequences inside strings - keep them as-is
    if (inString && char === '\\' && i + 1 < jsonStr.length) {
      result += char + jsonStr[i + 1];
      i += 2;
      continue;
    }

    if (char === '"') {
      if (!inString) {
        // Opening a string
        inString = true;
        result += char;
        i++;
        continue;
      }

      // We're inside a string and hit a `"`. Determine if this is structural
      // (closes the string) or embedded (should be escaped).
      //
      // Look ahead past whitespace to find the next non-whitespace character.
      let j = i + 1;
      while (
        j < jsonStr.length &&
        (jsonStr[j] === ' ' || jsonStr[j] === '\t' || jsonStr[j] === '\r' || jsonStr[j] === '\n')
      ) {
        j++;
      }
      const nextNonWs = j < jsonStr.length ? jsonStr[j] : '';

      // Structural closing quote conditions:
      //   - `,` `}` `]`  -> always structural (end of key or value)
      //   - `:`           -> structural ONLY in key position
      //   - end-of-string -> structural
      const isStructural =
        nextNonWs === ',' || nextNonWs === '}' || nextNonWs === ']' || nextNonWs === '' || (nextNonWs === ':' && inKey);

      if (isStructural) {
        // Close the string, update key/value position tracking
        inString = false;
        result += char;
        i++;

        if (nextNonWs === ':') {
          // Closed a key - now entering value position
          inKey = false;
        } else if (nextNonWs === ',' || nextNonWs === '}' || nextNonWs === ']') {
          // Closed a value (or end of array element) - next string is a key
          inKey = true;
        }
        continue;
      }

      // Embedded quote - escape it and stay in string mode
      // Known limitation: adjacent `""` collapses into one long string (acceptable for LLM output)
      result += '\\"';
      repairedQuotes++;
      i++;
      continue;
    }

    // Only escape control characters inside strings
    if (inString) {
      const code = char.charCodeAt(0);
      if (code >= 0x00 && code <= 0x1f) {
        switch (code) {
          case 0x08:
            result += '\\b';
            break; // backspace
          case 0x09:
            result += '\\t';
            break; // tab
          case 0x0a:
            result += '\\n';
            break; // newline
          case 0x0c:
            result += '\\f';
            break; // form feed
          case 0x0d:
            result += '\\r';
            break; // carriage return
          default:
            result += '\\u' + code.toString(16).padStart(4, '0');
            break;
        }
      } else {
        result += char;
      }
    } else {
      result += char;

      // Track key/value position and structure stack based on structural characters
      if (char === '{') {
        structureStack.push('{');
        // After opening brace, next string is a key
        inKey = true;
      } else if (char === '[') {
        structureStack.push('[');
        // After opening bracket, we're in an array - strings here are values (not keys)
        // so `:` inside an array string element is treated as embedded, not structural.
        inKey = false;
      } else if (char === '}' || char === ']') {
        if (structureStack.length > 0) structureStack.pop();
        // After closing a container, restore key/value context based on enclosing scope
        const enclosing = structureStack.length > 0 ? structureStack[structureStack.length - 1] : null;
        inKey = enclosing !== '['; // inside an array after }/] → still value context
      } else if (char === ',') {
        // After a comma inside an object, the next token is always a key.
        // This handles non-string values (numbers, booleans, null) which don't
        // close via the quote handler, leaving inKey in value-position (false).
        const topScope = structureStack.length > 0 ? structureStack[structureStack.length - 1] : null;
        if (topScope === '{') {
          inKey = true;
        }
      }
    }

    i++;
  }

  // If we exit with an unclosed string, attempt truncation repair when requested.
  // Closes the open string literal and all unclosed containers in reverse order.
  if (inString) {
    if (options?.attemptTruncationRepair && structureStack.length > 0) {
      const closing = [...structureStack]
        .reverse()
        .map(c => (c === '{' ? '}' : ']'))
        .join('');
      const salvage = result + '"' + closing;
      try {
        JSON.parse(salvage);
        // Do NOT increment repairedQuotes - this is structural repair, not quote escaping.
        return { result: salvage, repairedQuotes, truncationRepaired: true };
      } catch {
        // Salvage failed - fall through to return original
      }
    }
    // Return the original string so downstream JSON.parse fails predictably.
    return { result: jsonStr, repairedQuotes: 0 };
  }

  return { result, repairedQuotes };
}
