const DATED_MODEL = /-(?:\d{4}-\d{2}-\d{2}|\d{4})$/;
const LEGACY_GPT4_SNAPSHOTS = new Set(['gpt-4-0314', 'gpt-4-0613']);

/** Direct OpenAI aliases can answer with a dated family snapshot; explicit snapshots stay exact. */
export function matchesOpenAIResponseModel(requested: string, returned: unknown, nowMs = Date.now()): boolean {
  if (!requested || typeof returned !== 'string' || !returned) return false;
  if (returned === requested) return true;
  if (DATED_MODEL.test(requested)) return false;
  const family = requested.replace(/-latest$/, '');
  if (!/^(?:gpt-|chatgpt-|o\d(?:-|$))/.test(family)) return false;
  // GPT-4 predates the YYYY-MM-DD snapshot naming convention.
  if (family === 'gpt-4' && LEGACY_GPT4_SNAPSHOTS.has(returned)) return true;
  const snapshot = /^(.*)-(\d{4}-\d{2}-\d{2})$/.exec(returned);
  if (!snapshot || snapshot[1] !== family) return false;
  const day = snapshot[2];
  const time = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(time) && time <= nowMs && new Date(time).toISOString().slice(0, 10) === day;
}
