import { describe, it, expect } from 'vitest';
import {
  TOOL_RESULT_TRUNCATION_NOTICE,
  MAX_FULL_TOOL_RESULT_CHARS,
  attachFullToolResult,
} from '@bike4mind/llm-adapters';
import { buildToolEchoSources, buildToolEchoSourcesFromSteps, MAX_TOOL_ECHO_HAYSTACK_CHARS } from './toolEchoSources';
import type { ToolsUsedEntry } from './toolsUsedToFunctionCalls';

function withFull(entry: ToolsUsedEntry, observation: string): ToolsUsedEntry {
  attachFullToolResult(entry, observation);
  return entry;
}

describe('buildToolEchoSources', () => {
  it('returns nothing for an empty array', () => {
    expect(buildToolEchoSources([])).toEqual([]);
  });

  it('counts only web tools, so the user own content and artifact emitters still promote', () => {
    expect(
      buildToolEchoSources([
        { name: 'retrieve_knowledge_content', returnValue: 'kb doc' },
        { name: 'file_read', returnValue: 'file body' },
        { name: 'mermaid_chart', returnValue: 'graph TD; A-->B' },
        { name: 'web_search', returnValue: 'search hit' },
        { name: 'web_fetch', returnValue: 'page' },
        { name: 'deep_research', returnValue: 'scraped findings' },
      ])
    ).toEqual([
      { text: 'search hit', truncated: false },
      { text: 'page', truncated: false },
      { text: 'scraped findings', truncated: false },
    ]);
  });

  it('skips artifact-emitting tools and empty or missing values', () => {
    expect(
      buildToolEchoSources([
        withFull({ name: 'mermaid_chart', returnValue: 'graph TD; A-->B' }, 'graph TD; A-->B'),
        { name: 'web_fetch', returnValue: '' },
        { name: 'web_search' },
      ])
    ).toEqual([]);
  });

  it('prefers the untruncated full result', () => {
    expect(
      buildToolEchoSources([
        withFull({ name: 'web_fetch', returnValue: `abc${TOOL_RESULT_TRUNCATION_NOTICE}` }, 'abcdef'),
      ])
    ).toEqual([{ text: 'abcdef', truncated: false }]);
  });

  it('flags a full result that was cut at its cap as truncated', () => {
    const huge = 'z'.repeat(MAX_FULL_TOOL_RESULT_CHARS + 5);
    expect(buildToolEchoSources([withFull({ name: 'web_fetch' }, huge)])).toEqual([
      { text: huge.slice(0, MAX_FULL_TOOL_RESULT_CHARS), truncated: true },
    ]);
  });

  it('falls back to returnValue, dropping the truncation notice and flagging it truncated', () => {
    expect(
      buildToolEchoSources([
        { name: 'web_fetch', returnValue: `abc${TOOL_RESULT_TRUNCATION_NOTICE}` },
        { name: 'web_search', returnValue: 'whole' },
      ])
    ).toEqual([
      { text: 'abc', truncated: true },
      { text: 'whole', truncated: false },
    ]);
  });

  it('strips the web_fetch window marker from the tail', () => {
    const marker =
      '\n\n[web_fetch: showing chars 0-50000 of ~90000. More content remains - call web_fetch again with the same url and offset=50000 to continue.]';
    expect(buildToolEchoSources([withFull({ name: 'web_fetch' }, `page body${marker}`)])).toEqual([
      { text: 'page body', truncated: false },
    ]);
  });

  it('caps the total haystack and marks the cut source truncated', () => {
    const big = 'a'.repeat(MAX_TOOL_ECHO_HAYSTACK_CHARS - 10);
    const sources = buildToolEchoSources([
      { name: 'web_fetch', returnValue: big },
      { name: 'web_fetch', returnValue: 'b'.repeat(100) },
      { name: 'web_fetch', returnValue: 'never reached' },
    ]);
    expect(sources).toEqual([
      { text: big, truncated: false },
      { text: 'b'.repeat(10), truncated: true },
    ]);
  });
});

describe('buildToolEchoSourcesFromSteps', () => {
  it('reads web tool observation steps and ignores every other step', () => {
    expect(
      buildToolEchoSourcesFromSteps([
        { type: 'thought', content: 'thinking' },
        { type: 'action', content: 'web_fetch', metadata: { toolName: 'web_fetch' } },
        { type: 'observation', content: 'page body', metadata: { toolName: 'web_fetch' } },
        { type: 'observation', content: 'kb doc', metadata: { toolName: 'retrieve_knowledge_content' } },
        { type: 'observation', content: 'no name' },
        { type: 'observation', content: 42, metadata: { toolName: 'web_search' } },
        null,
        'junk',
      ])
    ).toEqual([{ text: 'page body', truncated: false }]);
  });

  it('flags an observation the adapter truncated', () => {
    expect(
      buildToolEchoSourcesFromSteps([
        { type: 'observation', content: `abc${TOOL_RESULT_TRUNCATION_NOTICE}`, metadata: { toolName: 'web_search' } },
      ])
    ).toEqual([{ text: 'abc', truncated: true }]);
  });

  it('returns nothing for a missing or non-array steps value', () => {
    expect(buildToolEchoSourcesFromSteps(undefined)).toEqual([]);
    expect(buildToolEchoSourcesFromSteps({ steps: [] })).toEqual([]);
  });
});
