import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { analyze, makePlan } from '../adaptive-effort-eval.mjs';

const script = fileURLToPath(new URL('../adaptive-effort-eval.mjs', import.meta.url));
const runCli = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

function observations() {
  const plan = makePlan();
  return {
    schemaVersion: 1,
    corpusHash: plan.corpusHash,
    rows: plan.schedule.map(({ promptId, arm }, index) => ({
      promptId,
      arm,
      requestId: `request-${index}`,
      complexity: 'complex',
      classifierEvidence: 'private classifier trace',
      status: 'completed',
      attempt: 0,
      restarts: 0,
      model: plan.model,
      wireEvidence: 'private provider request trace',
      effectiveEffort: arm === 'default' ? 'high' : 'medium',
      requestedEffort: arm === 'default' ? null : 'medium',
      environmentHash: 'a'.repeat(64),
      response: 'Fixture answer',
      firstTokenMs: 100,
      totalMs: arm === 'default' ? 1000 : 800,
      quality: 4,
      blindReviewId: 'review-1',
      correct: true,
      gradeEvidence: 'rubric checked',
      toolCorrect: true,
      toolEvidence: 'tool audit',
    })),
  };
}

describe('adaptive effort offline evaluation', () => {
  it('builds 30 fixed prompts and 60 balanced interleaved observations', () => {
    const plan = makePlan();
    expect(plan).toEqual(makePlan());
    expect(new Set(plan.prompts.map(row => row.id)).size).toBe(30);
    expect(plan.schedule).toHaveLength(60);
    expect(plan.schedule.filter((row, index) => index % 2 === 0 && row.arm === 'default')).toHaveLength(15);
    for (const category of ['longform', 'reasoning', 'tools']) {
      expect(plan.prompts.filter(row => row.category === category)).toHaveLength(10);
    }
  });

  it('computes paired deltas without claiming a quality study proves a default', () => {
    const result = analyze(observations());
    expect(result.pairedMedianTotalDeltaMs).toBe(-200);
    expect(result.summaries.medium.meanQuality).toBe(4);
    expect(result.summaries.default.samples).toBe(30);
    expect(result.decision).toBe('manual-quality-and-uncertainty-review-required');
  });

  it('rejects a comparison whose effective arms are already medium', () => {
    const input = observations();
    input.rows.forEach(row => {
      row.effectiveEffort = 'medium';
    });
    expect(analyze(input).decision).toBe('blocked-non-distinct-arms');
  });

  it('retains quality and tool regressions even when latency improves', () => {
    const input = observations();
    const row = input.rows.find(item => item.promptId === 'tools-1' && item.arm === 'medium');
    row.toolCorrect = false;
    expect(analyze(input).regressions).toEqual(['tools-1']);
    expect(analyze(input).decision).toBe('keep-default-quality-regression');
  });

  it('retains a quality-only regression', () => {
    const input = observations();
    input.rows.find(item => item.promptId === 'longform-1' && item.arm === 'medium').quality = 3;
    const result = analyze(input);
    expect(result.regressions).toEqual(['longform-1']);
    expect(result.decision).toBe('keep-default-quality-regression');
  });

  it('retains a correctness-only regression', () => {
    const input = observations();
    input.rows.find(item => item.promptId === 'reasoning-1' && item.arm === 'medium').correct = false;
    const result = analyze(input);
    expect(result.regressions).toEqual(['reasoning-1']);
    expect(result.decision).toBe('keep-default-quality-regression');
  });

  it('reports a labelled error for non-string evidence', () => {
    const input = observations();
    input.rows[0].classifierEvidence = 42;
    expect(() => analyze(input)).toThrow(/^Unverified production complexity/);
  });

  describe('CLI', () => {
    it('prints the plan', () => {
      const result = runCli('plan');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).corpusHash).toBe(makePlan().corpusHash);
    });

    it('analyzes an observations file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'adaptive-effort-eval-'));
      try {
        const file = join(dir, 'observations.json');
        writeFileSync(file, JSON.stringify(observations()));
        const result = runCli('analyze', file);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).decision).toBe('manual-quality-and-uncertainty-review-required');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('exits non-zero with usage on a bad command', () => {
      const result = runCli('analyze');
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/^Usage:/);
    });
  });

  it.each([
    ['missing pair', input => input.rows.pop()],
    [
      'wrong schedule',
      input => {
        input.rows.reverse();
      },
    ],
    [
      'duplicate pair',
      input => {
        input.rows[1] = { ...input.rows[0] };
      },
    ],
    [
      'duplicate request',
      input => {
        input.rows[1].requestId = input.rows[0].requestId;
      },
    ],
    [
      'missing correlation',
      input => {
        input.rows[0].requestId = '';
      },
    ],
    [
      'retry',
      input => {
        input.rows[0].attempt = 1;
      },
    ],
    [
      'restart',
      input => {
        input.rows[0].restarts = 1;
      },
    ],
    [
      'timeout',
      input => {
        input.rows[0].status = 'timeout';
      },
    ],
    [
      'unknown complexity',
      input => {
        input.rows[0].complexity = 'unknown';
      },
    ],
    [
      'wrong effort',
      input => {
        input.rows[1].effectiveEffort = 'low';
      },
    ],
    [
      'wrong model',
      input => {
        input.rows[0].model = 'different';
      },
    ],
    [
      'different environment',
      input => {
        input.rows[0].environmentHash = 'b'.repeat(64);
      },
    ],
    [
      'missing grade',
      input => {
        delete input.rows[0].quality;
      },
    ],
    [
      'missing tool audit',
      input => {
        delete input.rows.find(row => row.promptId === 'tools-1').toolEvidence;
      },
    ],
    [
      'invalid latency',
      input => {
        input.rows[0].firstTokenMs = -1;
      },
    ],
    [
      'different corpus',
      input => {
        input.corpusHash = 'wrong';
      },
    ],
  ])('fails closed on %s', (_label, mutate) => {
    const input = observations();
    mutate(input);
    expect(() => analyze(input)).toThrow();
  });
});
