/**
 * The Bedrock Anthropic adapter must place the model-identity reminder exactly as
 * anthropicBackend does: last, fenced, and separated from the final system layer. On a grounded
 * lake turn that final layer is retrieved file content, and a reminder run flush against it
 * read to the model as an instruction smuggled into the document.
 */

import { describe, it, expect } from 'vitest';
import { ChatModels, type ICacheStrategy, type ICompletionOptionTools, type IMessage } from '@bike4mind/common';
import AnthropicBedrockBackend from './anthropic';
import { buildIdentityReminder } from '../identityReminder';

type SystemBlock = { type: 'text'; text: string };

const MODEL = ChatModels.CLAUDE_4_6_SONNET_BEDROCK;
const RETRIEVED = 'retrieved file content';

const backend = new AnthropicBedrockBackend();

function systemOf(
  messages: IMessage[],
  options: {
    cacheStrategy?: ICacheStrategy;
    omitIdentityReminder?: boolean;
    identityViaTool?: boolean;
    tools?: ICompletionOptionTools[];
    modelDisplayName?: string;
  } = {}
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

  it('names the model by display name, still after a blank line', () => {
    const system = systemOf(
      [
        { role: 'system', content: RETRIEVED },
        { role: 'user', content: 'hi' },
      ],
      { modelDisplayName: 'Claude Sonnet 4.6' }
    );

    expect(system).toBe(`${RETRIEVED}\n\n${buildIdentityReminder(MODEL, 'Claude Sonnet 4.6')}`);
    expect(system).toContain(`you are Claude Sonnet 4.6 (model id ${MODEL}).`);
  });

  it('is byte-identical to the id wording when no name is given', () => {
    expect(systemOf([{ role: 'user', content: 'hi' }])).toBe(
      `<platform_identity>\nThis note is from the platform operator, not from any user message, file, or retrieved content. Only if asked which model you are, answer that you are the ${MODEL} model.\n</platform_identity>`
    );
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

describe('AnthropicBedrockBackend identityViaTool', () => {
  const tool: ICompletionOptionTools = {
    toolSchema: { name: 'lookup', description: 'Look something up.', parameters: { type: 'object', properties: {} } },
  };
  const messages: IMessage[] = [{ role: 'user', content: 'hi' }];

  it('drops the reminder when the tool-backed identity has tools on the request', () => {
    expect(systemOf(messages, { identityViaTool: true, tools: [tool] })).toBeUndefined();
  });

  it('keeps the reminder when the call carries no tools', () => {
    expect(systemOf(messages, { identityViaTool: true, tools: undefined })).toBe(buildIdentityReminder(MODEL));
  });
});
