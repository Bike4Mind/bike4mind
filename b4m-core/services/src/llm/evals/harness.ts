/**
 * Shared harness for the prompt-behaviour evals under this directory. Sends each case to a real
 * model with the prompt under test as its only system message, then grades the reply with that eval's
 * deterministic grader.
 *
 * The driver is deliberately a bare `fetch` against an OpenAI-compatible `/chat/completions` endpoint
 * rather than one of our adapters: these evals must pin what a PROMPT does, so the fewer layers
 * between the prompt and the model the better, and any provider (Ollama, an OpenAI-compatible gateway,
 * a Bedrock proxy) can be pointed at one without new credentials plumbing.
 *
 * Shared rather than copied because the parts worth getting right are not the per-eval parts: the
 * blank-completion guard, the sampling floor, and the report/assertion agreeing about the same rate.
 * An eval that forked its own copy of those would drift from this one silently.
 *
 * Not run in CI - these need a live endpoint and prompt behaviour is not a green/red gate. See each
 * eval's README.
 */

/**
 * Splits a reply for per-sentence grading. Every grader here is lexical, and a phrase is scoped by
 * its own clause: a whole-reply match would let an honest hedge in one sentence excuse an overreach
 * in the next (or vice versa). A semicolon splits too - it joins two independent clauses, so scoping
 * must not carry across it. Shared so the graders cannot disagree about where a claim ends.
 */
export function sentences(reply: string): string[] {
  return reply.split(/[.!?;]+/).filter(s => s.trim().length > 0);
}

/** The turn under test. Each eval extends this with whatever selects its prompt body. */
export interface PromptEvalCase {
  id: string;
  /** Prior turns, if the case is about a follow-up. Assistant/user alternating. */
  history?: { role: 'user' | 'assistant'; content: string }[];
  /** The user message for the turn under test. */
  message: string;
}

/** A grader's verdict on one sample. Eval graders may return a wider shape; only this is read here. */
export interface EvalGrade {
  passed: boolean;
  reason: string;
}

export interface PromptEvalDefinition<TCase extends PromptEvalCase, TGrade extends EvalGrade = EvalGrade> {
  cases: TCase[];
  /** The prompt under test, as the model will see it. Per-case because some evals vary the body. */
  systemPrompt: (evalCase: TCase) => string;
  grade: (evalCase: TCase, reply: string) => TGrade;
}

export interface PromptEvalConfig {
  /** Base URL of an OpenAI-compatible endpoint, e.g. `http://localhost:11434/v1`. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Repeats per case. Prompt behaviour is stochastic; one sample per case reads noise as signal. */
  samples?: number;
}

export interface PromptEvalCaseResult<TCase extends PromptEvalCase, TGrade extends EvalGrade = EvalGrade> {
  evalCase: TCase;
  /** One entry per sample, in order. */
  samples: (TGrade & { reply: string })[];
  passRate: number;
}

/**
 * A 200 carrying no usable message content. Distinct from a transport failure so the sweep can
 * record the sample as a failure and keep going rather than discarding the cases already run.
 */
class EmptyCompletionError extends Error {}

async function complete<TCase extends PromptEvalCase, TGrade extends EvalGrade>(
  config: PromptEvalConfig,
  definition: PromptEvalDefinition<TCase, TGrade>,
  evalCase: TCase
): Promise<string> {
  const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: definition.systemPrompt(evalCase) },
        ...(evalCase.history ?? []),
        { role: 'user', content: evalCase.message },
      ],
      // Not 0: a deterministic sample tells us nothing about how the prompt behaves in production,
      // where the same turn is served at the session's configured temperature.
      temperature: 0.7,
    }),
  });
  if (!response.ok) {
    throw new Error(`${config.model}: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = body.choices?.[0]?.message?.content;
  // Not `?? ''`: an empty reply passes any grader that scores on the ABSENCE of a phrase, so a 200
  // whose text lives somewhere else (a `tool_calls` reply, a reasoning model) would report most of
  // the suite clean having measured nothing.
  if (typeof content !== 'string' || content.length === 0) {
    throw new EmptyCompletionError(
      `${config.model}: response carried no message content: ${JSON.stringify(body).slice(0, 400)}`
    );
  }
  return content;
}

export async function runPromptEval<TCase extends PromptEvalCase, TGrade extends EvalGrade>(
  config: PromptEvalConfig,
  definition: PromptEvalDefinition<TCase, TGrade>
): Promise<PromptEvalCaseResult<TCase, TGrade>[]> {
  const samples = config.samples ?? 3;
  const results: PromptEvalCaseResult<TCase, TGrade>[] = [];
  for (const evalCase of definition.cases) {
    const graded: (TGrade & { reply: string })[] = [];
    for (let i = 0; i < samples; i++) {
      try {
        const reply = await complete(config, definition, evalCase);
        graded.push({ ...definition.grade(evalCase, reply), reply });
      } catch (error) {
        // A blank completion is as loud recorded as it is thrown, and a sequential sweep takes
        // minutes: aborting would throw away every case already graded. Cast rather than reshaped:
        // TGrade may require fields beyond EvalGrade (e.g. GroundedClaim[]), and a blank completion
        // has none of those to report.
        if (!(error instanceof EmptyCompletionError)) throw error;
        graded.push({ passed: false, reason: error.message, reply: '' } as TGrade & { reply: string });
      }
    }
    results.push({
      evalCase,
      samples: graded,
      passRate: graded.filter(g => g.passed).length / graded.length,
    });
  }
  return results;
}

/**
 * Per-case floor the live suites gate on. Not 100%: prompt behaviour is stochastic, so a full-marks
 * bar reads ordinary sampling noise as a regression. Lives here so every eval's report and assertion
 * label the same rate the same way - a report that prints FAIL on a rate the gate accepts is the
 * fastest way to teach everyone to ignore both.
 *
 * Written as the fraction, not 0.67: at the default 3 samples a case that passes twice computes
 * exactly `2 / 3`, and a rounded decimal above it would put that case in FAIL - making the floor a
 * 100% bar again and leaving the WARN band empty.
 */
export const MIN_PASS_RATE = 2 / 3;

function verdict(passRate: number): 'PASS' | 'WARN' | 'FAIL' {
  if (passRate === 1) return 'PASS';
  return passRate >= MIN_PASS_RATE ? 'WARN' : 'FAIL';
}

export function formatEvalReport<TCase extends PromptEvalCase, TGrade extends EvalGrade = EvalGrade>(
  results: PromptEvalCaseResult<TCase, TGrade>[]
): string {
  const lines = results.map(r => {
    const failures = r.samples.filter(s => !s.passed);
    const detail = failures.length > 0 ? ` - ${failures[0].reason}` : '';
    return `${verdict(r.passRate)} ${r.evalCase.id} (${(r.passRate * 100).toFixed(0)}%)${detail}`;
  });
  const clean = results.filter(r => r.passRate === 1).length;
  const below = results.filter(r => r.passRate < MIN_PASS_RATE).length;
  return [
    ...lines,
    `${clean}/${results.length} cases clean across all samples; ${below} below the ${(MIN_PASS_RATE * 100).toFixed(0)}% floor`,
  ].join('\n');
}
