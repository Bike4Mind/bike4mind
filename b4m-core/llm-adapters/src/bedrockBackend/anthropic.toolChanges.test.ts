/**
 * Mid-conversation tool changes on the Bedrock Claude adapter: a `tool_addition` system message stays
 * in `messages` at its position, is not hoisted into `system`, and turns on the beta in the body.
 */

import { describe, it, expect } from 'vitest';
import { ChatModels, type IMessage } from '@bike4mind/common';
import AnthropicBedrockBackend from './anthropic';
import type { ICompletionOptionTools } from '../backend';
import { TOOL_CHANGES_BETA } from '../toolChanges';

const backend = new AnthropicBedrockBackend();

const tool = (name: string, deferLoading?: boolean): ICompletionOptionTools => ({
  toolSchema: {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {} },
    ...(deferLoading ? { defer_loading: true } : {}),
  },
  toolFn: async () => 'ok',
});

const change = {
  role: 'system',
  requiresTool: 'deferred_tools',
  content: [
    { type: 'tool_addition', tool: { type: 'tool_reference', name: 'web_search' } },
    { type: 'text', text: 'web search guidance' },
  ],
} as unknown as IMessage;

type Body = {
  system?: string | Array<{ text: string }>;
  messages: Array<{ role: string; content: unknown; requiresTool?: string }>;
  tools?: Array<{ name: string; defer_loading?: boolean }>;
  anthropic_beta?: string[];
};

function bodyOf(messages: IMessage[], tools?: ICompletionOptionTools[]): Body {
  const payload = backend.getPayload(ChatModels.CLAUDE_5_5_OPUS_BEDROCK, messages, { tools, maxTokens: 1024 });
  return JSON.parse(payload.body) as Body;
}

describe('Bedrock Claude tool change messages', () => {
  const messages: IMessage[] = [
    { role: 'system', content: 'head guidance' },
    { role: 'user', content: 'u1' },
    change,
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
  ];

  it('keeps the tool_addition message in place and out of system', () => {
    const body = bodyOf(messages, [tool('current_model_details'), tool('web_search', true)]);

    expect(body.messages.map(m => m.role)).toEqual(['user', 'system', 'assistant', 'user']);
    expect(body.messages[1].content).toEqual((change as { content: unknown }).content);
    expect(body.messages[1]).not.toHaveProperty('requiresTool');
    expect(JSON.stringify(body.system)).toContain('head guidance');
    expect(JSON.stringify(body.system)).not.toContain('web search guidance');
    expect(body.tools?.find(t => t.name === 'web_search')?.defer_loading).toBe(true);
    expect(body.anthropic_beta).toEqual([TOOL_CHANGES_BETA]);
  });

  it('sends no beta without a tool change message', () => {
    const body = bodyOf(
      messages.filter(m => m !== change),
      [tool('current_model_details')]
    );
    expect(body).not.toHaveProperty('anthropic_beta');
    expect(body.messages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
  });
});
