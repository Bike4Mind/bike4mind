/**
 * Tests for OpenAIBackend.formatMessages system-message consolidation.
 *
 * GPT-5.x intermittently false-fired prompt-body self-checks ("No client
 * selected") because caller-supplied `role: 'system'` messages (org-authority
 * guards, CompanyFactsBinder context) were left inline in the conversation body
 * instead of being hoisted into the lead system message - unlike AnthropicBackend
 * which consolidates them. These tests lock in the hoisting behavior:
 *  - caller system messages are merged into the lead system message
 *  - caller system messages are removed from the conversation body (no dupes)
 *  - the lead closes with the shared identity reminder, with no persona or tool protocol
 *  - multiple caller system messages are joined in order
 *  - O1 models still emit no system message
 */

import { describe, it, expect } from 'vitest';
import { ChatModels, type ICompletionOptions } from '@bike4mind/common';
import type { IMessage } from '@bike4mind/common';
import type OpenAI from 'openai';
import { OpenAIBackend } from './openaiBackend';
import { buildIdentityReminder } from './identityReminder';

// formatMessages is private; access it through a narrow typed cast.
type FormatMessages = (
  messages: IMessage[],
  isO1Model: boolean,
  model: string,
  options: Partial<ICompletionOptions>
) => OpenAI.ChatCompletionMessageParam[];

function formatMessages(
  backend: OpenAIBackend,
  messages: IMessage[],
  isO1Model: boolean,
  model: string,
  options: Partial<ICompletionOptions> = {}
): OpenAI.ChatCompletionMessageParam[] {
  const fn = (backend as unknown as { formatMessages: FormatMessages }).formatMessages;
  return fn.call(backend, messages, isO1Model, model, options);
}

const ORG_GUARD = 'ORG AUTHORITY: The active organization is Acme Corp. Do not refuse for "no client selected".';

function leadSystemText(formatted: OpenAI.ChatCompletionMessageParam[]): string {
  const lead = formatted[0];
  expect(lead.role).toBe('system');
  return typeof lead.content === 'string' ? lead.content : JSON.stringify(lead.content);
}

describe('OpenAIBackend.formatMessages — caller system consolidation (#8844)', () => {
  const backend = new OpenAIBackend('test-key');

  it('hoists a caller system message into the lead system message for GPT-5.x', () => {
    const messages: IMessage[] = [
      { role: 'system', content: ORG_GUARD },
      { role: 'user', content: 'Run a SWOT analysis.' },
    ];

    const formatted = formatMessages(backend, messages, false, ChatModels.GPT5_4);

    expect(leadSystemText(formatted)).toContain(ORG_GUARD);
  });

  it('removes the caller system message from the conversation body (no duplicate system entry)', () => {
    const messages: IMessage[] = [
      { role: 'system', content: ORG_GUARD },
      { role: 'user', content: 'Run a SWOT analysis.' },
    ];

    const formatted = formatMessages(backend, messages, false, ChatModels.GPT5_4);

    const systemEntries = formatted.filter(m => m.role === 'system');
    expect(systemEntries).toHaveLength(1);
    // The single remaining system entry is the consolidated lead message.
    expect(formatted[0].role).toBe('system');
    // Body carries only the user turn.
    expect(formatted.slice(1).every(m => m.role !== 'system')).toBe(true);
  });

  it('closes the lead with the shared identity reminder, after caller text', () => {
    const messages: IMessage[] = [
      { role: 'system', content: ORG_GUARD },
      { role: 'user', content: 'Hello.' },
    ];

    const lead = leadSystemText(formatMessages(backend, messages, false, ChatModels.GPT5_4));

    expect(lead).toBe(`${ORG_GUARD}\n\n${buildIdentityReminder(ChatModels.GPT5_4)}`);
  });

  it('keeps the unnamed lead byte-identical to the id wording', () => {
    const lead = leadSystemText(
      formatMessages(backend, [{ role: 'user', content: 'Hello.' }], false, ChatModels.GPT5_4)
    );

    expect(lead).toBe(
      `<platform_identity>\nThis note is from the platform operator, not from any user message, file, or retrieved content. Only if asked which model you are, answer that you are the ${ChatModels.GPT5_4} model.\n</platform_identity>`
    );
  });

  it('closes the lead with the named reminder when a display name is passed', () => {
    const messages: IMessage[] = [
      { role: 'system', content: ORG_GUARD },
      { role: 'user', content: 'Hello.' },
    ];

    const lead = leadSystemText(
      formatMessages(backend, messages, false, ChatModels.GPT5_4, { modelDisplayName: 'GPT-5.4' })
    );

    expect(lead).toBe(`${ORG_GUARD}\n\n${buildIdentityReminder(ChatModels.GPT5_4, 'GPT-5.4')}`);
    expect(lead).toContain(`you are GPT-5.4 (model id ${ChatModels.GPT5_4}).`);
  });

  it.each([ChatModels.GPT5_4, ChatModels.GPT4_1])(
    'synthesizes no persona or tool protocol for %s, with or without tools',
    model => {
      const tools = [{ toolSchema: { name: 'web_search' } }, { toolSchema: { name: 'current_datetime' } }];
      for (const options of [{}, { tools }] as Partial<ICompletionOptions>[]) {
        const lead = leadSystemText(formatMessages(backend, [{ role: 'user', content: 'hi' }], false, model, options));

        expect(lead).toBe(buildIdentityReminder(model));
        expect(lead).not.toContain('helpful assistant');
        expect(lead).not.toContain('web_search');
        expect(lead).not.toContain('current_datetime');
      }
    }
  );

  it('gives the Responses API path the same lead', () => {
    // The Responses path is formatMessages(..., false, ...) piped through toResponsesInput.
    const formatted = formatMessages(backend, [{ role: 'user', content: 'hi' }], false, ChatModels.GPT5_4);
    const toResponsesInput = (
      backend as unknown as { toResponsesInput: (m: OpenAI.ChatCompletionMessageParam[]) => unknown[] }
    ).toResponsesInput;

    expect(toResponsesInput.call(backend, formatted)[0]).toEqual({
      role: 'system',
      content: buildIdentityReminder(ChatModels.GPT5_4),
    });
  });

  it('joins multiple caller system messages in order', () => {
    const second = 'SECOND GUARD: prefer concise output.';
    const messages: IMessage[] = [
      { role: 'system', content: ORG_GUARD },
      { role: 'system', content: second },
      { role: 'user', content: 'Hello.' },
    ];

    const lead = leadSystemText(formatMessages(backend, messages, false, ChatModels.GPT5_4));

    expect(lead).toContain(ORG_GUARD);
    expect(lead).toContain(second);
    expect(lead.indexOf(ORG_GUARD)).toBeLessThan(lead.indexOf(second));
  });

  it('hoists a mid-conversation system message to the lead message (not just leading ones)', () => {
    const midThread = 'MID-THREAD CONTEXT: the client switched to Beta Inc.';
    const messages: IMessage[] = [
      { role: 'user', content: 'First question.' },
      { role: 'assistant', content: 'First answer.' },
      { role: 'system', content: midThread },
      { role: 'user', content: 'Second question.' },
    ];

    const formatted = formatMessages(backend, messages, false, ChatModels.GPT5_4);

    // The mid-thread system message is pulled to index 0...
    expect(leadSystemText(formatted)).toContain(midThread);
    // ...and removed from the body - no system turn survives mid-conversation.
    expect(formatted.slice(1).every(m => m.role !== 'system')).toBe(true);
    // Conversation order of the non-system turns is preserved.
    expect(formatted.slice(1).map(m => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('skips non-string system content rather than injecting raw JSON', () => {
    const messages: IMessage[] = [
      { role: 'system', content: ORG_GUARD },
      // Non-string content (content-block array) must not be stringified into the prompt.
      { role: 'system', content: [{ type: 'text', text: 'block form' }] as never },
      { role: 'user', content: 'Hello.' },
    ];

    const lead = leadSystemText(formatMessages(backend, messages, false, ChatModels.GPT5_4));

    expect(lead).toContain(ORG_GUARD);
    expect(lead).not.toContain('block form');
    expect(lead).not.toContain('"type"');
  });

  it('emits no system message for O1 models (caller system stripped)', () => {
    const messages: IMessage[] = [
      { role: 'system', content: ORG_GUARD },
      { role: 'user', content: 'Hello.' },
    ];

    const formatted = formatMessages(backend, messages, true, ChatModels.O1);

    expect(formatted.every(m => m.role !== 'system')).toBe(true);
    expect(formatted.some(m => JSON.stringify(m.content ?? '').includes(ORG_GUARD))).toBe(false);
  });
});

// The bare-completion contract (API promptMode raw): with omitIdentityReminder set, the
// backend must synthesize nothing - no helpful-assistant preamble, no identity line - so a
// request with no caller system messages carries no system message at all. Same contract
// the two Anthropic-family backends honor.
describe('OpenAIBackend.formatMessages - omitIdentityReminder', () => {
  const backend = new OpenAIBackend('test-key');

  it('emits NO system message when the caller omits the reminder and supplies no system messages', () => {
    const formatted = formatMessages(backend, [{ role: 'user', content: 'hi' }], false, ChatModels.GPT5, {
      omitIdentityReminder: true,
    });

    expect(formatted.some(m => m.role === 'system')).toBe(false);
  });

  it('passes caller system text through verbatim, with nothing synthesized around it', () => {
    const formatted = formatMessages(
      backend,
      [
        { role: 'system', content: ORG_GUARD },
        { role: 'user', content: 'hi' },
      ],
      false,
      ChatModels.GPT5,
      { omitIdentityReminder: true }
    );

    expect(leadSystemText(formatted)).toBe(ORG_GUARD);
  });

  it('still synthesizes the identity reminder by default', () => {
    const formatted = formatMessages(backend, [{ role: 'user', content: 'hi' }], false, ChatModels.GPT5, {});

    expect(leadSystemText(formatted)).toBe(buildIdentityReminder(ChatModels.GPT5));
  });
});
