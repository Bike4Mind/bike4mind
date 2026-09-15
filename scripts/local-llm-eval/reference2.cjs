// Plain-JS port of the real fix (apps/client/server/tavern/parseQuestResponse.ts),
// used only to self-verify the test suite is internally consistent.
function extractJsonObject(text) {
  const trimmed = String(text == null ? '' : text).trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try { JSON.parse(trimmed); return trimmed; } catch {}
  }
  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenced) {
    const inner = fenced[1].trim();
    try { JSON.parse(inner); return inner; } catch {}
  }
  let start = trimmed.indexOf('{');
  while (start !== -1) {
    let end = trimmed.indexOf('}', start + 1);
    while (end !== -1) {
      const candidate = trimmed.slice(start, end + 1);
      try { JSON.parse(candidate); return candidate; } catch {}
      end = trimmed.indexOf('}', end + 1);
    }
    start = trimmed.indexOf('{', start + 1);
  }
  return null;
}

function parseQuestResponse(raw) {
  const json = extractJsonObject(raw);
  if (!json) return null;
  let p;
  try { p = JSON.parse(json); } catch { return null; }
  if (!p || typeof p !== 'object') return null;
  if (typeof p.title !== 'string' || typeof p.description !== 'string') return null;
  const difficulty = ['easy', 'medium', 'hard'].includes(p.difficulty) ? p.difficulty : 'medium';
  return { title: p.title, description: p.description, difficulty };
}

module.exports = { parseQuestResponse };
