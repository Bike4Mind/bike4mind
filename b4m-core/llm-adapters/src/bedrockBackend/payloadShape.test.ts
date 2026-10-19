import { describe, it, expect } from 'vitest';
import { describePayloadShape } from './payloadShape';

/**
 * Bedrock error logs are forwarded to a shared alert channel, so a failed request is described by
 * shape only. These pin that no prompt or reply text can reach the description.
 */

const SECRET_PROMPT = 'please update the sheet at https://docs.example.com/d/abc123 and remove the venue booking';
const SECRET_REPLY = 'I cannot edit that sheet from here yet';
const SECRET_SYSTEM = 'internal system instructions';

const BODY = JSON.stringify({
  anthropic_version: 'bedrock-2023-05-31',
  max_tokens: 128000,
  system: SECRET_SYSTEM,
  thinking: { type: 'adaptive' },
  tools: [{ name: 'search', description: 'x', input_schema: {} }],
  messages: [
    { role: 'user', content: SECRET_PROMPT },
    { role: 'assistant', content: [{ type: 'text', text: SECRET_REPLY }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: SECRET_PROMPT }] },
  ],
});

describe('describePayloadShape', () => {
  it('keeps structure and numeric config, drops every string value', () => {
    expect(describePayloadShape(BODY)).toEqual({
      bodyChars: BODY.length,
      parseable: true,
      fields: {
        anthropic_version: { chars: 'bedrock-2023-05-31'.length },
        max_tokens: 128000,
        system: { chars: SECRET_SYSTEM.length },
        thinking: { keys: 1 },
        tools: { items: 1 },
        messages: { items: 3 },
      },
      messageCount: 3,
      roles: 'user,assistant,user',
      lastMessageBlocks: ['tool_result'],
    });
  });

  it('describes a non-messages provider body (e.g. a single prompt string) without its text', () => {
    const body = JSON.stringify({ prompt: SECRET_PROMPT, max_gen_len: 512 });
    const shape = describePayloadShape(body);
    expect(shape.fields).toEqual({ prompt: { chars: SECRET_PROMPT.length }, max_gen_len: 512 });
    expect(JSON.stringify(shape)).not.toContain('venue');
  });

  it('reports only the size of an unparseable body', () => {
    expect(describePayloadShape(`not json ${SECRET_PROMPT}`)).toEqual({
      bodyChars: `not json ${SECRET_PROMPT}`.length,
      parseable: false,
    });
  });

  it('replaces an unrecognised role or block type with a placeholder', () => {
    const body = JSON.stringify({
      messages: [{ role: SECRET_PROMPT, content: [{ type: SECRET_REPLY }] }],
    });
    const shape = describePayloadShape(body);
    expect(shape.roles).toBe('?');
    expect(shape.lastMessageBlocks).toEqual(['?']);
    expect(JSON.stringify(shape)).not.toContain('venue');
  });

  it('keeps a server tool block type instead of collapsing it to a placeholder', () => {
    const body = JSON.stringify({
      messages: [
        { role: 'user', content: SECRET_PROMPT },
        { role: 'assistant', content: [{ type: 'server_tool_use', name: 'web_search' }] },
        { role: 'user', content: [{ type: 'web_search_tool_result' }] },
      ],
    });
    const shape = describePayloadShape(body);
    expect(shape.roles).toBe('user,assistant,user');
    expect(shape.lastMessageBlocks).toEqual(['web_search_tool_result']);
  });

  it('caps the top-level field list at 30', () => {
    const fields = Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`f${i}`, i]));
    const shape = describePayloadShape(JSON.stringify(fields));
    expect(Object.keys(shape.fields ?? {})).toHaveLength(30);
    expect(shape.fields?.f29).toBe(29);
    expect(shape.fields?.f30).toBeUndefined();
  });

  it('caps the role list to the tail of a long conversation', () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' }));
    messages[0].role = 'system';
    messages[49].role = 'tool';
    const shape = describePayloadShape(JSON.stringify({ messages }));
    expect(shape.messageCount).toBe(50);
    expect(shape.roles?.split(',')).toHaveLength(41);
    expect(shape.roles?.startsWith('...,')).toBe(true);
    expect(shape.roles?.endsWith(',tool')).toBe(true);
    expect(shape.roles?.split(',')).not.toContain('system');
  });

  it('lists all 40 roles without a truncation marker, and marks 41', () => {
    const roles = (n: number) => Array.from({ length: n }, (_, i) => ({ role: i === n - 1 ? 'tool' : 'user' }));

    const exact = describePayloadShape(JSON.stringify({ messages: roles(40) }));
    expect(exact.roles?.split(',')).toHaveLength(40);
    expect(exact.roles?.startsWith('...')).toBe(false);

    const over = describePayloadShape(JSON.stringify({ messages: roles(41) }));
    expect(over.roles?.split(',')).toHaveLength(41);
    expect(over.roles?.startsWith('...,')).toBe(true);
  });
});
