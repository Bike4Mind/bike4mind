import { describe, it, expect } from 'vitest';
import {
  generateExecutiveSummaryMarkdown,
  parseConsolidatedNarrative,
  SUMMARY_DELIMITER,
  INSIGHTS_DELIMITER,
  DECISIONS_DELIMITER,
  type LLMContext,
} from './llmMarkdownGenerator';

const delimitedResponse = [
  SUMMARY_DELIMITER,
  'This conversation designed a caching layer.',
  INSIGHTS_DELIMITER,
  '- **Caching**: keyed on a content hash',
  DECISIONS_DELIMITER,
  '### Decisions Made\n- Use sha256\n### Action Items\n- Ship it',
].join('\n');

/** An LLMContext that records every prompt and returns a canned reply. */
function makeRecordingLLM(reply: string): { llm: LLMContext; prompts: string[] } {
  const prompts: string[] = [];
  const llm: LLMContext = {
    complete: async (_model, messages, _options, callback) => {
      prompts.push(messages[0].content);
      await callback([reply]);
    },
  };
  return { llm, prompts };
}

const session = { id: 's1', name: 'Test Session', firstCreated: new Date(0), lastUpdated: new Date(0) };
const messages = [
  { id: 'm1', prompt: 'How do I cache?', reply: 'Use a content hash.' },
  { id: 'm2', prompt: 'What algorithm?', reply: 'sha256.' },
];

describe('generateExecutiveSummaryMarkdown - consolidated single call', () => {
  it('makes ONE narrative LLM call (no artifacts) and splits the three sections', async () => {
    const { llm, prompts } = makeRecordingLLM(delimitedResponse);

    const { markdown, tokenUsage } = await generateExecutiveSummaryMarkdown(session, messages, [], llm, 'gpt-test');

    // Previously this path issued 3 separate calls each re-embedding the sample.
    expect(prompts).toHaveLength(1);
    // The single prompt carries the conversation sample exactly once.
    expect(prompts[0]).toContain('How do I cache?');

    expect(markdown).toContain('## Executive Summary');
    expect(markdown).toContain('This conversation designed a caching layer.');
    expect(markdown).toContain('## Key Insights');
    expect(markdown).toContain('- **Caching**: keyed on a content hash');
    expect(markdown).toContain('## Decisions & Actions');
    expect(markdown).toContain('### Action Items');

    expect(tokenUsage.inputTokens).toBeGreaterThan(0);
    expect(tokenUsage.outputTokens).toBeGreaterThan(0);
    expect(tokenUsage.totalTokens).toBe(tokenUsage.inputTokens + tokenUsage.outputTokens);
  });

  it('adds exactly one more call for artifact descriptions when artifacts exist', async () => {
    const { llm, prompts } = makeRecordingLLM(delimitedResponse);
    const artifacts = [
      { type: 'code' as any, content: 'const a = 1;', language: 'ts', messageId: 'm1', timestamp: new Date(0) },
    ];

    await generateExecutiveSummaryMarkdown(session, messages, artifacts, llm, 'gpt-test');

    // 1 narrative call + 1 batched artifact-description call = 2 total.
    expect(prompts).toHaveLength(2);
  });
});

describe('parseConsolidatedNarrative', () => {
  it('splits a well-formed delimited response into three sections', () => {
    const parsed = parseConsolidatedNarrative(delimitedResponse);
    expect(parsed.summary).toBe('This conversation designed a caching layer.');
    expect(parsed.insights).toBe('- **Caching**: keyed on a content hash');
    expect(parsed.decisions).toContain('### Decisions Made');
    expect(parsed.decisions).toContain('### Action Items');
  });

  it('falls back to putting the whole response in summary when delimiters are absent', () => {
    const parsed = parseConsolidatedNarrative('The model ignored the format entirely.');
    expect(parsed.summary).toBe('The model ignored the format entirely.');
    expect(parsed.insights).toBe('');
    expect(parsed.decisions).toBe('');
  });

  it('handles a missing middle section without swallowing the last', () => {
    const text = [SUMMARY_DELIMITER, 'Summary only.', DECISIONS_DELIMITER, 'Decision text.'].join('\n');
    const parsed = parseConsolidatedNarrative(text);
    expect(parsed.summary).toBe('Summary only.');
    expect(parsed.insights).toBe('');
    expect(parsed.decisions).toBe('Decision text.');
  });

  it('handles delimiters emitted out of order without collapsing sections', () => {
    const text = [
      DECISIONS_DELIMITER,
      'Decision first.',
      SUMMARY_DELIMITER,
      'Summary second.',
      INSIGHTS_DELIMITER,
      '- insight third',
    ].join('\n');
    const parsed = parseConsolidatedNarrative(text);
    expect(parsed.decisions).toBe('Decision first.');
    expect(parsed.summary).toBe('Summary second.');
    expect(parsed.insights).toBe('- insight third');
  });

  it('does not split on a delimiter echoed inline inside a section body', () => {
    const text = [
      SUMMARY_DELIMITER,
      `We considered using ${INSIGHTS_DELIMITER} as an inline marker but rejected it.`,
      INSIGHTS_DELIMITER,
      '- the real insight',
    ].join('\n');
    const parsed = parseConsolidatedNarrative(text);
    // The inline echo stays in the summary; only the line-anchored delimiter splits.
    expect(parsed.summary).toContain('rejected it.');
    expect(parsed.insights).toBe('- the real insight');
  });
});
