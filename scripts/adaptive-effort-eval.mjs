import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const tasks = {
  longform: [
    ['Design a zero-downtime PostgreSQL schema migration from one address column to structured addresses.', 'Cover expand/backfill/contract, mixed-version writes, rollback and validation.'],
    ['Compare serializable and snapshot isolation for a booking system with two concurrent writers.', 'Show a concrete write-skew schedule, prevention, retries and tradeoffs.'],
    ['Design a multi-region payment webhook consumer.', 'Cover idempotency, ordering, replay, durable acknowledgement and regional failure.'],
    ['Plan migration of a monolith to services without a big-bang release.', 'Give staged boundaries, data ownership, observability, rollback and success criteria.'],
    ['Design an accessible offline-first note editor with concurrent editing.', 'Address conflict resolution, recovery, keyboard access, sync and data loss tests.'],
    ['Compare queue-based and event-log-based order processing.', 'Discuss ordering, backpressure, replay, delivery semantics and operational cost.'],
    ['Design deletion of user data across backups, caches and analytics.', 'Address retention constraints, auditability, retries and verifiable completion.'],
    ['Propose a safe feature-flag rollout for a new checkout implementation.', 'Include cohorts, guardrails, measurement bias, rollback and flag removal.'],
    ['Design a rate limiter for a distributed API with tenant quotas.', 'Explain burst semantics, clock skew, failure policy, fairness and tests.'],
    ['Write an incident response plan for a database connection-pool exhaustion.', 'Separate mitigation from diagnosis, protect evidence, define rollback and prevention.'],
  ],
  reasoning: [
    ['A test has 95% sensitivity and 90% specificity; prevalence is 2%. Compute the positive predictive value.', 'Use Bayes with explicit counts; the answer is about 16.24%, not 95%.'],
    ['Two fair dice are rolled. Given at least one is six, what is the probability both are six?', 'Enumerate 11 equally likely ordered outcomes; answer 1/11.'],
    ['A job DAG has A=3, B=5 after A, C=4 after A, D=2 after B and C. Find minimum unlimited-worker makespan.', 'Show the critical path A-B-D and makespan 10; distinguish total work 14.'],
    ['A cache has 90% hit rate at 2ms; misses cost 102ms total. Find mean and p95 latency.', 'Mean 12ms; p95 102ms under this two-point distribution.'],
    ['A service has independent replicas each available 0.99. Compare two replicas in series vs parallel.', 'Series 0.9801, parallel 0.9999; state independence assumption.'],
    ['Amdahl: 80% of a program is parallelizable. Find speedup with 4 workers and the infinite-worker limit.', 'Speedup 2.5 and limit 5; include the serial fraction.'],
    ['Given P(A)=0.6, P(B)=0.5, P(A intersection B)=0.3, compute union and test independence.', 'Union 0.8; independent since intersection equals product; do not imply disjoint.'],
    ['An M/M/1 queue receives 8 jobs/s and serves 10 jobs/s. Find utilization, mean system time and mean queue wait.', 'Utilization 0.8, system time 0.5s, queue wait 0.4s; state steady-state assumptions.'],
    ['A binary classifier has TP=40 FP=10 FN=20 TN=130. Compute precision, recall and F1.', 'Precision 0.8, recall 2/3, F1 about 0.7273; show denominators.'],
    ['Compare expected attempts for one success at p=0.25 with probability of at least one success in four attempts.', 'Expected attempts 4; probability 1-0.75^4=0.68359375; distinguish expectation from guarantee.'],
  ],
  tools: [
    ['Using the supplied fixture workspace, inspect package scripts and run the narrowest test for the arithmetic utility.', 'Record actual test command and exit code; do not claim unexecuted tests passed.'],
    ['Using the supplied fixture workspace, diagnose the failing timezone conversion test and propose a minimal fix without editing.', 'Read implementation and failing assertion; identify the boundary condition with evidence.'],
    ['Using the supplied fixture workspace, find all callers of the deprecated parseDate helper and classify migration risks.', 'Use search and inspect callers; distinguish date-only from timestamp inputs.'],
    ['Using the supplied fixture workspace, trace a request from route validation to persistence.', 'Cite actual file paths and identify validation and transaction boundaries.'],
    ['Using the supplied fixture workspace, compare the two checked-in benchmark JSON files.', 'Read both files, compute paired differences and retain failed samples.'],
    ['Using the supplied fixture workspace, investigate a dependency version mismatch using the manifest and lockfile.', 'Read both sources and identify actual resolved version without installing.'],
    ['Using the supplied fixture workspace, inspect a pagination implementation for duplicate or skipped records.', 'Read query and tests; reason about tied timestamps and cursor predicates.'],
    ['Using the supplied fixture workspace, inspect retry behavior in the webhook consumer.', 'Trace acknowledgement and error paths; identify idempotency and bounded retry behavior.'],
    ['Using the supplied fixture workspace, find a resource leak in the stream reader and propose a regression test.', 'Inspect cancellation and cleanup paths and ground the proposed test in actual code.'],
    ['Using the supplied fixture workspace, calculate the critical path from the checked-in build trace.', 'Read trace data, follow dependency edges, report units and explain the path.'],
  ],
};

export const prompts = Object.entries(tasks).flatMap(([category, entries]) =>
  entries.map(([task, rubric], index) => ({
    id: `${category}-${index + 1}`,
    category,
    prompt: `Analyze this multi-step task carefully, explain your reasoning and tradeoffs, and verify your conclusion. ${task} ${rubric}`,
    rubric,
  }))
);

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};

export function makePlan() {
  return {
    schemaVersion: 1,
    corpusHash: digest(prompts),
    status: 'blocked-live-run',
    model: 'claude-opus-5-5',
    arms: { default: 'omit explicit effort; preserve production behavior', medium: 'explicit medium' },
    prompts,
    schedule: prompts.flatMap((prompt, index) =>
      (index % 2 === 0 ? ['default', 'medium'] : ['medium', 'default']).map(arm => ({ promptId: prompt.id, arm }))
    ),
  };
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function analyze(input) {
  const plan = makePlan();
  requireValue(input?.schemaVersion === 1 && input.corpusHash === plan.corpusHash, 'Unknown schema or corpus');
  requireValue(Array.isArray(input.rows) && input.rows.length === 60, 'Require exactly 30 complete pairs; no retry selection');
  const ids = new Set();
  const requests = new Set();
  const environmentHashes = new Set();
  for (const [index, row] of input.rows.entries()) {
    const scheduled = plan.schedule[index];
    requireValue(row.promptId === scheduled.promptId && row.arm === scheduled.arm, 'Observations must follow the frozen schedule');
    const prompt = prompts.find(item => item.id === row.promptId);
    requireValue(prompt && ['default', 'medium'].includes(row.arm), 'Unknown prompt or arm');
    const key = `${row.promptId}:${row.arm}`;
    requireValue(!ids.has(key), `Duplicate attempt: ${key}`);
    ids.add(key);
    requireValue(typeof row.requestId === 'string' && row.requestId.trim() && !requests.has(row.requestId), `Missing/duplicate correlation: ${key}`);
    requests.add(row.requestId);
    requireValue(row.complexity === 'complex' && row.classifierEvidence?.trim(), `Unverified production complexity: ${key}`);
    requireValue(row.status === 'completed' && row.attempt === 0 && row.restarts === 0, `Incomplete/retried/restarted: ${key}`);
    requireValue(row.model === plan.model && row.wireEvidence?.trim(), `Missing model/wire evidence: ${key}`);
    requireValue(['low', 'medium', 'high', 'xhigh', 'max'].includes(row.effectiveEffort), `Unknown effective effort: ${key}`);
    requireValue(row.requestedEffort === (row.arm === 'default' ? null : 'medium'), `Wrong requested effort: ${key}`);
    requireValue(row.arm !== 'medium' || row.effectiveEffort === 'medium', `Treatment did not reach wire: ${key}`);
    requireValue(/^[a-f0-9]{64}$/.test(row.environmentHash), `Missing environment fingerprint: ${key}`);
    environmentHashes.add(row.environmentHash);
    requireValue(typeof row.response === 'string' && row.response.trim(), `Missing answer: ${key}`);
    requireValue(Number.isFinite(row.firstTokenMs) && row.firstTokenMs > 0 && Number.isFinite(row.totalMs) && row.totalMs >= row.firstTokenMs, `Invalid latency: ${key}`);
    requireValue(Number.isInteger(row.quality) && row.quality >= 0 && row.quality <= 4 && row.blindReviewId?.trim(), `Missing blinded grade: ${key}`);
    requireValue(typeof row.correct === 'boolean' && row.gradeEvidence?.trim(), `Missing correctness evidence: ${key}`);
    if (prompt.category === 'tools') {
      requireValue(typeof row.toolCorrect === 'boolean' && row.toolEvidence?.trim(), `Missing tool audit: ${key}`);
    }
  }
  requireValue(environmentHashes.size === 1, 'Model, stack, fixtures or settings differ between observations');
  const pairs = prompts.map(prompt => ({
    promptId: prompt.id,
    baseline: input.rows.find(row => row.promptId === prompt.id && row.arm === 'default'),
    treatment: input.rows.find(row => row.promptId === prompt.id && row.arm === 'medium'),
  }));
  const identicalEffort = pairs.filter(pair => pair.baseline.effectiveEffort === pair.treatment.effectiveEffort).map(pair => pair.promptId);
  const summaries = Object.fromEntries(['default', 'medium'].map(arm => {
    const rows = input.rows.filter(row => row.arm === arm);
    return [arm, {
      samples: rows.length,
      medianFirstTokenMs: median(rows.map(row => row.firstTokenMs)),
      medianTotalMs: median(rows.map(row => row.totalMs)),
      meanQuality: rows.reduce((sum, row) => sum + row.quality, 0) / rows.length,
      correct: rows.filter(row => row.correct).length,
      toolCorrect: rows.filter(row => row.toolCorrect === true).length,
    }];
  }));
  const regressions = pairs.filter(({ baseline, treatment }) =>
    treatment.quality < baseline.quality || (baseline.correct && !treatment.correct) || (baseline.toolCorrect && !treatment.toolCorrect)
  ).map(pair => pair.promptId);
  return {
    summaries,
    pairedMedianTotalDeltaMs: median(pairs.map(pair => pair.treatment.totalMs - pair.baseline.totalMs)),
    pairedMedianFirstTokenDeltaMs: median(pairs.map(pair => pair.treatment.firstTokenMs - pair.baseline.firstTokenMs)),
    regressions,
    identicalEffort,
    decision: identicalEffort.length > 0 ? 'blocked-non-distinct-arms' : regressions.length > 0 ? 'keep-default-quality-regression' : 'manual-quality-and-uncertainty-review-required',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, file] = process.argv.slice(2);
    requireValue(command === 'plan' || (command === 'analyze' && file), 'Usage: node scripts/adaptive-effort-eval.mjs plan | analyze <observations.json>');
    console.log(JSON.stringify(command === 'plan' ? makePlan() : analyze(JSON.parse(readFileSync(file, 'utf8'))), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
