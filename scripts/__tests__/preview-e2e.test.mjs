import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { stateFor } from '../e2e-outcome.mjs';

const require = createRequire(import.meta.url);
const { prepare, report, verify } = require('../../.github/scripts/preview-e2e.cjs');
const root = new URL('../../', import.meta.url);
const sha = 'a'.repeat(40);
function fixture({ eventName = 'workflow_dispatch', ref = 'refs/heads/main', labels = ['preview-deployed'], state = 'success',
  creator = 'bike4mind-release-bot[bot]', head = sha, statusId = 42, mergeable = true,
  description = `Preview deployed at ${sha.slice(0, 7)}`, deployedSha = sha, kind = 'fresh', recordAuthor = creator } = {}) {
  const outputs = {};
  const writes = [];
  const notices = [];
  const pr = { number: 1, state: 'open', head: { sha: head, repo: { full_name: 'Bike4Mind/bike4mind' } },
    base: { sha: 'b'.repeat(40) }, mergeable, labels: labels.map(name => ({ name })) };
  const status = { id: statusId, context: 'preview/deploy', state, description, creator: { login: creator } };
  const context = { repo: { owner: 'Bike4Mind', repo: 'bike4mind' }, eventName, ref,
    payload: { ...status, sha, sender: { login: creator } } };
  const github = { rest: { pulls: { get: async () => ({ data: pr }) }, repos: {
    listCommitStatusesForRef: 'statuses', listPullRequestsAssociatedWithCommit: 'prs',
    createCommitStatus: async value => writes.push(value),
  }, issues: { listComments: 'comments', createComment: async value => writes.push(value) } },
  paginate: async method => method === 'statuses' ? [status] : method === 'prs' ? [pr] : [{
    user: { login: recordAuthor }, body: `<!-- b4m-preview-deployer ${JSON.stringify({ v: 1, sha: deployedSha, kind })} -->`,
  }] };
  const core = { setOutput: (key, value) => { outputs[key] = value; }, notice: message => notices.push(message), warning() {} };
  return { github, context, core, outputs, writes, notices };
}

test('main dispatch with only pr_number prepares the selected advisory route', async () => {
  process.env.PR_NUMBER = '1';
  try {
    const f = fixture();
    await prepare(f);
    assert.equal(f.outputs.ready, 'true');
    assert.equal(f.outputs.head_sha, sha);
    assert.equal(f.outputs.deploy_id, '42');
  } finally { delete process.env.PR_NUMBER; }
});

test('conflicted PRs are skipped with a notice and uncomputed mergeability still runs', async () => {
  process.env.PR_NUMBER = '1';
  try {
    const conflicted = fixture({ mergeable: false });
    await prepare(conflicted);
    assert.equal(conflicted.outputs.ready, undefined);
    assert.equal(conflicted.notices.length, 1);
    assert.match(conflicted.notices[0], /conflicts with its base/);
    const pending = fixture({ mergeable: null });
    await prepare(pending);
    assert.equal(pending.outputs.ready, 'true');
  } finally { delete process.env.PR_NUMBER; }
});

test('dispatch fails closed on stale, missing or untrusted deployment evidence', async () => {
  process.env.PR_NUMBER = '1';
  try {
    for (const options of [{ labels: [] }, { labels: ['preview-deployed', 'preview-stale'] },
      { eventName: 'status' }, { eventName: 'pull_request' }, { ref: 'refs/heads/feature' },
      { description: 'Preview is 1 commits behind (running aaaaaaa)' }, { description: '' },
      { kind: 'deploying' }, { deployedSha: 'c'.repeat(40) }, { recordAuthor: 'someone' },
      { state: 'pending' }, { creator: 'github-actions[bot]' }, { head: 'c'.repeat(40) }]) {
      const f = fixture(options);
      await prepare(f);
      assert.equal(f.outputs.ready, undefined, JSON.stringify(options));
    }
  } finally { delete process.env.PR_NUMBER; }
});

test('execution revalidates the same full deployment evidence and status id', async () => {
  const original = { ...process.env };
  try {
    Object.assign(process.env, { PR_NUMBER: '1', HEAD_SHA: sha, DEPLOY_ID: '42' });
    await verify(fixture());
    for (const options of [{ statusId: 43 }, { head: 'c'.repeat(40) }, { deployedSha: 'c'.repeat(40) },
      { description: 'Preview is 1 commits behind (running aaaaaaa)' }, { kind: 'deploying' }]) {
      await assert.rejects(verify(fixture(options)), /no tests started/);
    }
  } finally { process.env = original; }
});

test('report fallback never turns missing reusable outputs into a pass, and suppresses stale results', async () => {
  const original = { ...process.env };
  try {
    Object.assign(process.env, { PR_NUMBER: '1', HEAD_SHA: sha, DEPLOY_ID: '42', OUTCOME: '' });
    for (const [JOB_RESULT, expected] of [['failure', 'setup_failed'], ['cancelled', 'cancelled'], ['success', 'not_run']]) {
      process.env.JOB_RESULT = JOB_RESULT;
      const f = fixture();
      await report(f);
      assert.match(f.writes[0].body, new RegExp(expected));
      assert.notEqual(f.writes[1].state, 'success');
    }
    for (const options of [{ head: 'c'.repeat(40) }, { statusId: 43 }, { state: 'pending' }, { labels: [] }]) {
      const f = fixture(options);
      await report(f);
      assert.deepEqual(f.writes, []);
    }
  } finally { process.env = original; }
});

test('actual project configuration guard and path tables run in the existing scripts test lane', () => {
  execFileSync(process.execPath, ['--test', 'apps/client/e2e/project-selection.test.mjs'], { cwd: root });
}, 30_000);

test('preview statuses use the shared outcome state mapping', async () => {
  const original = { ...process.env };
  try {
    Object.assign(process.env, { PR_NUMBER: '1', HEAD_SHA: sha, DEPLOY_ID: '42', JOB_RESULT: 'success' });
    for (const outcome of ['passed', 'failed', 'setup_failed', 'no_tests', 'incomplete', 'not_run', 'skipped', 'cancelled']) {
      process.env.OUTCOME = outcome;
      const f = fixture();
      await report(f);
      assert.equal(f.writes[1].state, stateFor(outcome));
    }
  } finally { process.env = original; }
});

test('preview dispatch executes trusted main only, fetches diff data and preserves staging', () => {
  const read = name => readFileSync(new URL(`.github/workflows/${name}`, root), 'utf8');
  const core = read('e2e-core.yml');
  assert.match(core, /timeout_minutes: 45/);
  assert.match(core, /global_timeout_minutes: 15/);
  assert.match(core, /JOB_RESULT: \$\{\{ needs.preview.result \}\}/);
  assert.match(core, /checkout_ref: \$\{\{ github.sha \}\}/);
  assert.equal([...core.matchAll(/ref: \$\{\{ github.sha \}\}/g)].length, 4);
  assert.match(core, /git fetch --no-tags origin "\$E2E_BASE_SHA" "\$E2E_HEAD_SHA"/);
  assert.doesNotMatch(core, /refs\/pull\/|ref: .*head_sha|ref: .*base_sha|\n\s+status:|\n\s+pull_request:|workflow_call:/);
  assert.match(core, /github.event_name == 'workflow_dispatch' && github.ref == 'refs\/heads\/main' && inputs.pr_number != ''/);
  assert.match(core, /core:\n\s+if: github.event_name == 'workflow_dispatch' && inputs.pr_number == ''/);
  assert.match(core, /playwright_args:\s+'--project=unauthenticated --project=notebook --project=prompts'/);
  assert.match(core, /preview_head_sha: \$\{\{ needs.prepare-preview.outputs.head_sha \}\}/);
  assert.match(read('e2e-run.yml'), /HEAD_SHA: \$\{\{ inputs.preview_head_sha \|\| inputs.checkout_ref \}\}/);
  assert.doesNotMatch(core + read('e2e-run.yml'), /git rev-parse HEAD\^2/);
  assert.match(core, /execution_timeout_minutes: 17/);
  assert.match(read('e2e-run.yml'), /timeout-minutes: \$\{\{ inputs.execution_timeout_minutes \}\}/);
  assert.match(core, /stamp_promotable: false/);
  assert.match(core, /preview:\n\s+needs: \[prepare-preview, select-preview\]\n\s+if: always\(\) && !cancelled\(\)/);
  assert.doesNotMatch(core, /--no-deps/);
  assert.doesNotMatch(read('e2e-on-label.yml'), /pull_request:|types: \[labeled\]/);
  assert.match(read('e2e-on-label.yml'), /workflow_dispatch:/);
  assert.match(read('e2e-on-label.yml'), /workflow_id: 'e2e-core.yml', ref: 'main'/);
  assert.match(read('e2e-run.yml'), /inputs.pr_number != '' && github.sha \|\| inputs.checkout_ref \|\| github.sha/);
  assert.match(read('e2e-run.yml'), /TRUSTED_PREVIEW:.*github.ref == 'refs\/heads\/main'.*inputs.preview_deploy_id != ''.*inputs.preview_head_sha != ''/);
  assert.match(read('e2e-run.yml'), /\.verify\(\{ github, context \}\)/);
  assert.match(read('e2e-manual.yml'), /schedule:/);
  assert.match(read('e2e-manual.yml'), /""\|"All tests"\)\s+ARGS=""/);
  assert.match(read('e2e-manual.yml'), /global_timeout_minutes: 50\n\s+execution_timeout_minutes: 52/);
});
