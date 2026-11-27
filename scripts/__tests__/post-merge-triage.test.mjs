import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateRun, fingerprint, marker, planFailure, evidenceBody, triage } from '../post-merge-triage.mjs';

const head = 'a'.repeat(40);
const parent = 'b'.repeat(40);
const run = (overrides = {}) => ({
  id: 100, run_attempt: 1, name: 'CI', path: '.github/workflows/ci.yml', event: 'push',
  head_repository: { full_name: 'Bike4Mind/bike4mind' }, repository: { full_name: 'Bike4Mind/bike4mind' },
  head_branch: 'main', head_sha: head, status: 'completed', conclusion: 'failure', pull_requests: [], ...overrides,
});
const job = (name = 'Run tests') => ({ id: 200, name: 'Run Tests (client 1/3)', conclusion: 'failure', steps: [{ name, conclusion: 'failure' }] });

function harness({ target = run(), issues = [], comments = [], failedJobs = [job()], inputs, app = false, main = head, reproduction = run({ id: 101 }), baseline = run({ id: 99, head_sha: parent, conclusion: 'success' }), files = [{ filename: 'apps/client/server/calculate.ts', status: 'modified' }], existingPr = [], rollout = { tracking: 'true', remediation: 'true' } } = {}) {
  const github = { rest: { actions: {}, issues: {}, repos: {}, pulls: {}, git: {} }, paginate: vi.fn(async (method, args) => method(args)) };
  github.rest.actions.getWorkflowRun = vi.fn(async ({ run_id }) => ({ data: run_id === 101 ? reproduction : run_id === 99 ? baseline : target }));
  github.rest.actions.listJobsForWorkflowRunAttempt = vi.fn(async () => failedJobs);
  github.rest.issues.listForRepo = vi.fn(async () => issues);
  github.rest.issues.listComments = vi.fn(async () => comments);
  github.rest.issues.create = vi.fn(async ({ body }) => ({ data: { number: 300, body } }));
  github.rest.issues.createComment = vi.fn(async () => ({}));
  github.rest.repos.compareCommitsWithBasehead = vi.fn(async () => ({ data: { status: 'identical' } }));
  github.rest.repos.getBranch = vi.fn(async () => ({ data: { commit: { sha: main } } }));
  github.rest.repos.getCommit = vi.fn(async () => ({ data: { parents: [{ sha: parent }], files } }));
  github.rest.pulls.list = vi.fn(async () => ({ data: existingPr }));
  github.rest.pulls.create = vi.fn(async () => ({ data: { html_url: 'https://github.com/Bike4Mind/bike4mind/pull/301' } }));
  github.rest.git.getCommit = vi.fn(async ({ commit_sha }) => ({ data: { tree: { sha: 'c'.repeat(40) }, parents: [{ sha: commit_sha === parent ? 'd'.repeat(40) : head }] } }));
  github.rest.git.createCommit = vi.fn(async () => ({ data: { sha: 'e'.repeat(40) } }));
  github.rest.git.getRef = vi.fn(async () => ({ data: { object: { sha: 'e'.repeat(40) } } }));
  github.rest.git.createRef = vi.fn(async () => ({}));
  const context = { repo: { owner: 'Bike4Mind', repo: 'bike4mind' }, eventName: inputs ? 'workflow_dispatch' : 'workflow_run', payload: { workflow_run: target } };
  const execute = () => triage({ github, remediation: app ? github : null, context, core: { info: vi.fn() }, inputs, rollout });
  return { github, context, execute };
}
const confirmedInputs = { run_id: '100', reproduction_run_id: '101', parent_run_id: '99', confirmed_last_change: 'true', dry_run: 'false' };

describe('trusted full-run boundary', () => {
  it('accepts main CI push and scheduled full E2E only', () => {
    expect(validateRun(run())).toBeTruthy();
    expect(validateRun(run({ path: '.github/workflows/e2e-manual.yml', name: 'E2E Tests (Manual)', event: 'schedule' }))).toBeTruthy();
  });
  it.each([
    { event: 'pull_request' }, { event: 'workflow_dispatch' }, { head_branch: 'feature' },
    { head_repository: { full_name: 'fork/bike4mind' } }, { repository: { full_name: 'fork/bike4mind' } },
    { head_sha: 'main; echo unsafe' }, { path: '.github/workflows/e2e-core.yml' },
    { name: 'Other' }, { status: 'in_progress' }, { conclusion: 'cancelled' },
    { pull_requests: [{ number: 1 }] }, { id: -1 }, { run_attempt: 0 },
  ])('rejects ineligible metadata: %j', override => expect(() => validateRun(run(override))).toThrow());
  it('rejects non-main ancestry before writes', async () => {
    const h = harness();
    h.github.rest.repos.compareCommitsWithBasehead.mockResolvedValue({ data: { status: 'diverged' } });
    await expect(h.execute()).rejects.toThrow('not on main');
    expect(h.github.rest.issues.create).not.toHaveBeenCalled();
  });
  it('rejects stale event attempts', async () => {
    const h = harness();
    h.context.payload.workflow_run = run({ run_attempt: 2 });
    await expect(h.execute()).rejects.toThrow('Stale');
  });
});

describe('conservative classification and evidence', () => {
  it('keeps an unproven failure blocked, without publishing names or logs', () => {
    const target = run();
    const failed = job('test with sensitive output');
    const plan = planFailure({ run: target, job: failed });
    expect(plan.classification).toBe('uncertain');
    const body = evidenceBody(plan, target, failed);
    expect(body).toContain('blocked; not resolved');
    expect(body).toContain('/actions/runs/100/attempts/1');
    expect(body).toContain('/job/200');
    expect(body).toContain('#artifacts');
    expect(body).not.toContain('sensitive output');
  });
  it('distinguishes setup failure, intermittency and confirmed regression', () => {
    expect(planFailure({ run: run(), job: job('Install dependencies') }).classification).toBe('setup');
    expect(planFailure({ run: run(), job: job(), recovered: true }).classification).toBe('intermittent');
    expect(planFailure({ run: run(), job: job(), confirmed: true }).classification).toBe('confirmed-regression');
  });
  it('does not equate a scheduled workflow SHA with the deployed product SHA', () => {
    const target = run({ path: '.github/workflows/e2e-manual.yml', name: 'E2E Tests (Manual)', event: 'schedule' });
    expect(planFailure({ run: target, job: job() }).next).toContain('actual deployed SHA');
  });
  it('reuses explicit known-failure markers without adopting PRs', () => {
    const key = fingerprint(run(), job());
    const known = { number: 123, body: `Existing diagnosis\n<!-- post-merge-known:${key} -->` };
    expect(planFailure({ run: run(), job: job(), issues: [known] }).existing).toBe(known);
    expect(planFailure({ run: run(), job: job(), issues: [{ ...known, pull_request: {} }] }).existing).toBeUndefined();
  });
});

describe('mocked API orchestration', () => {
  const expectNoWrites = github => {
    for (const method of [github.rest.issues.create, github.rest.issues.createComment,
      github.rest.git.createCommit, github.rest.git.createRef, github.rest.pulls.create]) {
      expect(method).not.toHaveBeenCalled();
    }
  };
  it('defaults an omitted rollout argument to disabled without accessing the API', async () => {
    const h = harness();
    expect(await triage({ context: h.context, core: { info: vi.fn() } })).toEqual([]);
  });
  it('disables automatic and manual writes by default, even when a token is supplied', async () => {
    for (const inputs of [undefined, { run_id: '100', dry_run: 'false' }, confirmedInputs]) {
      const h = harness({ inputs, app: true, rollout: {} });
      expect(await h.execute()).toEqual([]);
      expect(h.github.rest.actions.getWorkflowRun).not.toHaveBeenCalled();
      expectNoWrites(h.github);
    }
  });
  it.each([undefined, '', 'false', 'TRUE', true])('requires exact tracking opt-in, not %s', async tracking => {
    const h = harness({ rollout: { tracking, remediation: 'true' } });
    expect(await h.execute()).toEqual([]);
    expectNoWrites(h.github);
  });
  it.each([undefined, '', 'false', 'TRUE', true])('requires a separate exact remediation opt-in, not %s', async remediation => {
    const h = harness({ inputs: confirmedInputs, app: true, rollout: { tracking: 'true', remediation } });
    expect(await h.execute()).toEqual([]);
    expect(h.github.rest.actions.getWorkflowRun).not.toHaveBeenCalled();
    expectNoWrites(h.github);
  });
  it('allows tracking opt-in without enabling remediation', async () => {
    const h = harness({ rollout: { tracking: 'true' } });
    await h.execute();
    expect(h.github.rest.issues.create).toHaveBeenCalledOnce();
    expect(h.github.rest.pulls.create).not.toHaveBeenCalled();
  });
  it('keeps disabled-rollout dry runs read-only for confirmed and ordinary plans', async () => {
    for (const inputs of [{ run_id: '100' }, { ...confirmedInputs, dry_run: 'true' }]) {
      const h = harness({ inputs, rollout: {} });
      expect((await h.execute())[0]).toBeTruthy();
      expectNoWrites(h.github);
    }
  });
  it('keeps opted-in dry runs read-only even if a remediation token is supplied', async () => {
    const h = harness({ inputs: { ...confirmedInputs, dry_run: 'true' }, app: true });
    await h.execute();
    expectNoWrites(h.github);
  });
  it('ignores first-attempt success', async () => {
    const h = harness({ target: run({ conclusion: 'success' }) });
    expect(await h.execute()).toEqual([]);
    expect(h.github.rest.issues.create).not.toHaveBeenCalled();
  });
  it('tracks unknown job metadata as a blocker', async () => {
    const h = harness({ failedJobs: [] });
    expect((await h.execute())[0].classification).toBe('uncertain');
    expect(h.github.rest.issues.create).toHaveBeenCalledOnce();
  });
  it('preserves failed-attempt evidence after a successful retry without closing tracking', async () => {
    const h = harness({ target: run({ conclusion: 'success', run_attempt: 2 }) });
    await h.execute();
    const body = h.github.rest.issues.create.mock.calls[0][0].body;
    expect(body).toContain('/attempts/1');
    expect(body).toContain('/attempts/2');
    expect(body).toContain('intermittent');
    expect(h.github.rest.actions.listJobsForWorkflowRunAttempt).toHaveBeenCalledWith(expect.objectContaining({ attempt_number: 1 }));
  });
  it('deduplicates both issue-body receipts and comment receipts', async () => {
    const key = fingerprint(run(), job());
    for (const inBody of [true, false]) {
      const receipt = '<!-- post-merge-run:100:1 -->';
      const h = harness({ issues: [{ number: 42, body: marker(key) + (inBody ? receipt : '') }], comments: inBody ? [] : [{ body: receipt }] });
      await h.execute();
      expect(h.github.rest.issues.create).not.toHaveBeenCalled();
      expect(h.github.rest.issues.createComment).not.toHaveBeenCalled();
    }
  });
  it('adds new evidence to known tracking instead of opening a duplicate', async () => {
    const h = harness({ issues: [{ number: 42, body: `<!-- post-merge-known:${fingerprint(run(), job())} -->` }] });
    await h.execute();
    expect(h.github.rest.issues.create).not.toHaveBeenCalled();
    expect(h.github.rest.issues.createComment).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 42 }));
  });
  it('defaults dispatch to dry run without any writes', async () => {
    const h = harness({ inputs: { run_id: '100' } });
    await h.execute();
    expect(h.github.rest.issues.create).not.toHaveBeenCalled();
    expect(h.github.rest.git.createCommit).not.toHaveBeenCalled();
  });
  it('plans a confirmed regression in dry-run mode without a token or writes', async () => {
    const h = harness({ inputs: { ...confirmedInputs, dry_run: 'true' } });
    expect((await h.execute())[0].classification).toBe('confirmed-regression');
    expect(h.github.rest.issues.create).not.toHaveBeenCalled();
    expect(h.github.rest.pulls.create).not.toHaveBeenCalled();
  });
  it('prepares only a draft parent-tree restoration with linked evidence', async () => {
    const h = harness({ inputs: confirmedInputs, app: true });
    await h.execute();
    expect(h.github.rest.git.createCommit).toHaveBeenCalledWith(expect.objectContaining({ tree: 'c'.repeat(40), parents: [head] }));
    expect(h.github.rest.pulls.create).toHaveBeenCalledWith(expect.objectContaining({ draft: true, base: 'main', body: expect.stringContaining('Refs #300') }));
    expect(h.github.rest.pulls.create.mock.calls[0][0].body).toContain('/actions/runs/101');
    expect(h.github.rest.pulls.create.mock.calls[0][0].body).toContain('/actions/runs/99');
  });
  it('does not recreate an existing or closed remediation PR', async () => {
    const h = harness({ inputs: confirmedInputs, app: true, existingPr: [{ number: 1 }] });
    await h.execute();
    expect(h.github.rest.pulls.create).not.toHaveBeenCalled();
  });
  it.each([
    { main: parent }, { reproduction: run({ id: 101, head_sha: parent }) },
    { baseline: run({ id: 99, head_sha: parent, conclusion: 'failure' }) },
    { failedJobs: [job('Install dependencies')] },
    { files: [{ filename: 'apps/client/example.test.ts', status: 'modified' }] },
    { files: [{ filename: '.github/workflows/ci.yml', status: 'modified' }] },
    { files: [{ filename: 'apps/client/server/calculate.ts', status: 'added' }] },
    { files: [] },
  ])('refuses unsafe remediation: %j', async overrides => {
    const h = harness({ inputs: confirmedInputs, app: true, ...overrides });
    await expect(h.execute()).rejects.toThrow();
    expect(h.github.rest.pulls.create).not.toHaveBeenCalled();
  });
  it('records a token/prerequisite failure as blocked, not resolved', async () => {
    const h = harness({ inputs: confirmedInputs });
    await expect(h.execute()).rejects.toThrow('blocked');
    expect(h.github.rest.issues.createComment).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('Blocked:') }));
    expect(h.github.rest.pulls.create).not.toHaveBeenCalled();
  });
  it('refuses a paginated commit file list even if the first page looks safe', async () => {
    const h = harness({ inputs: confirmedInputs, app: true });
    const response = await h.github.rest.repos.getCommit();
    h.github.rest.repos.getCommit.mockResolvedValue({ ...response, headers: { link: '<next-page>; rel="next"' } });
    await expect(h.execute()).rejects.toThrow('blocked');
    expect(h.github.rest.pulls.create).not.toHaveBeenCalled();
  });
  it('records a rejected confirmation even when the original run already has a receipt', async () => {
    const h = harness({ inputs: confirmedInputs, main: parent,
      issues: [{ number: 42, body: `${marker(fingerprint(run(), job()))}\n<!-- post-merge-run:100:1 -->` }] });
    await expect(h.execute()).rejects.toThrow('blocked');
    expect(h.github.rest.issues.createComment).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: 42, body: expect.stringContaining('Blocked: last-change confirmation'),
    }));
  });
});

describe('workflow contract', () => {
  it('isolates dry-run permissions and gates every write job and token behind exact opt-ins', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/post-merge-triage.yml', import.meta.url), 'utf8');
    const plan = workflow.split('  plan:')[1].split('  triage:')[0];
    const writes = workflow.split('  triage:')[1];
    expect(plan).toContain("github.ref == 'refs/heads/main' && inputs.dry_run");
    expect(plan).toContain('issues: read');
    expect(plan).toContain("dry_run: 'true'");
    expect(plan).not.toMatch(/: write|secrets\.|REMEDIATION_TOKEN|create-github-app-token/);
    expect(writes).toContain("vars.POST_MERGE_TRIAGE_ENABLED == 'true'");
    expect(writes).toContain("!inputs.confirmed_last_change || vars.POST_MERGE_REMEDIATION_ENABLED == 'true'");
    expect(writes).toContain("vars.POST_MERGE_TRIAGE_ENABLED == 'true' && vars.POST_MERGE_REMEDIATION_ENABLED == 'true'");
    expect(writes).toContain('rollout: { tracking: process.env.TRACKING_ENABLED, remediation: process.env.REMEDIATION_ENABLED }');
  });
  it('uses only trusted main code without logs/artifacts or auto-merge', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/post-merge-triage.yml', import.meta.url), 'utf8');
    expect(workflow).toContain('workflows: [CI, E2E Tests (Manual)]');
    expect(workflow).toContain('ref: main');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain('permissions: {}');
    expect(workflow).not.toMatch(/download-artifact|workflow_run.head_sha|pull_request_target|secrets: inherit|mergePullRequest/);
  });
});
