/**
 * Shared helpers for honoring `response_format` across LLM backends.
 *
 * Providers that don't support native structured output
 * (Bedrock, Gemini, xAI, Ollama) fall back to a prompt-only instruction.
 * This helper produces the instruction text and a system message that can
 * be prepended to the user's messages.
 */

import type { IMessage, ResponseFormat } from '@bike4mind/common';

/**
 * Build the instruction text for a JSON-schema response_format. Includes the
 * schema inline so the model has the full contract.
 */
export function buildJsonSchemaInstruction(responseFormat: ResponseFormat): string | null {
  if (responseFormat.type !== 'json_schema') return null;
  const { name, description, schema } = responseFormat.json_schema;
  const lines = [
    'You MUST respond with a single JSON value that conforms to the following JSON Schema.',
    `Schema name: ${name}`,
  ];
  if (description) {
    lines.push(`Schema description: ${description}`);
  }
  lines.push('Schema:', '```json', JSON.stringify(schema, null, 2), '```');
  lines.push('Do not include any prose, explanation, or markdown fences in the response — only the raw JSON value.');
  return lines.join('\n');
}

/**
 * Prepend a JSON-schema instruction system message when the request asks for
 * `response_format: { type: 'json_schema' }` and the provider only supports
 * best-effort structured output. No-op when responseFormat is unset, type is
 * 'text', or the schema instruction can't be derived.
 */
export function injectJsonSchemaInstruction(
  messages: IMessage[],
  responseFormat: ResponseFormat | undefined
): IMessage[] {
  if (!responseFormat || responseFormat.type !== 'json_schema') return messages;
  const instruction = buildJsonSchemaInstruction(responseFormat);
  if (!instruction) return messages;
  return [{ role: 'system', content: instruction }, ...messages];
}

/**
 * Whether the request is asking for structured output and the provider should
 * report `responseFormatMode: 'best-effort'` in its terminal callback.
 */
export function isBestEffortJsonSchema(responseFormat: ResponseFormat | undefined): boolean {
  return responseFormat?.type === 'json_schema';
}
