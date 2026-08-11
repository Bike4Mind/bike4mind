import { describe, expect, it } from 'vitest';
import type { IMessage } from '@bike4mind/common';
import { buildSystemPromptDisclosure, stripDisclosureText, type SystemPromptBlockSpec } from './systemPromptDisclosure';

const sys = (content: string): IMessage => ({ role: 'system', content }) as IMessage;

// One token per character keeps the assertions about which block got counted, not about tokenizing.
const countTokens = async (messages: IMessage[]) =>
  messages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0);

const build = (specs: SystemPromptBlockSpec[], sentMessages: IMessage[], withText = true, maxTextChars?: number) =>
  buildSystemPromptDisclosure({ specs, sentMessages, countTokens, withText, ...(maxTextChars && { maxTextChars }) });

describe('buildSystemPromptDisclosure', () => {
  it('itemizes each non-empty block with its text and token cost', async () => {
    const specs: SystemPromptBlockSpec[] = [
      { source: 'hardcoded', name: 'date_time_context', messages: [sys('today')] },
      { source: 'admin', name: 'tool_guidance', messages: [sys('use tools')] },
    ];

    const disclosure = await build(specs, [sys('today'), sys('use tools')]);

    expect(disclosure.blocks).toEqual([
      {
        source: 'hardcoded',
        name: 'date_time_context',
        tokenCount: 5,
        wasIncluded: true,
        redacted: false,
        text: 'today',
      },
      { source: 'admin', name: 'tool_guidance', tokenCount: 9, wasIncluded: true, redacted: false, text: 'use tools' },
    ]);
    expect(disclosure.totalTokens).toBe(14);
    expect(disclosure.sizeCapped).toBe(false);
  });

  it('omits blocks that contributed no messages', async () => {
    const specs: SystemPromptBlockSpec[] = [
      { source: 'org', name: 'organization_prompt', messages: [] },
      { source: 'project', name: 'project_context', messages: [sys('project')] },
    ];

    const disclosure = await build(specs, [sys('project')]);

    expect(disclosure.blocks.map(b => b.name)).toEqual(['project_context']);
  });

  it('reports a block that was assembled but dropped before the request', async () => {
    const specs: SystemPromptBlockSpec[] = [
      { source: 'user', name: 'mementos', messages: [sys('a memento')] },
      { source: 'user', name: 'attached_files', messages: [sys('a big file')] },
    ];

    const disclosure = await build(specs, [sys('a memento')]);

    expect(disclosure.blocks.map(b => [b.name, b.wasIncluded])).toEqual([
      ['mementos', true],
      ['attached_files', false],
    ]);
    // Dropped blocks still disclose their text - what the caller needs is to see WHAT was cut.
    expect(disclosure.blocks[1].text).toBe('a big file');
  });

  it('withholds server-owned text while still reporting presence and cost', async () => {
    const specs: SystemPromptBlockSpec[] = [
      { source: 'session', name: 'session_prompt', messages: [sys('proprietary')], serverOwned: true },
    ];

    const disclosure = await build(specs, [sys('proprietary')]);

    expect(disclosure.blocks[0]).toEqual({
      source: 'session',
      name: 'session_prompt',
      tokenCount: 11,
      wasIncluded: true,
      redacted: true,
    });
  });

  it('withholds every text when withText is false', async () => {
    const specs: SystemPromptBlockSpec[] = [{ source: 'admin', name: 'help_center', messages: [sys('help')] }];

    const disclosure = await build(specs, [sys('help')], false);

    expect(disclosure.blocks[0].text).toBeUndefined();
    expect(disclosure.blocks[0].redacted).toBe(true);
    expect(disclosure.blocks[0].tokenCount).toBe(4);
  });

  it('caps total disclosed text and flags it, keeping later metadata intact', async () => {
    const specs: SystemPromptBlockSpec[] = [
      { source: 'admin', name: 'first', messages: [sys('12345')] },
      { source: 'admin', name: 'second', messages: [sys('67890')] },
    ];

    const disclosure = await build(specs, [sys('12345'), sys('67890')], true, 5);

    expect(disclosure.sizeCapped).toBe(true);
    expect(disclosure.blocks[0].text).toBe('12345');
    expect(disclosure.blocks[1]).toEqual({
      source: 'admin',
      name: 'second',
      tokenCount: 5,
      wasIncluded: true,
      redacted: true,
    });
  });

  it('joins a multi-message block into one text', async () => {
    const specs: SystemPromptBlockSpec[] = [{ source: 'user', name: 'mementos', messages: [sys('one'), sys('two')] }];

    const disclosure = await build(specs, [sys('one'), sys('two')]);

    expect(disclosure.blocks[0].text).toBe('one\n\ntwo');
  });

  it('treats a multimodal-only block as having no text rather than as withheld', async () => {
    const image = { role: 'system', content: [{ type: 'image' }] } as unknown as IMessage;
    const specs: SystemPromptBlockSpec[] = [{ source: 'user', name: 'attached_files', messages: [image] }];

    const disclosure = await build(specs, [image]);

    expect(disclosure.blocks[0]).toEqual({
      source: 'user',
      name: 'attached_files',
      tokenCount: 0,
      wasIncluded: true,
      redacted: false,
    });
  });
});

describe('stripDisclosureText', () => {
  it('removes every text and marks the blocks redacted', async () => {
    const specs: SystemPromptBlockSpec[] = [
      { source: 'admin', name: 'tool_guidance', messages: [sys('use tools')] },
      { source: 'session', name: 'session_prompt', messages: [sys('proprietary')], serverOwned: true },
    ];
    const disclosure = await build(specs, [sys('use tools'), sys('proprietary')]);

    const stripped = stripDisclosureText(disclosure);

    expect(stripped.blocks.every(b => b.text === undefined && b.redacted)).toBe(true);
    expect(stripped.totalTokens).toBe(disclosure.totalTokens);
    // The input must survive - the caller-facing copy is built from it afterwards.
    expect(disclosure.blocks[0].text).toBe('use tools');
  });
});
