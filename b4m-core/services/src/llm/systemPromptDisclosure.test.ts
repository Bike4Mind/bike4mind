import type { IMessage } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { buildSystemPromptText, SYSTEM_PROMPT_TEXT_MAX_CHARS } from './systemPromptDisclosure';
import { buildTaggedContextMessages, PROMPT_SOURCE_METADATA } from './systemPromptSources';

const sys = (content: string): IMessage => ({ role: 'system' as const, content });
const user = (content: string): IMessage => ({ role: 'user' as const, content });

const blockNamed = (disclosure: ReturnType<typeof buildSystemPromptText>, name: string) =>
  disclosure.blocks.find(b => b.name === name);

describe('buildSystemPromptText', () => {
  it('returns the text of each contributing source, tagged with that source name and origin', () => {
    const tagged = buildTaggedContextMessages({
      dateContext: [sys('today is tuesday')],
      helpCenter: [sys('the help center exists')],
    });

    const { blocks } = buildSystemPromptText(tagged);

    expect(blocks).toEqual([
      { source: 'hardcoded', name: 'date_time_context', text: 'today is tuesday', redacted: false },
      { source: 'admin', name: 'help_center', text: 'the help center exists', redacted: false },
    ]);
  });

  it('emits rows in assembly order rather than the order the caller listed sources in', () => {
    const tagged = buildTaggedContextMessages({
      attachedFiles: [user('a file')],
      dateContext: [sys('today')],
    });

    expect(buildSystemPromptText(tagged).blocks.map(b => b.name)).toEqual(['date_time_context', 'attached_files']);
  });

  it('joins the messages a single source contributed into one block', () => {
    const tagged = buildTaggedContextMessages({ mementos: [sys('first'), sys('second')] });

    expect(blockNamed(buildSystemPromptText(tagged), 'mementos')?.text).toBe('first\n\nsecond');
  });

  it('reports nothing for a source that contributed no messages', () => {
    const tagged = buildTaggedContextMessages({ dateContext: [sys('today')], mementos: [] });

    expect(buildSystemPromptText(tagged).blocks.map(b => b.name)).toEqual(['date_time_context']);
  });

  it('withholds the text of the server-owned session prompt while still reporting it', () => {
    const tagged = buildTaggedContextMessages({
      sessionPrompt: [sys('proprietary surface prompt')],
      dateContext: [sys('today')],
    });

    const sessionBlock = blockNamed(buildSystemPromptText(tagged), 'session_prompt');
    expect(sessionBlock).toEqual({ source: 'session', name: 'session_prompt', redacted: true });
    expect(JSON.stringify(buildSystemPromptText(tagged))).not.toContain('proprietary');
  });

  it('discloses caller-supplied extra context, which is the caller own content coming back', () => {
    const tagged = buildTaggedContextMessages({ extraContext: [sys('slack thread')] });

    expect(blockNamed(buildSystemPromptText(tagged), 'extra_context')?.text).toBe('slack thread');
  });

  it('returns no text for a system source the budget dropped, rather than claiming the model saw it', () => {
    const kept = sys('today');
    const dropped = sys('memory');
    const tagged = buildTaggedContextMessages({ dateContext: [kept], mementos: [dropped] });

    const { blocks } = buildSystemPromptText(tagged, new Set([kept]));

    // The row survives so the payload still joins to the breakdown, which is where wasIncluded lives.
    expect(blocks.map(b => b.name)).toEqual(['date_time_context', 'mementos']);
    expect(blockNamed({ blocks, sizeCapped: false }, 'mementos')).toEqual({
      source: 'user',
      name: 'mementos',
      redacted: false,
    });
  });

  it('discloses only the surviving messages when a source partially survived', () => {
    const kept = sys('first');
    const dropped = sys('second');
    const tagged = buildTaggedContextMessages({ mementos: [kept, dropped] });

    expect(blockNamed(buildSystemPromptText(tagged, new Set([kept])), 'mementos')?.text).toBe('first');
  });

  it('discloses a user-role source even when absent from the delivered set, since it is rebuilt not dropped', () => {
    // processMessages returns a fresh object for a truncated file, so identity cannot distinguish
    // "shortened" from "never sent" - see the same caveat in toPromptDetails.
    const attached = user('file body');
    const tagged = buildTaggedContextMessages({ attachedFiles: [attached] });

    expect(blockNamed(buildSystemPromptText(tagged, new Set<IMessage>()), 'attached_files')?.text).toBe('file body');
  });

  it('treats every contributing source as delivered when no payload is supplied', () => {
    const tagged = buildTaggedContextMessages({ dateContext: [sys('today')], mementos: [sys('memory')] });

    expect(buildSystemPromptText(tagged).blocks.map(b => b.name)).toEqual(['date_time_context', 'mementos']);
  });

  it('reports a multimodal-only source as unredacted, since no text is being withheld', () => {
    const image: IMessage = { role: 'user' as const, content: [{ type: 'image_url', image_url: { url: 'x' } }] as never };
    const tagged = buildTaggedContextMessages({ recentImages: [image] });

    expect(blockNamed(buildSystemPromptText(tagged), 'recent_images')).toEqual({
      source: 'hardcoded',
      name: 'recent_images',
      redacted: false,
    });
  });

  it('caps total disclosed text, keeping the row and flagging the disclosure', () => {
    const tagged = buildTaggedContextMessages({
      dateContext: [sys('a'.repeat(30))],
      mementos: [sys('b'.repeat(30))],
    });

    const disclosure = buildSystemPromptText(tagged, undefined, 40);

    expect(disclosure.sizeCapped).toBe(true);
    expect(blockNamed(disclosure, 'date_time_context')?.text).toBe('a'.repeat(30));
    expect(blockNamed(disclosure, 'mementos')).toEqual({ source: 'user', name: 'mementos', redacted: true });
  });

  it('does not flag a disclosure that fit inside the cap', () => {
    const tagged = buildTaggedContextMessages({ dateContext: [sys('short')] });

    expect(buildSystemPromptText(tagged).sizeCapped).toBe(false);
    expect(SYSTEM_PROMPT_TEXT_MAX_CHARS).toBeGreaterThan(0);
  });

  it('names every source the way the breakdown does, so the two can be joined', () => {
    const everySource = Object.keys(PROMPT_SOURCE_METADATA) as (keyof typeof PROMPT_SOURCE_METADATA)[];
    const tagged = buildTaggedContextMessages(
      Object.fromEntries(everySource.map(source => [source, [sys(`text for ${source}`)]]))
    );

    const { blocks } = buildSystemPromptText(tagged);

    expect(blocks.map(b => b.name).sort()).toEqual(everySource.map(s => PROMPT_SOURCE_METADATA[s].name).sort());
    for (const block of blocks) {
      expect(block.source).toBe(
        PROMPT_SOURCE_METADATA[everySource.find(s => PROMPT_SOURCE_METADATA[s].name === block.name)!].origin
      );
    }
  });
});
