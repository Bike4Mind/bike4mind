import { z } from 'zod';
import { UNTRUSTED_NOTE } from './results';
import type { Tool } from './tool';

export const MAX_DESCRIPTION_LENGTH = 600;
export const DEFAULT_PAGE_SIZE = 20;
const NAME_RE = /^[a-z]+(_[a-z0-9]+)+$/;

/** Every property name reachable in a zod schema, through objects, arrays and optional/nullable/default wrappers. */
function collectKeys(schema: z.ZodTypeAny, out: Set<string> = new Set(), depth = 0): Set<string> {
  if (depth > 8) return out;
  const def = ((schema as unknown as { def?: Record<string, unknown> }).def ?? {}) as Record<string, unknown>;
  if (def.shape && typeof def.shape === 'object') {
    for (const [key, child] of Object.entries(def.shape)) {
      out.add(key);
      collectKeys(child as z.ZodTypeAny, out, depth + 1);
    }
  }
  for (const next of [def.element, def.innerType]) {
    if (next) collectKeys(next as z.ZodTypeAny, out, depth + 1);
  }
  return out;
}

/** Violations of the tool design rules; empty means the tool conforms. */
export function checkToolDesign(tool: Tool): string[] {
  const v: string[] = [];
  const at = (msg: string) => v.push(`${tool.name}: ${msg}`);

  if (!NAME_RE.test(tool.name)) at('name must be snake_case verb_noun');
  if (!tool.title?.trim()) at('title is required');
  for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
    if (typeof tool.annotations?.[hint] !== 'boolean') at(`annotations.${hint} must be an explicit boolean`);
  }
  if (!tool.outputSchema || Object.keys(tool.outputSchema).length === 0) at('outputSchema is required');
  if (tool.description.length > MAX_DESCRIPTION_LENGTH) at(`description is over ${MAX_DESCRIPTION_LENGTH} characters`);

  const inputs = tool.inputSchema ?? {};
  if (Object.keys(inputs).some(key => /^confirm/i.test(key))) {
    at('no confirm input: confirmation is a needs_confirmation result, never a flag the model can set');
  }

  const untrusted = [...collectKeys(z.object(tool.outputSchema ?? {}))].some(key => key.startsWith('untrusted_'));
  if (untrusted && !tool.description.includes(UNTRUSTED_NOTE))
    at('describes untrusted_* output without the data-not-instructions note');

  if (tool.name.startsWith('list_') || 'cursor' in inputs) {
    const parsed = (inputs.limit as z.ZodTypeAny | undefined)?.safeParse(undefined);
    if (!parsed?.success || parsed.data !== DEFAULT_PAGE_SIZE)
      at(`list tools expose limit with default ${DEFAULT_PAGE_SIZE}`);
  }
  return v;
}
