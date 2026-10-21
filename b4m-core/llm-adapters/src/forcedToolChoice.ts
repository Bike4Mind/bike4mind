/**
 * Fallbacks for Claude models that reject forced tool use (see supportsForcedToolChoice in
 * @bike4mind/common): json_schema goes through native structured outputs, and a caller's
 * 'required' / named tool_choice becomes `auto` plus a system instruction and `strict` on the
 * named tool. Shared by AnthropicBackend; the Bedrock Anthropic backend never sends tool_choice.
 */

import type {
  JSONOutputFormat,
  MessageCreateParamsBase,
  MessageParam,
  ToolUnion,
} from '@anthropic-ai/sdk/resources/messages';
import type { ICompletionOptions } from './backend';

/**
 * A caller's forced tool_choice after it was downgraded to `auto`. `toolName` is null for
 * 'required' (any tool). Threaded through tool recursion so every turn of one request sends the
 * same system text and tool definitions - changing either mid-conversation invalidates the
 * preserved thinking blocks these models replay.
 */
export interface DowngradedToolChoice {
  toolName: string | null;
}

/** The downgrade for a forced choice, or undefined when the choice is not forced. */
export function downgradeForcedToolChoice(
  toolChoice: ICompletionOptions['tool_choice'] | undefined
): DowngradedToolChoice | undefined {
  if (toolChoice === 'required') return { toolName: null };
  if (typeof toolChoice === 'object' && toolChoice.function?.name) return { toolName: toolChoice.function.name };
  return undefined;
}

/** Prompt instruction standing in for the forced choice the API no longer accepts. */
export function buildToolUseInstruction({ toolName }: DowngradedToolChoice): string {
  const target = toolName ? `the \`${toolName}\` tool` : 'one of the provided tools';
  return `Your response must begin with a call to ${target}. Once its result is in the conversation, continue normally.`;
}

type SystemParam = MessageCreateParamsBase['system'];

/** Appends `text` to the system parameter, as a trailing block when the system is block-shaped. */
export function appendSystemText(system: SystemParam, text: string): SystemParam {
  if (Array.isArray(system)) return [...system, { type: 'text', text }];
  return system ? `${system}\n\n${text}` : text;
}

/** Marks the named custom tool `strict` when its input schema meets the strict-mode rules. */
export function markToolStrict(tools: ToolUnion[], toolName: string): ToolUnion[] {
  return tools.map(tool =>
    'input_schema' in tool && tool.name === toolName && isStrictCompatibleSchema(tool.input_schema)
      ? { ...tool, strict: true }
      : tool
  );
}

const STRICT_STRING_FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

// Constraint keywords strict mode rejects. $ref is listed so a recursive schema can never reach it.
const STRICT_UNSUPPORTED_KEYWORDS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'maxItems',
  'uniqueItems',
  'contains',
  'prefixItems',
  'oneOf',
  'not',
  '$ref',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a tool input schema can carry `strict: true` unchanged: every object closes with
 * `additionalProperties: false` and lists `required`, and no unsupported constraint appears.
 * Conservative - a false here only means the tool is sent without `strict`.
 */
export function isStrictCompatibleSchema(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (STRICT_UNSUPPORTED_KEYWORDS.some(key => key in schema)) return false;
  if ('minItems' in schema && schema.minItems !== 0 && schema.minItems !== 1) return false;
  if (typeof schema.format === 'string' && !STRICT_STRING_FORMATS.has(schema.format)) return false;

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('object')) {
    if (schema.additionalProperties !== false || !Array.isArray(schema.required)) return false;
  }

  const children: unknown[] = [];
  if (isRecord(schema.properties)) children.push(...Object.values(schema.properties));
  if (schema.items !== undefined) children.push(schema.items);
  for (const key of ['anyOf', 'allOf'] as const) {
    const variants = schema[key];
    if (Array.isArray(variants)) children.push(...variants);
  }
  return children.every(isStrictCompatibleSchema);
}

const STRUCTURED_OUTPUT_KEPT_KEYWORDS = new Set(['type', 'description', 'title', 'enum', 'const', 'required']);

const LOCAL_DEF_REF = /^#\/(?:\$defs|definitions)\/[^/]+$/;

function convertEach(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const converted: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(value)) {
    const node = toStructuredOutputNode(child);
    if (!node) return null;
    converted[name] = node;
  }
  return converted;
}

// Null for a node structured outputs cannot express: a boolean or typeless schema, a tuple `items`
// array, a free-form object, or a $ref outside $defs/definitions.
function toStructuredOutputNode(node: unknown): Record<string, unknown> | null {
  if (!isRecord(node)) return null;
  const out: Record<string, unknown> = {};
  const moved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' || key === '$defs' || key === 'definitions') {
      const converted = convertEach(value);
      if (!converted) return null;
      out[key] = converted;
    } else if (key === 'items') {
      const converted = toStructuredOutputNode(value);
      if (!converted) return null;
      out.items = converted;
    } else if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
      if (!Array.isArray(value)) return null;
      const variants = value.map(toStructuredOutputNode);
      if (variants.some(variant => !variant)) return null;
      out[key === 'allOf' ? 'allOf' : 'anyOf'] = variants;
    } else if (key === '$ref') {
      if (typeof value !== 'string' || !LOCAL_DEF_REF.test(value)) return null;
      out.$ref = value;
    } else if (key === 'additionalProperties') {
      continue;
    } else if (key === 'format') {
      if (typeof value === 'string' && STRICT_STRING_FORMATS.has(value)) out.format = value;
      else moved.format = value;
    } else if (key === 'minItems') {
      if (value === 0 || value === 1) out.minItems = value;
      else moved.minItems = value;
    } else if (STRUCTURED_OUTPUT_KEPT_KEYWORDS.has(key)) {
      out[key] = value;
    } else {
      moved[key] = value;
    }
  }

  if (!['type', 'enum', 'const', 'anyOf', 'allOf', '$ref'].some(key => key in out)) return null;

  const types = Array.isArray(out.type) ? out.type : [out.type];
  if (types.includes('object') || 'properties' in out) {
    // Closing a property-less open object would force `{}`, so it cannot be expressed.
    if (!('properties' in out) && node.additionalProperties !== false) return null;
    out.properties ??= {};
    out.additionalProperties = false;
  }

  if (Object.keys(moved).length > 0) {
    const constraints = Object.entries(moved)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(', ');
    out.description = (typeof out.description === 'string' ? `${out.description}\n\n` : '') + `{${constraints}}`;
  }
  return out;
}

function collectRefNames(node: unknown, names: Set<string>): void {
  if (Array.isArray(node)) {
    for (const child of node) collectRefNames(child, names);
  } else if (isRecord(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') names.add(value.slice(value.lastIndexOf('/') + 1));
      else collectRefNames(value, names);
    }
  }
}

// Structured outputs reject recursive schemas: a definition whose $ref chain leads back to itself.
function hasRecursiveRef(schema: Record<string, unknown>): boolean {
  const edges = new Map<string, Set<string>>();
  for (const key of ['$defs', 'definitions'] as const) {
    const defs = schema[key];
    if (!isRecord(defs)) continue;
    for (const [name, def] of Object.entries(defs)) {
      const names = edges.get(name) ?? new Set<string>();
      collectRefNames(def, names);
      edges.set(name, names);
    }
  }
  const finished = new Set<string>();
  const visit = (name: string, path: Set<string>): boolean => {
    if (path.has(name)) return true;
    if (finished.has(name) || !edges.has(name)) return false;
    path.add(name);
    for (const next of edges.get(name) ?? []) if (visit(next, path)) return true;
    path.delete(name);
    finished.add(name);
    return false;
  };
  return [...edges.keys()].some(name => visit(name, new Set()));
}

/**
 * `output_config.format` for a json_schema response_format, or null when the schema needs something
 * structured outputs reject (recursion, a free-form object, a typeless node) and the caller should
 * fall back to the prompt instruction. Objects are closed with `additionalProperties: false`,
 * unsupported constraints move into descriptions, and `enum` / `const` / `$defs` are kept (the SDK's
 * transformJSONSchema drops the first two and dangles `definitions` refs). Never mutates `schema`.
 */
export function buildStructuredOutputFormat(schema: Record<string, unknown>): JSONOutputFormat | null {
  const converted = toStructuredOutputNode(schema);
  if (!converted || hasRecursiveRef(converted)) return null;
  return { type: 'json_schema', schema: converted };
}

/** Whether any document block asks for citations, which the API refuses alongside output_config.format. */
export function hasCitationsEnabled(messages: MessageParam[]): boolean {
  return messages.some(
    message =>
      Array.isArray(message.content) &&
      message.content.some(block => {
        const citations: unknown = 'citations' in block ? block.citations : undefined;
        return isRecord(citations) && citations.enabled === true;
      })
  );
}
