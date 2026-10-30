import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSlackPost } from '../qa-backfill-slack.mjs';
import { CHANNEL, latencyPost, latencyRow } from './fixtures/slack-posts.mjs';

// The backfill's LATENCY_CELL parses cells the Aggregate step in e2e-ai-latency.yml renders. That
// step only runs on schedule/dispatch, so lift its Latency column block and run it here: a format
// change on either side then fails this test instead of silently breaking the backfill.
for (const tool of ['jq', 'bc']) {
  if (spawnSync('sh', ['-c', `command -v ${tool}`]).status !== 0) {
    throw new Error(`qa-backfill-slack.latency-cell: required host tool not on PATH: ${tool}`);
  }
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const yaml = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'e2e-ai-latency.yml'), 'utf8');

/** The `if [ -n "$LATENCY_JSON" ]` under `# Latency column`, to its closing `fi`, lifted verbatim. */
function liftLatencyBlock() {
  const lines = yaml.split('\n');
  const header = lines.findIndex(l => l.trim() === '# Latency column');
  const start = lines.findIndex((l, i) => i > header && l.trim() === 'if [ -n "$LATENCY_JSON" ]; then');
  if (header === -1) throw new Error('Latency column block not found in e2e-ai-latency.yml');
  if (start === -1) throw new Error('Latency column block not found in e2e-ai-latency.yml');
  const indent = lines[start].match(/^ */)[0];
  const end = lines.findIndex((l, i) => i > start && l === `${indent}fi`);
  if (end === -1) throw new Error('Latency column block has no closing fi');
  return lines.slice(start, end + 1).join('\n');
}

function renderCell(artifact) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-latency-cell-'));
  try {
    const file = path.join(dir, 'results.json');
    fs.writeFileSync(file, JSON.stringify(artifact));
    const script = [
      'LATENCY_EXCEEDED_COUNT=0; LATENCY_WITHIN=0; LATENCY_NO_DATA=0',
      liftLatencyBlock(),
      'printf "CELL=%s\\n" "$LATENCY_STR"',
    ].join('\n');
    const out = execFileSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, LATENCY_JSON: file, SPEC: 'latency-spec-a', AI_MODEL: 'model-x' },
    });
    return out
      .split('\n')
      .find(l => l.startsWith('CELL='))
      .slice('CELL='.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function parseCell(cell) {
  const row = latencyRow('latency-spec-a', 'model-x', 'Pass', cell);
  const post = latencyPost({ rows: [row], latencyColumn: 'Median Latency (TTFT)' });
  return parseSlackPost(post, { product: 'product-a', channel: CHANNEL }).metrics;
}

const metric = { kind: 'latency', model: 'model-x', label: 'latency-spec-a', unit: 's', threshold: 5 };

describe('Aggregate step Latency cell round-trips through the backfill parser', () => {
  it('a passing cell with TTFT', () => {
    const cell = renderCell({ thresholdSec: 5, medianResponseTimeSec: 3.2, medianFirstTokenSec: 0.85, results: [] });
    expect(cell).toBe('3.20s (TTFT 0.85s) / <=5s');
    expect(parseCell(cell)).toEqual([{ ...metric, value: 3.2 }]);
  });

  it('a breach with every suffix: artifact-mode, never finished, retried', () => {
    const cell = renderCell({
      thresholdSec: 5,
      medianResponseTimeSec: 9.1,
      medianFirstTokenSec: 2.4,
      results: [
        { id: 'a', responseTimeSec: 300, incomplete: true },
        { id: 'b', responseTimeSec: 4, retried: true },
        { id: 'b', responseTimeSec: 9.1 },
        { id: 'c', responseTimeSec: 40, measuresDeliverable: true, unexpectedArtifact: true },
      ],
    });
    expect(cell).toBe(
      '9.10s (TTFT 2.40s) / <=5s FAIL (1 artifact-mode excluded) (1 prompt(s) never finished) (1 retried attempt(s) kept)'
    );
    expect(parseCell(cell)).toEqual([{ ...metric, value: 9.1 }]);
  });

  it('a passing cell with an artifact-mode note and no TTFT', () => {
    const cell = renderCell({
      thresholdSec: 5,
      medianResponseTimeSec: 3.2,
      results: [{ id: 'c', responseTimeSec: 40, measuresDeliverable: true, unexpectedArtifact: true }],
    });
    expect(cell).toBe('3.20s / <=5s (1 artifact-mode excluded)');
    expect(parseCell(cell)).toEqual([{ ...metric, value: 3.2 }]);
  });

  it('does not count an artifact-mode attempt that a chat retry replaced', () => {
    const cell = renderCell({
      thresholdSec: 5,
      medianResponseTimeSec: 3.2,
      results: [
        { id: 'c', responseTimeSec: 40, measuresDeliverable: true, unexpectedArtifact: true, retried: true },
        { id: 'c', responseTimeSec: 3.2 },
      ],
    });
    expect(cell).toBe('3.20s / <=5s');
  });
});
