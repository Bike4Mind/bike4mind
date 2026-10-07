/**
 * The Bedrock Anthropic adapter must place the model-identity reminder exactly as
 * anthropicBackend does: last, fenced, and separated from the final system layer. On a grounded
 * lake turn that final layer is retrieved file content, and a reminder run flush against it
 * read to the model as an instruction smuggled into the document.
 */

import { describe, it, expect } from 'vitest';
import { ChatModels, type ICacheStrategy, type IMessage } from '@bike4mind/common';
import AnthropicBedrockBackend from './anthropic';
import { buildIdentityReminder } from '../identityReminder';

type SystemBlock = { type: 'text'; text: string };

const MODEL = ChatModels.CLAUDE_4_6_SONNET_BEDROCK;
const RETRIEVED = 'retrieved file content';

const backend = new AnthropicBedrockBackend();

function systemOf(
  messages: IMessage[],
  options: { cacheStrategy?: ICacheStrategy; omitIdentityReminder?: boolean } = {}
) {
  const payload = backend.getPayload(MODEL, messages, { ...options, maxTokens: 1024 });
  return (JSON.parse(payload.body) as { system?: string | SystemBlock[] }).system;
}

describe('AnthropicBedrockBackend identity reminder', () => {
  it('leaves a blank line between the last system layer and the fenced reminder', () => {
    const system = systemOf([
      { role: 'system', content: RETRIEVED },
      { role: 'user', content: 'hi' },
    ]);

    expect(system).toBe(`${RETRIEVED}\n\n${buildIdentityReminder(MODEL)}`);
  });

  it('sends the reminder alone when there are no system messages', () => {
    expect(systemOf([{ role: 'user', content: 'hi' }])).toBe(buildIdentityReminder(MODEL));
  });

  it('sends the fenced reminder as its own trailing block when a cache breakpoint is emitted', () => {
    const system = systemOf(
      [
        { role: 'system', content: RETRIEVED, cache: true },
        { role: 'user', content: 'hi' },
      ],
      {
        cacheStrategy: {
          enableCaching: true,
          cacheSystemPrompt: true,
          cacheTools: true,
          cacheConversationHistory: true,
          cacheTTL: '5m',
        },
      }
    ) as SystemBlock[];

    expect(system.map(block => block.text)).toEqual([RETRIEVED, buildIdentityReminder(MODEL)]);
  });

  it('sends the caller system text verbatim when the reminder is omitted', () => {
    const system = systemOf(
      [
        { role: 'system', content: RETRIEVED },
        { role: 'user', content: 'hi' },
      ],
      { omitIdentityReminder: true }
    );

    expect(system).toBe(RETRIEVED);
  });
});
