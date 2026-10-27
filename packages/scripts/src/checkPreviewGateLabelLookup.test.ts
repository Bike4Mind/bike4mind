import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../../../.github/workflows/sst-infra-preview-gate.yml', import.meta.url),
  'utf8'
);
const start = workflow.indexOf('          # The deployer adds `preview-deployed`');
const end = workflow.indexOf('          # Previews are dispatched', start);
if (start === -1 || end === -1) throw new Error('Preview label lookup block is missing');
const lookup = workflow.slice(start, end);

function runLookup(labelCommand: string) {
  return spawnSync(
    'bash',
    ['-c', `set -euo pipefail\nREPO=example/repo\nPR=1\ngh() {\n${labelCommand}\n}\n${lookup}\nexit 1`],
    { encoding: 'utf8' }
  );
}

describe('preview gate label lookup', () => {
  it('accepts a deployed preview when more labels arrive after the matching label', () => {
    const result = runLookup("printf 'preview-deployed\\n'\nsleep 0.05\nprintf 'preview-stale\\nreview:ongoing\\n'");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Gate satisfied');
  });

  it('does not accept other labels as a deployed preview', () => {
    const result = runLookup("printf 'preview-stale\\nreview:ongoing\\n'");
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).not.toContain('Gate satisfied');
  });

  it('preserves label API errors instead of treating them as missing deployment evidence', () => {
    const result = runLookup("printf 'label API unavailable\\n' >&2\nreturn 42");
    expect(result.status).toBe(42);
    expect(result.stderr).toContain('label API unavailable');
  });
});
