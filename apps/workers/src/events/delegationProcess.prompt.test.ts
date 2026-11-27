import { describe, expect, it } from 'vitest';
import { DELEGATION_LIMITS } from '@bike4mind/common';
import { buildDelegationPrompt, parseDelegationReply, type DelegationContent } from './delegationProcess.prompt';

const empty: DelegationContent = { url: null, page: null, text: null, files: [] };

describe('buildDelegationPrompt', () => {
  it('fences every kind of shared content and quotes the intent', () => {
    const prompt = buildDelegationPrompt(
      'Summarize for the team',
      {
        url: 'https://example.com/r',
        page: 'Q3 is up.',
        text: 'shared words',
        files: [{ name: 'deck.pdf', body: 'slide text' }],
      },
      'f3nc3'
    );
    expect(prompt).toContain('"Summarize for the team"');
    expect(prompt).toContain('<shared-f3nc3>\nLink: https://example.com/r\n\nPage text:\nQ3 is up.');
    expect(prompt).toContain('Shared text:\nshared words');
    expect(prompt).toContain('File "deck.pdf":\nslide text\n</shared-f3nc3>');
  });

  it('says when a link could not be read and when nothing readable was shared', () => {
    expect(buildDelegationPrompt('read', { ...empty, url: 'https://example.com' })).toContain(
      '(the page could not be read)'
    );
    expect(buildDelegationPrompt('read', empty)).toContain('(nothing readable was shared)');
  });

  it('uses a fresh fence per call', () => {
    const fence = (prompt: string) => /<shared-([0-9a-f]+)>/.exec(prompt)?.[1];
    expect(fence(buildDelegationPrompt('read', empty))).not.toBe(fence(buildDelegationPrompt('read', empty)));
  });
});

describe('parseDelegationReply', () => {
  it('reads an outcome wrapped in prose', () => {
    expect(
      parseDelegationReply('Sure: {"outcome": "needs_decision", "result": " Approve the $40 quote? "} done')
    ).toEqual({ status: 'needs_decision', result: 'Approve the $40 quote?' });
  });

  it('clips a long result to the stored cap', () => {
    const { result } = parseDelegationReply(JSON.stringify({ outcome: 'handled', result: 'x'.repeat(1000) }));
    expect(result).toHaveLength(DELEGATION_LIMITS.result);
    expect(result.endsWith('...')).toBe(true);
  });

  it('never cuts an emoji in half when it clips', () => {
    const head = 'x'.repeat(DELEGATION_LIMITS.result - 4);
    const { result } = parseDelegationReply(
      JSON.stringify({ outcome: 'handled', result: `${head}${'\u{1F600}'.repeat(200)}` })
    );
    expect(result).toBe(`${head}...`);
  });

  it.each([
    ['no JSON object', 'I could not do it'],
    ['an unknown outcome', '{"outcome": "ignored", "result": "x"}'],
    ['an empty result', '{"outcome": "handled", "result": "  "}'],
  ])('throws on %s', (_label, reply) => {
    expect(() => parseDelegationReply(reply)).toThrow();
  });
});
