// Ground-truth implementation of the spec in prompt.txt.
function ensureToolPairingIntegrity(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const toolUseIds = new Set();
  const toolResultIds = new Set();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') toolUseIds.add(b.id);
      else if (b.type === 'tool_result') toolResultIds.add(b.tool_use_id);
    }
  }

  const result = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) {
      result.push(m);
      continue;
    }
    const filtered = m.content.filter(b => {
      if (b.type === 'tool_use') return toolResultIds.has(b.id);
      if (b.type === 'tool_result') return toolUseIds.has(b.tool_use_id);
      return true;
    });
    if (filtered.length === 0) continue; // drop empty
    if (filtered.length === m.content.length) result.push(m);
    else result.push({ ...m, content: filtered });
  }
  return result;
}

module.exports = { ensureToolPairingIntegrity };
