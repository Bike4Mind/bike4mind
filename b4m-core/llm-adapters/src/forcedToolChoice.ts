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

// Structured outputs accept only these as enum values.
function isScalar(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Whether a tool input schema can carry `strict: true` unchanged: every node is typed with one type
 * (strict mode can reject a type array that the same union as anyOf passes), every object closes with
 * `additionalProperties: false` and lists `required`, enums hold only scalars, and no unsupported
 * constraint appears. Conservative - a false here only means the tool is sent without `strict`.
 */
export function isStrictCompatibleSchema(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (STRICT_UNSUPPORTED_KEYWORDS.some(key => key in schema)) return false;
  if ('minItems' in schema && schema.minItems !== 0 && schema.minItems !== 1) return false;
  if (typeof schema.format === 'string' && !STRICT_STRING_FORMATS.has(schema.format)) return false;
  if (Array.isArray(schema.type) && schema.type.length > 1) return false;
  if ('enum' in schema && !(Array.isArray(schema.enum) && schema.enum.every(isScalar))) return false;
  if (!['type', 'enum', 'const', 'anyOf', 'allOf'].some(key => key in schema)) return false;

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

/**
 * Whether any object in the schema explicitly allows keys beyond `properties` (`additionalProperties`
 * set to anything but false). buildStructuredOutputFormat closes those objects, so a caller relying on
 * the extra keys would silently lose them.
 */
export function declaresOpenObject(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if ('additionalProperties' in schema && schema.additionalProperties !== false) return true;
  const children: unknown[] = [schema.items];
  for (const key of ['properties', '$defs', 'definitions'] as const) {
    const named = schema[key];
    if (isRecord(named)) children.push(...Object.values(named));
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const variants = schema[key];
    if (Array.isArray(variants)) children.push(...variants);
  }
  return children.some(declaresOpenObject);
}

const STRUCTURED_OUTPUT_KEPT_KEYWORDS = new Set(['type', 'description', 'title', 'const', 'required']);

const LOCAL_DEF_REF = /^#\/(?:\$defs|definitions)\/[^/]+$/;

const TYPE_SPECIFIC_KEYWORDS = new Map<unknown, string[]>([
  ['object', ['properties', 'required', 'additionalProperties']],
  ['array', ['items', 'minItems']],
  ['string', ['format']],
]);

function matchesType(value: unknown, type: unknown): boolean {
  if (type === 'null') return value === null;
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'object') return isRecord(value);
  if (type === 'array') return Array.isArray(value);
  return typeof value === type;
}

// Strict mode can reject a type array, such as a nullable enum's ["string", "null"], that the same union
// written as anyOf passes. Each type becomes a variant holding its own keywords and enum / const values;
// a variant left with no allowed value is dropped. Null when anyOf / allOf / $ref sit beside the array.
function splitTypeArray(node: Record<string, unknown>): Record<string, unknown> | null {
  const types = [...new Set(node.type as unknown[])];
  if (types.length === 1) return { ...node, type: types[0] };
  if ('anyOf' in node || 'allOf' in node || '$ref' in node) return null;

  const variants: Record<string, unknown>[] = [];
  for (const type of types) {
    const variant: Record<string, unknown> = { type };
    for (const key of TYPE_SPECIFIC_KEYWORDS.get(type) ?? []) {
      if (key in node) variant[key] = node[key];
    }
    if (Array.isArray(node.enum)) {
      const values = node.enum.filter(value => matchesType(value, type));
      if (values.length === 0) continue;
      if (type !== 'null') variant.enum = values;
    }
    if ('const' in node) {
      if (!matchesType(node.const, type)) continue;
      if (type !== 'null') variant.const = node.const;
    }
    variants.push(variant);
  }
  if (variants.length === 0) return null;

  const shared: Record<string, unknown> = {};
  for (const key of ['description', 'title', '$defs', 'definitions']) {
    if (key in node) shared[key] = node[key];
  }
  return variants.length === 1 ? { ...variants[0], ...shared } : { anyOf: variants, ...shared };
}

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
// array, a free-form object, a $ref outside $defs/definitions or as an allOf member, or a non-scalar
// enum value.
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
      if (variants.some(variant => !variant || (key === 'allOf' && '$ref' in variant))) return null;
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
    } else if (key === 'enum') {
      if (!Array.isArray(value) || !value.every(isScalar)) return null;
      out.enum = value;
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
  return Array.isArray(out.type) ? splitTypeArray(out) : out;
}

const DEFINITION_KEYS = ['$defs', 'definitions'] as const;

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
  for (const key of DEFINITION_KEYS) {
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

// Structured outputs reject a schema past an undocumented compiled-grammar size, and an inlined schema
// (zod's default output) repeats one object per use. An object that appears more than once moves to
// $defs behind a $ref. allOf members stay inline: the API rejects allOf with $ref. Existing $defs /
// definitions bodies are scanned too, since zod's `reused: 'ref'` output keeps its bulk there.
function hoistRepeatedObjects(schema: Record<string, unknown>): Record<string, unknown> {
  const counts = new Map<string, number>();
  const countObjects = (node: unknown, hoistable: boolean): void => {
    if (Array.isArray(node)) {
      for (const child of node) countObjects(child, hoistable);
      return;
    }
    if (!isRecord(node)) return;
    if (isRecord(node.properties)) {
      if (hoistable) {
        const key = JSON.stringify(node);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      for (const child of Object.values(node.properties)) countObjects(child, true);
    }
    if (node.items !== undefined) countObjects(node.items, true);
    if (node.anyOf !== undefined) countObjects(node.anyOf, true);
    if (node.allOf !== undefined) countObjects(node.allOf, false);
  };
  countObjects(schema, false);
  for (const key of DEFINITION_KEYS) {
    if (isRecord(schema[key])) countObjects(Object.values(schema[key]), false);
  }
  const repeated = new Set([...counts].filter(([, n]) => n > 1).map(([key]) => key));
  if (repeated.size === 0) return schema;

  const defs: Record<string, unknown> = isRecord(schema.$defs) ? { ...schema.$defs } : {};
  const names = new Map<string, string>();
  let next = 0;
  const rewrite = (node: unknown, hoistable: boolean): unknown => {
    if (Array.isArray(node)) return node.map(child => rewrite(child, hoistable));
    if (!isRecord(node)) return node;
    const key = hoistable && isRecord(node.properties) ? JSON.stringify(node) : null;
    if (key && repeated.has(key)) {
      let name = names.get(key);
      if (!name) {
        do {
          name = `shared${++next}`;
        } while (name in defs);
        names.set(key, name);
        defs[name] = rewrite(node, false);
      }
      return { $ref: `#/$defs/${name}` };
    }
    const out: Record<string, unknown> = { ...node };
    if (isRecord(node.properties)) {
      out.properties = Object.fromEntries(
        Object.entries(node.properties).map(([prop, child]) => [prop, rewrite(child, true)])
      );
    }
    if (node.items !== undefined) out.items = rewrite(node.items, true);
    if (node.anyOf !== undefined) out.anyOf = rewrite(node.anyOf, true);
    if (node.allOf !== undefined) out.allOf = rewrite(node.allOf, false);
    return out;
  };
  const root = rewrite(schema, false) as Record<string, unknown>;
  const definitions = isRecord(schema.definitions) ? schema.definitions : null;
  if (definitions) {
    root.definitions = Object.fromEntries(
      Object.entries(definitions).map(([name, def]) => [name, rewrite(def, false)])
    );
  }
  if (isRecord(schema.$defs)) {
    for (const [name, def] of Object.entries(schema.$defs)) defs[name] = rewrite(def, false);
  }
  return { ...root, $defs: defs };
}

/**
 * `output_config.format` for a json_schema response_format, or null when the schema needs something
 * structured outputs reject (recursion, a free-form object, a typeless node) and the caller should
 * fall back to the prompt instruction. Objects are closed with `additionalProperties: false`,
 * unsupported constraints move into descriptions, `enum` / `const` / `$defs` are kept (the SDK's
 * transformJSONSchema drops the first two and dangles `definitions` refs), a type array becomes
 * anyOf, and an object repeated inline moves to `$defs` once. Never mutates `schema`.
 */
export function buildStructuredOutputFormat(schema: Record<string, unknown>): JSONOutputFormat | null {
  const converted = toStructuredOutputNode(schema);
  if (!converted || hasRecursiveRef(converted)) return null;
  return { type: 'json_schema', schema: hoistRepeatedObjects(converted) };
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
