import { autoCompactThreshold, estimateTextTokens } from './contextLimit';

export type ContextCategory = 'messages' | 'system-tools' | 'mcp-tools' | 'project' | 'skills' | 'system';

export interface ContextSlice {
  id: ContextCategory;
  tokens: number;
  items?: string[];
}

/** Estimates of injected request overhead, paired with one provider-reported input total. */
export interface ContextSnapshot {
  model: string;
  inputTokens: number;
  modelWindow?: number;
  overhead: ContextSlice[];
}

export function estimateContextOverhead(input: {
  system: string;
  project: string;
  skills: string;
  tools: readonly { name: string; schema: unknown; mcp: boolean }[];
}): ContextSlice[] {
  let system = input.system;
  const slices: ContextSlice[] = [];
  for (const [id, text] of [
    ['project', input.project],
    ['skills', input.skills],
  ] as const) {
    if (!text || !system.includes(text)) continue;
    system = system.replace(text, '');
    const items =
      id === 'project' ? [...text.matchAll(/^--- begin .+, from (.+) ---$/gm)].map(match => match[1]) : undefined;
    slices.push({ id, tokens: estimateTextTokens(text), ...(items?.length ? { items } : {}) });
  }
  for (const [id, mcp] of [
    ['system-tools', false],
    ['mcp-tools', true],
  ] as const) {
    const tools = input.tools.filter(tool => tool.mcp === mcp);
    if (tools.length)
      slices.push({
        id,
        tokens: estimateTextTokens(JSON.stringify(tools.map(tool => tool.schema))),
        items: tools.map(tool => tool.name),
      });
  }
  slices.push({ id: 'system', tokens: estimateTextTokens(system) });
  const order: ContextCategory[] = ['system-tools', 'mcp-tools', 'project', 'skills', 'system'];
  return slices.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

export function contextBreakdown(tokens: number, limit: number | null, snapshot?: ContextSnapshot | null) {
  const used = Math.max(0, tokens);
  const overhead = snapshot?.overhead ?? [];
  const estimated = overhead.reduce((sum, slice) => sum + slice.tokens, 0);
  // Provider totals win when serialization/tokenizer differences make estimates too large.
  const scale = estimated > used ? used / estimated : 1;
  let allocated = 0;
  const slices = overhead.map(slice => {
    const count = Math.min(used - allocated, Math.floor(slice.tokens * scale));
    allocated += count;
    return { ...slice, tokens: count };
  });
  slices.unshift({ id: 'messages', tokens: used - allocated });
  const capacity = limit !== null && Number.isFinite(limit) && limit > 0 ? limit : null;
  const remaining = capacity === null ? 0 : Math.max(0, capacity - used);
  const reserve = capacity === null ? 0 : Math.min(remaining, capacity - autoCompactThreshold(capacity));
  return { slices, capacity, reserve, free: remaining - reserve, used };
}
