function tryParse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Extract the first balanced {...} object from surrounding prose, respecting strings/escapes. */
function extractFirstBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Best-effort JSON parse for LLM output. Smaller / local models often wrap the JSON they were asked
 * for in prose or ```json fences instead of returning it bare; the deep-research planner needs the
 * object, not a hard failure. Tries a direct parse, then a fenced block, then the first balanced
 * {...} object embedded in prose. Returns null on any failure so callers treat it as "no result".
 */
export function parseTolerantJson<T>(raw: string): T | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;

  const direct = tryParse<T>(raw.trim());
  if (direct !== undefined) return direct;

  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    const fenced = tryParse<T>(fenceMatch[1].trim());
    if (fenced !== undefined) return fenced;
  }

  const candidate = extractFirstBalancedObject(raw);
  if (candidate) {
    const parsed = tryParse<T>(candidate);
    if (parsed !== undefined) return parsed;
  }

  return null;
}
