import { canonicalJson } from '../utils/canonicalJson';
import {
  highestWhole,
  lowestWhole,
  type FunctionBound,
  type FunctionContract,
  type FunctionField,
  type FunctionNumberField,
  type FunctionObjectField,
} from './functionContract';

/** Where a contract is sent: a model's tool list, an MCP tool listing, or the REST API. */
export type FunctionSurface = 'llm' | 'mcp' | 'rest';

/** A field in the keywords every model provider accepts, with every object closed. */
export interface FunctionLlmSchema {
  type: FunctionField['type'];
  description?: string;
  enum?: (string | number)[];
  items?: FunctionLlmSchema;
  properties?: Record<string, FunctionLlmSchema>;
  required?: string[];
  additionalProperties?: false;
}

export interface FunctionLlmTool {
  name: string;
  description: string;
  parameters: FunctionLlmSchema;
}

export interface FunctionMcpTool {
  name: string;
  description: string;
  inputSchema: FunctionObjectField;
  outputSchema: FunctionObjectField;
}

/** What the `llm` projection does with each contract keyword: keep it, or move it into the field's description. */
export const FUNCTION_LLM_KEYWORD_RULES: Readonly<Record<string, 'keep' | 'describe'>> = {
  type: 'keep',
  description: 'keep',
  enum: 'keep',
  items: 'keep',
  properties: 'keep',
  required: 'keep',
  additionalProperties: 'keep',
  unit: 'describe',
  minimum: 'describe',
  maximum: 'describe',
  exclusiveMinimum: 'describe',
  exclusiveMaximum: 'describe',
  maxLength: 'describe',
  minItems: 'describe',
  maxItems: 'describe',
  default: 'describe',
};

function tightest(bounds: FunctionBound[], side: 'lower' | 'upper'): FunctionBound | undefined {
  return bounds.reduce<FunctionBound | undefined>((best, bound) => {
    if (!best) return bound;
    if (bound.value === best.value) return bound.exclusive ? bound : best;
    return (side === 'lower') === bound.value > best.value ? bound : best;
  }, undefined);
}

function rangeText(field: FunctionNumberField): string | undefined {
  const bound = (value: number | undefined, exclusive: boolean): FunctionBound[] =>
    value === undefined ? [] : [{ value, exclusive }];
  const whole = (limit: FunctionBound | undefined, round: (b: FunctionBound) => number) =>
    limit && field.type === 'integer' ? { value: round(limit), exclusive: false } : limit;
  const lower = whole(
    tightest([...bound(field.minimum, false), ...bound(field.exclusiveMinimum, true)], 'lower'),
    lowestWhole
  );
  const upper = whole(
    tightest([...bound(field.maximum, false), ...bound(field.exclusiveMaximum, true)], 'upper'),
    highestWhole
  );
  const below = (limit: FunctionBound) => (limit.exclusive ? '<' : '<=');
  if (lower && upper) return `${lower.value} ${below(lower)} value ${below(upper)} ${upper.value}`;
  if (lower) return `value ${lower.exclusive ? '>' : '>='} ${lower.value}`;
  if (upper) return `value ${below(upper)} ${upper.value}`;
  return undefined;
}

function countText(min: number | undefined, max: number | undefined): string | undefined {
  if (min !== undefined && max !== undefined) return min === max ? `exactly ${min}` : `${min} to ${max}`;
  if (min !== undefined) return `at least ${min}`;
  if (max !== undefined) return `at most ${max}`;
  return undefined;
}

/**
 * Dropped keywords become sentences after the field's own description, always in this form and order:
 * `Unit: m. Range: 0 < value <= 10. Length: at most 80. Items: 1 to 5. Default: 1.`
 */
function constraintSentences(field: FunctionField): string[] {
  const entries: [string, string | undefined][] = [];
  if (field.type === 'number' || field.type === 'integer') {
    entries.push(['Unit', field.unit], ['Range', rangeText(field)]);
  }
  if (field.type === 'string') entries.push(['Length', countText(undefined, field.maxLength)]);
  if (field.type === 'array') entries.push(['Items', countText(field.minItems, field.maxItems)]);
  if (field.type !== 'array' && field.type !== 'object' && field.default !== undefined) {
    entries.push(['Default', JSON.stringify(field.default)]);
  }
  return entries.flatMap(([label, text]) => (text === undefined ? [] : [`${label}: ${text}.`]));
}

function describe(description: string | undefined, sentences: string[]): string | undefined {
  if (sentences.length === 0) return description;
  const own = description?.trim();
  const lead = own ? [/[.!?]$/.test(own) ? own : `${own}.`] : [];
  return [...lead, ...sentences].join(' ');
}

function projectLlmField(field: FunctionField): FunctionLlmSchema {
  for (const key of Object.keys(field)) {
    if (!Object.prototype.hasOwnProperty.call(FUNCTION_LLM_KEYWORD_RULES, key)) {
      throw new Error(`the llm projection has no rule for the contract keyword "${key}"`);
    }
  }
  const schema: FunctionLlmSchema = { type: field.type };
  const description = describe(field.description, constraintSentences(field));
  if (description !== undefined) schema.description = description;
  if (field.type !== 'boolean' && field.type !== 'array' && field.type !== 'object' && field.enum) {
    schema.enum = [...field.enum];
  }
  if (field.type === 'array') schema.items = projectLlmField(field.items);
  if (field.type === 'object') {
    schema.properties = Object.fromEntries(
      Object.entries(field.properties).map(([name, child]) => [name, projectLlmField(child)])
    );
    schema.required = [...(field.required ?? [])];
    schema.additionalProperties = false;
  }
  return schema;
}

/** Every leaf of an output, by path, with its unit: `reaction.left (N)`, `supports[].moment (N*m)`. */
function leaves(field: FunctionField, path: string): string[] {
  if (field.type === 'number' || field.type === 'integer')
    return [field.unit === undefined ? path : `${path} (${field.unit})`];
  if (field.type === 'array') {
    const nested = field.items.type === 'object' || field.items.type === 'array';
    return leaves(field.items, nested ? `${path}[]` : path);
  }
  if (field.type === 'object') {
    const children = Object.entries(field.properties);
    return children.length === 0 ? [path] : children.flatMap(([name, child]) => leaves(child, `${path}.${name}`));
  }
  return [path];
}

function outputsLine(outputs: FunctionObjectField): string {
  const listed = Object.entries(outputs.properties).flatMap(([name, field]) => leaves(field, name));
  return listed.length > 0 ? `\nOutputs: ${listed.join(', ')}.` : '';
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * The contract as one surface reads it: `llm` for every model provider's tool list, `mcp` with the
 * schemas verbatim (`unit` stays as an extension keyword), and `rest` as the canonical contract.
 */
export function projectFunctionSchema(contract: FunctionContract, surface: 'llm'): FunctionLlmTool;
export function projectFunctionSchema(contract: FunctionContract, surface: 'mcp'): FunctionMcpTool;
export function projectFunctionSchema(contract: FunctionContract, surface: 'rest'): FunctionContract;
export function projectFunctionSchema(
  contract: FunctionContract,
  surface: FunctionSurface
): FunctionLlmTool | FunctionMcpTool | FunctionContract;
export function projectFunctionSchema(
  contract: FunctionContract,
  surface: FunctionSurface
): FunctionLlmTool | FunctionMcpTool | FunctionContract {
  const { name, description, inputs, outputs } = contract;
  switch (surface) {
    case 'llm':
      return { name, description: description + outputsLine(outputs), parameters: projectLlmField(inputs) };
    case 'mcp':
      return { name, description, inputSchema: copy(inputs), outputSchema: copy(outputs) };
    case 'rest':
      return { name, description, inputs: copy(inputs), outputs: copy(outputs) };
  }
}

/**
 * sha256 hex of the canonical JSON of the contract's interface, never of a projection, so one review
 * covers every surface. Web Crypto rather than node:crypto because the client bundles this module too.
 */
export async function reviewHash(contract: FunctionContract): Promise<string> {
  const { name, description, inputs, outputs } = contract;
  const text = canonicalJson({ name, description, inputs, outputs });
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
