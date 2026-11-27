import { z } from 'zod';
import { UNTRUSTED_NOTE } from './results';
import type { Tool } from './tool';

export const MAX_DESCRIPTION_LENGTH = 600;
export const DEFAULT_PAGE_SIZE = 20;
const NAME_RE = /^[a-z]+(_[a-z0-9]+)+$/;

/**
 * Every property name reachable in a zod schema: objects, arrays, tuples, unions, records, intersections, and
 * wrapper/pipe/transform/preprocess/lazy schemas. `seen` ends lazy cycles; there is no depth cap.
 */
function collectKeys(schema: z.ZodTypeAny, out: Set<string> = new Set(), seen = new Set<unknown>()): Set<string> {
  if (!schema || seen.has(schema)) return out;
  seen.add(schema);
  const def = ((schema as unknown as { def?: Record<string, unknown> }).def ?? {}) as Record<string, unknown>;
  if (def.shape && typeof def.shape === 'object') {
    for (const [key, child] of Object.entries(def.shape)) {
      out.add(key);
      collectKeys(child as z.ZodTypeAny, out, seen);
    }
  }
  const nested = [def.element, def.innerType, def.valueType, def.left, def.right, def.in, def.out, def.rest];
  if (typeof def.getter === 'function') nested.push((def.getter as () => unknown)());
  if (Array.isArray(def.options)) nested.push(...def.options);
  if (Array.isArray(def.items)) nested.push(...def.items);
  for (const next of nested) collectKeys(next as z.ZodTypeAny, out, seen);
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
  if ([...collectKeys(z.object(inputs))].some(key => /^confirm/i.test(key))) {
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
