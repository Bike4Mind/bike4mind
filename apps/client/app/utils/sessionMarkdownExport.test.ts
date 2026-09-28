import { describe, it, expect } from 'vitest';
import type { IChatHistoryItemDocument } from '@bike4mind/common';
import { convertSessionToMarkdown } from './sessionMarkdownExport';

const quest = (prompt: string, replies: string[]) => ({ prompt, replies }) as unknown as IChatHistoryItemDocument;

/**
 * Copy-session-as-markdown reads the same persisted `replies` array the transcript renders
 * from, so it has to apply the same visibility rule. Walking the slots raw put one `**AI:**`
 * heading on every slot, and a think-only slot is truthy - so a tool-using turn produced
 * blank headings and pasted the model's reasoning into the user's clipboard.
 */
describe('convertSessionToMarkdown', () => {
  it('writes one AI entry per turn for a tool-loop turn, with no thinking text', () => {
    const markdown = convertSessionToMarkdown([
      quest('search for it', [
        '<think>first reasoning</think>',
        'PARTIAL ANSWER <think>second reasoning</think>FINAL ANSWER',
      ]),
    ]);

    expect(markdown).toContain('**AI:** PARTIAL ANSWER FINAL ANSWER');
    expect(markdown.match(/\*\*AI:\*\*/g)).toHaveLength(1);
    expect(markdown).not.toContain('reasoning');
    expect(markdown).not.toContain('<think>');
  });

  it('omits the AI entry entirely when a turn produced only thinking', () => {
    const markdown = convertSessionToMarkdown([quest('a question', ['<think>reasoning with no answer</think>'])]);

    expect(markdown).toContain('**User:** a question');
    expect(markdown).not.toContain('**AI:**');
  });

  it('still falls back to the legacy single reply field', () => {
    const legacy = { prompt: 'hi', reply: 'hello' } as unknown as IChatHistoryItemDocument;

    expect(convertSessionToMarkdown([legacy])).toContain('**AI:** hello');
  });
});
