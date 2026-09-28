// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { ContextTelemetry, AnomaliesTelemetry } from '@bike4mind/common';
import { buildAnalysisPrompt, extractAnalysisJson, formatIssueBody, type LLMAnalysis } from './telemetryAnalysis';
import {
  GROWTH_RATIO_CEILING,
  SMALL_INPUT_MS_CEILING,
  measureGrowth,
  seededCorpus,
  FENCE_PIECES,
} from '@client/__tests__/utils/regexLinearity';

function createTestTelemetry(overrides: { anomalies?: Partial<AnomaliesTelemetry> } = {}): ContextTelemetry {
  const defaultAnomalies: AnomaliesTelemetry = {
    contextOverflow: false,
    highUtilization: false,
    criticalUtilization: false,
    highTruncation: false,
    criticalTruncation: false,
    toolFailureSpike: false,
    toolTimeout: false,
    subagentTimeout: false,
    slowFirstToken: false,
    slowTotalResponse: false,
    anomalyScore: 30,
    severity: 'medium',
    dedupKey: 'test-key',
    primaryAnomaly: 'slow_response',
  };

  return {
    schemaVersion: '1.0',
    timestamp: new Date().toISOString(),
    captureOverheadMs: 10,
    anonymousSessionId: { hash: 'test-hash', dateKey: '2025-01-01' },
    operation: { name: 'chat_completion' },
    model: {
      modelId: 'claude-3-5-sonnet-20241022',
      provider: 'anthropic',
      fallbackUsed: false,
      usedThinking: false,
      usedTools: false,
    },
    contextWindow: {
      inputTokens: 1000,
      outputTokens: 500,
      contextWindowLimit: 200000,
      utilizationPercentage: 0.5,
      reservedOutputTokens: 8000,
      overflowDetected: false,
      tokensBySource: {
        systemPrompts: 100,
        conversationHistory: 400,
        mementos: 100,
        fabFiles: 100,
        urlContent: 100,
        toolSchemas: 100,
        userPrompt: 100,
      },
    },
    costs: {
      inputCostUsd: 0.01,
      outputCostUsd: 0.02,
      totalCostUsd: 0.03,
      creditsUsed: 1,
    },
    performance: {
      totalResponseTimeMs: 5000,
    },
    anomalies: { ...defaultAnomalies, ...overrides.anomalies },
    tools: [],
    subagents: [],
  };
}

describe('formatIssueBody', () => {
  it('escapes LLM analysis text written into the issue body', () => {
    const telemetry = createTestTelemetry();
    const analysis: LLMAnalysis = {
      summary: 'see [x](https://example.invalid) and @org/team <img>',
      rootCause: 'caused by `unstable_fn` and *retries*',
      findings: ['finding with <img src=x> and @someone'],
      recommendations: ['recommend [click](https://example.invalid)'],
      correlations: ['correlated with @another/team'],
      estimatedImpact: 'impact is *severe* with `code`',
    };

    const body = formatIssueBody(telemetry, { analysis });
    const zwsp = '\u200B';

    // Escaped forms are present.
    expect(body).toContain('\\[x\\](https://example.invalid)');
    expect(body).toContain('&lt;img&gt;');
    expect(body).toContain(`@${zwsp}org/team`);
    expect(body).toContain('\\`unstable\\_fn\\`');
    expect(body).toContain('\\*retries\\*');
    expect(body).toContain('&lt;img src=x&gt;');
    expect(body).toContain(`@${zwsp}someone`);
    expect(body).toContain('\\[click\\](https://example.invalid)');
    expect(body).toContain(`@${zwsp}another/team`);
    expect(body).toContain('\\*severe\\*');
    expect(body).toContain('\\`code\\`');

    // Raw, unescaped active markdown must not survive.
    expect(body).not.toContain('[x](');
    expect(body).not.toContain('<img>');
    expect(body).not.toContain('<img src=x>');
    expect(body).not.toContain('[click](');
    expect(body).not.toContain('@org/team');
    expect(body).not.toContain('@someone');
    expect(body).not.toContain('@another/team');
  });

  it('omits the lake row for a turn that never recorded the bucket', () => {
    const body = formatIssueBody(createTestTelemetry(), { includeTokenBreakdown: true });

    expect(body).toContain('| System Prompts |');
    expect(body).not.toContain('Lake Retrieval');
  });

  it('reports a recorded lake volume as its own row', () => {
    const telemetry = createTestTelemetry();
    telemetry.contextWindow.tokensBySource!.lakeRetrieval = 250;

    const body = formatIssueBody(telemetry, { includeTokenBreakdown: true });

    expect(body).toContain('| Lake Retrieval | 250 | 25.0% |');
  });

  it('keeps the lake row for a measured zero, unlike buckets that are merely empty', () => {
    const telemetry = createTestTelemetry();
    telemetry.contextWindow.tokensBySource!.lakeRetrieval = 0;
    telemetry.contextWindow.tokensBySource!.urlContent = 0;

    const body = formatIssueBody(telemetry, { includeTokenBreakdown: true });

    expect(body).toContain('| Lake Retrieval | 0 | 0.0% |');
    expect(body).not.toContain('URL Content');
  });
});

describe('buildAnalysisPrompt token distribution', () => {
  it('leaves the lake line out when the bucket is unrecorded', () => {
    const prompt = buildAnalysisPrompt(createTestTelemetry());

    expect(prompt).toContain('- User Prompt: 100');
    expect(prompt).not.toContain('Lake Retrieval');
  });

  it('includes the lake line when the bucket was recorded, zero included', () => {
    const telemetry = createTestTelemetry();
    telemetry.contextWindow.tokensBySource!.lakeRetrieval = 0;

    const prompt = buildAnalysisPrompt(telemetry);

    expect(prompt).toContain('- Lake Retrieval: 0 (0.0%)');
  });
});

describe('extractAnalysisJson', () => {
  function oldExtract(responseText: string): string {
    let jsonStr = responseText.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) return jsonMatch[1].trim();
    const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (braceMatch) jsonStr = braceMatch[0];
    return jsonStr;
  }

  it('unwraps a fence, else slices the outermost braces', () => {
    expect(extractAnalysisJson('```json\n {"a":1}\n```')).toBe('{"a":1}');
    expect(extractAnalysisJson('Sure: {"a":{"b":2}} done')).toBe('{"a":{"b":2}}');
    expect(extractAnalysisJson('  } no object {  ')).toBe('} no object {');
  });

  // The old fence regex took about 1-2s at 16000; the old brace fallback about 3s on 16000 '{'.
  it.each([
    ['newlines after an unclosed fence', (n: number) => '```json' + '\n'.repeat(n) + 'x', 16000],
    ['space-newline pairs after an unclosed fence', (n: number) => '```json' + ' \n'.repeat(n) + 'x', 16000],
    ['many unclosed braces', (n: number) => '{'.repeat(n), 16000],
  ])('stays linear on %s', (_label, build, small) => {
    const { baselineMs, ratio } = measureGrowth(extractAnalysisJson, build, small);
    expect(baselineMs).toBeLessThan(SMALL_INPUT_MS_CEILING);
    expect(ratio).toBeLessThan(GROWTH_RATIO_CEILING);
  });

  it('returns what the old extraction returned on every seeded input', () => {
    const corpus = seededCorpus(2998, 3000, [...FENCE_PIECES, '{', '}']);
    expect(corpus.filter(s => s.includes('```') && s.indexOf('```') !== s.lastIndexOf('```')).length).toBeGreaterThan(
      300
    );
    expect(corpus.filter(s => extractAnalysisJson(s) !== oldExtract(s))).toEqual([]);
    // Control: a lazy brace slice diverges, so this differential can fail.
    const lazy = (s: string) => s.trim().match(/\{[\s\S]*?\}/)?.[0] ?? s.trim();
    expect(corpus.filter(s => !s.includes('```') && lazy(s) !== oldExtract(s)).length).toBeGreaterThan(0);
  });
});
