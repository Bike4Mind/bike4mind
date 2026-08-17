/**
 * Model driver for the abstention eval. Sends each case to a real model with the production
 * abstention block as its only system message, then grades the reply with the deterministic grader.
 *
 * The driver is deliberately a bare `fetch` against an OpenAI-compatible `/chat/completions` endpoint
 * rather than one of our adapters: this eval must pin what the PROMPT does, so the fewer layers
 * between the block and the model the better, and any provider (Ollama, an OpenAI-compatible gateway,
 * a Bedrock proxy) can be pointed at it without new credentials plumbing.
 *
 * Not run in CI - it needs a live endpoint and prompt behaviour is not a green/red gate. See README.
 */

import { forcedRetrievalNoContextPrompt } from '../../forcedRetrievalAbstention';
import { ABSTENTION_CASES, type AbstentionCase } from './cases';
import { gradeMustHedge, gradeMustNotMentionCoverage, type GradeResult } from './grade';

export interface AbstentionEvalConfig {
  /** Base URL of an OpenAI-compatible endpoint, e.g. `http://localhost:11434/v1`. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Repeats per case. Prompt behaviour is stochastic; one sample per case reads noise as signal. */
  samples?: number;
}

export interface AbstentionCaseResult {
  caseId: string;
  finding: string;
  /** One entry per sample, in order. */
  samples: (GradeResult & { reply: string })[];
  passRate: number;
}

async function complete(config: AbstentionEvalConfig, evalCase: AbstentionCase): Promise<string> {
  const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: forcedRetrievalNoContextPrompt(evalCase.finding) },
        ...(evalCase.history ?? []),
        { role: 'user', content: evalCase.message },
      ],
      // Not 0: a deterministic sample tells us nothing about how the block behaves in production,
      // where the same turn is served at the session's configured temperature.
      temperature: 0.7,
    }),
  });
  if (!response.ok) {
    throw new Error(`${config.model}: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  return body.choices?.[0]?.message?.content ?? '';
}

function grade(evalCase: AbstentionCase, reply: string): GradeResult {
  return evalCase.expectation.kind === 'mustNotMentionCoverage'
    ? gradeMustNotMentionCoverage(reply)
    : gradeMustHedge(reply, evalCase.finding);
}

export async function runAbstentionEval(
  config: AbstentionEvalConfig,
  cases: AbstentionCase[] = ABSTENTION_CASES
): Promise<AbstentionCaseResult[]> {
  const samples = config.samples ?? 3;
  const results: AbstentionCaseResult[] = [];
  for (const evalCase of cases) {
    const graded: (GradeResult & { reply: string })[] = [];
    for (let i = 0; i < samples; i++) {
      const reply = await complete(config, evalCase);
      graded.push({ ...grade(evalCase, reply), reply });
    }
    results.push({
      caseId: evalCase.id,
      finding: evalCase.finding,
      samples: graded,
      passRate: graded.filter(g => g.passed).length / graded.length,
    });
  }
  return results;
}

export function formatAbstentionReport(results: AbstentionCaseResult[]): string {
  const lines = results.map(r => {
    const failures = r.samples.filter(s => !s.passed);
    const detail = failures.length > 0 ? ` - ${failures[0].reason}` : '';
    return `${r.passRate === 1 ? 'PASS' : 'FAIL'} ${r.caseId} (${(r.passRate * 100).toFixed(0)}%)${detail}`;
  });
  const clean = results.filter(r => r.passRate === 1).length;
  return [...lines, `${clean}/${results.length} cases clean across all samples`].join('\n');
}
