/**
 * Fallbacks for Claude models that reject forced tool use (see supportsForcedToolChoice in
 * @bike4mind/common): json_schema goes through native structured outputs, and a caller's
 * 'required' / named tool_choice becomes `auto` plus a system instruction and `strict` on the
 * named tool. Shared by AnthropicBackend; the Bedrock Anthropic backend never sends tool_choice.
 */

import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema';
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

/**
 * `output_config.format` for a json_schema response_format. The SDK's transform closes every
 * object and moves unsupported constraints into descriptions, which is what the API requires;
 * a schema it cannot transform (no `type`) is sent as given and the API is the judge.
 */
export function buildStructuredOutputFormat(schema: Record<string, unknown>): JSONOutputFormat {
  let transformed: Record<string, unknown>;
  try {
    transformed = transformJSONSchema(schema);
  } catch {
    transformed = schema;
  }
  return { type: 'json_schema', schema: transformed };
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
