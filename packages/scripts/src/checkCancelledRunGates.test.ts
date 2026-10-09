import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { readJobCondition, readJobs } from './ciWorkflowText';

/**
 * Guard on how ci.yml's fan-in gates behave in a run cancelled by `cancel-in-progress`.
 *
 * PR runs share a concurrency group, so a push plus a ready-for-review (or a re-run) on the same
 * SHA cancels one run with the other. `always()` is the one status-check function that stays true
 * through that cancellation, and both gates misreport there: the `test` aggregator asserts its
 * shards succeeded, sees `cancelled` and posts a false red "Run Tests"; `ci-complete` only reddens
 * on the literal `failure`, sees the unfinished legs `cancelled` and posts a false green "CI
 * Complete" - the required check - with nothing tested. `!cancelled()` still runs them in a live
 * run (so a failed shard keeps reddening both) and leaves them `cancelled` in a cancelled one.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CI_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

const jobs = readJobs(fs.readFileSync(CI_WORKFLOW, 'utf8'));

describe('ci.yml fan-in gates on a cancelled run', () => {
  it.each(['test', 'ci-complete'])('%s is gated on !cancelled(), not always()', name => {
    const job = jobs.find(j => j.name === name);
    expect(job, `job ${name} missing from ci.yml`).toBeDefined();
    const condition = readJobCondition(job!.body);
    expect(condition).toMatch(/!cancelled\(\)/);
    expect(condition).not.toMatch(/always\(\)/);
  });
});
