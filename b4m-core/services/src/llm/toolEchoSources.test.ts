import { describe, it, expect } from 'vitest';
import { TOOL_RESULT_TRUNCATION_NOTICE } from '@bike4mind/llm-adapters';
import { buildToolEchoSources, MAX_TOOL_ECHO_HAYSTACK_CHARS } from './toolEchoSources';

describe('buildToolEchoSources', () => {
  it('returns nothing for an empty array', () => {
    expect(buildToolEchoSources([])).toEqual([]);
  });

  it('skips artifact-emitting tools and empty or missing values', () => {
    expect(
      buildToolEchoSources([
        { name: 'mermaid_chart', returnValue: 'graph TD; A-->B', fullReturnValue: 'graph TD; A-->B' },
        { name: 'web_fetch', returnValue: '' },
        { name: 'web_search' },
      ])
    ).toEqual([]);
  });

  it('prefers the untruncated fullReturnValue', () => {
    expect(
      buildToolEchoSources([
        { name: 'web_fetch', returnValue: `abc${TOOL_RESULT_TRUNCATION_NOTICE}`, fullReturnValue: 'abcdef' },
      ])
    ).toEqual([{ text: 'abcdef', truncated: false }]);
  });

  it('falls back to returnValue, dropping the truncation notice and flagging it truncated', () => {
    expect(
      buildToolEchoSources([
        { name: 'web_fetch', returnValue: `abc${TOOL_RESULT_TRUNCATION_NOTICE}` },
        { name: 'file_read', returnValue: 'whole' },
      ])
    ).toEqual([
      { text: 'abc', truncated: true },
      { text: 'whole', truncated: false },
    ]);
  });

  it('strips the web_fetch window marker from the tail', () => {
    const marker =
      '\n\n[web_fetch: showing chars 0-50000 of ~90000. More content remains - call web_fetch again with the same url and offset=50000 to continue.]';
    expect(buildToolEchoSources([{ name: 'web_fetch', fullReturnValue: `page body${marker}` }])).toEqual([
      { text: 'page body', truncated: false },
    ]);
  });

  it('caps the total haystack and marks the cut source truncated', () => {
    const big = 'a'.repeat(MAX_TOOL_ECHO_HAYSTACK_CHARS - 10);
    const sources = buildToolEchoSources([
      { name: 'web_fetch', fullReturnValue: big },
      { name: 'web_fetch', fullReturnValue: 'b'.repeat(100) },
      { name: 'web_fetch', fullReturnValue: 'never reached' },
    ]);
    expect(sources).toEqual([
      { text: big, truncated: false },
      { text: 'b'.repeat(10), truncated: true },
    ]);
  });
});
