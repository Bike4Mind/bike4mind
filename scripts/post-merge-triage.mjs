import { createHash } from 'node:crypto';

const REPO = 'Bike4Mind/bike4mind';
const SHA = /^[0-9a-f]{40}$/;
const WORKFLOWS = new Map([
  ['.github/workflows/ci.yml', { name: 'CI', event: 'push' }],
  ['.github/workflows/e2e-manual.yml', { name: 'E2E Tests (Manual)', event: 'schedule' }],
]);
const SETUP = /^(Set up job|Checkout code|Checkout|Setup Node\.js|Setup pnpm|Install dependencies|Install root dependencies|Install Playwright Chromium|Configure AWS credentials|Wait for deployment to be healthy)$/;

export function validateRun(run) {
  const workflow = WORKFLOWS.get(run.path);
  if (!workflow || run.name !== workflow.name || run.event !== workflow.event ||
      run.head_repository?.full_name !== REPO || run.repository?.full_name !== REPO ||
      run.head_branch !== 'main' || run.status !== 'completed' || !SHA.test(run.head_sha) ||
      !Number.isSafeInteger(run.id) || run.id < 1 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 ||
      !['failure', 'success'].includes(run.conclusion) || run.pull_requests?.length) {
    throw new Error('Run is not an eligible completed full main run');
  }
  return run;
}

export function fingerprint(run, job) {
  const failed = (job.steps || []).filter(step => step.conclusion === 'failure').map(step => step.name).sort();
  return createHash('sha256').update(JSON.stringify([run.path, job.name, failed])).digest('hex').slice(0, 24);
}

export function marker(key) {
  return `<!-- post-merge-triage:${key} -->`;
}

export function planFailure({ run, job, issues = [], recovered = false, confirmed = false }) {
  validateRun(run);
  const key = fingerprint(run, job);
  const existing = issues.find(issue => !issue.pull_request &&
    (issue.body?.includes(marker(key)) || issue.body?.includes(`<!-- post-merge-known:${key} -->`)));
  const failedSteps = (job.steps || []).filter(step => step.conclusion === 'failure');
  const setup = failedSteps.length > 0 && failedSteps.every(step => SETUP.test(step.name));
  const classification = recovered ? 'intermittent' : setup ? 'setup' : confirmed ? 'confirmed-regression' : 'uncertain';
  const next = {
    intermittent: 'Compare the failed and successful attempts for the same test. Confirm flakiness before changing any test; keep tracking open.',
    setup: 'Inspect the linked setup step and restore the environment, then rerun the unchanged full suite. No product culprit established.',
    'confirmed-regression': 'Prepare a draft revert for human review. Required full verification must run before a human marks it ready and merges.',
    uncertain: run.event === 'schedule'
      ? 'Identify the failed test in the linked report and the actual deployed SHA (not the workflow head). Reproduce on that revision and a known-good revision before proposing a fix.'
      : 'Identify the failed test in the linked job, rerun the unchanged full suite, and compare that test on head and its direct parent. A red job alone does not identify a culprit.',
  }[classification];
  return { key, existing, classification, next, blocked: classification !== 'confirmed-regression' };
}

function runUrl(run) {
  return `https://github.com/${REPO}/actions/runs/${run.id}/attempts/${run.run_attempt}`;
}

function receipt(run) {
  return `<!-- post-merge-run:${run.id}:${run.run_attempt} -->`;
}

export function evidenceBody(plan, run, job) {
  const failedRun = plan.classification === 'intermittent' ? { ...run, run_attempt: run.run_attempt - 1 } : run;
  return [marker(plan.key), receipt(run), '', `Classification: **${plan.classification}**.`,
    `Run and original logs: ${runUrl(failedRun)}`,
    ...(plan.classification === 'intermittent' ? [`Successful retry (not proof of flakiness): ${runUrl(run)}`] : []),
    `Job: https://github.com/${REPO}/actions/runs/${run.id}/job/${job.id}`,
    `Reports (subject to original retention): https://github.com/${REPO}/actions/runs/${run.id}#artifacts`,
    `Workflow head: \`${run.head_sha}\` (scheduled E2E may test a different deployed SHA).`, '',
    `Status: **${plan.blocked ? 'blocked; not resolved' : 'awaiting draft remediation and human review'}**.`,
    `Next diagnostic/action: ${plan.next}`, '',
    'No log contents are copied here. No tests are omitted, weakened or quarantined. A later green run does not automatically close this issue.',
  ].join('\n');
}

const id = value => {
  if (!/^[1-9][0-9]*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid run ID');
  return Number(value);
};

export async function triage({ github, remediation, context, core, inputs = {}, rollout = {} }) {
  const params = { owner: 'Bike4Mind', repo: 'bike4mind' };
  if (`${context.repo.owner}/${context.repo.repo}` !== REPO) throw new Error('Unexpected repository');
  const dispatch = context.eventName === 'workflow_dispatch';
  if (!dispatch && context.eventName !== 'workflow_run') throw new Error('Unexpected event');
  const dryRun = dispatch && inputs.dry_run !== 'false';
  if (!dryRun && (rollout.tracking !== 'true' ||
      (dispatch && inputs.confirmed_last_change === 'true' && rollout.remediation !== 'true'))) {
    core.info('Post-merge writes disabled by rollout configuration; no API calls made.');
    return [];
  }
  const getRun = async runId => validateRun((await github.rest.actions.getWorkflowRun({ ...params, run_id: id(runId) })).data);
  const run = await getRun(dispatch ? inputs.run_id : context.payload.workflow_run.id);
  // The API is authoritative, including for reruns delivered out of order.
  if (!dispatch && (run.run_attempt !== context.payload.workflow_run.run_attempt ||
      run.head_sha !== context.payload.workflow_run.head_sha)) throw new Error('Stale or mismatched event');
  const compare = await github.rest.repos.compareCommitsWithBasehead({ ...params, basehead: `${run.head_sha}...main` });
  if (!['ahead', 'identical'].includes(compare.data.status)) throw new Error('Run SHA is not on main');
  const jobsFor = (target, attempt = target.run_attempt) => github.paginate(github.rest.actions.listJobsForWorkflowRunAttempt,
    { ...params, run_id: target.id, attempt_number: attempt, per_page: 100 });
  const recovered = run.conclusion === 'success';
  if (recovered && run.run_attempt === 1) return [];
  const jobs = await jobsFor(run, recovered ? run.run_attempt - 1 : run.run_attempt);
  const failures = jobs.filter(job => job.conclusion === 'failure');
  // A failed aggregate without job metadata is still an explicit diagnostic blocker.
  if (!recovered && failures.length === 0) failures.push({ id: 0, name: 'unknown', steps: [] });
  const issues = await github.paginate(github.rest.issues.listForRepo, { ...params, state: 'open', per_page: 100 });
  let confirmed = false;
  let parent;
  let confirmationBlocked = false;
  if (dispatch && inputs.confirmed_last_change === 'true') {
    try {
    if (run.path !== '.github/workflows/ci.yml' || run.conclusion !== 'failure') throw new Error('Only failed full CI can be reverted');
    const reproduction = await getRun(inputs.reproduction_run_id);
    const baseline = await getRun(inputs.parent_run_id);
    const commitResponse = await github.rest.repos.getCommit({ ...params, ref: run.head_sha, per_page: 100 });
    if (commitResponse.headers?.link) throw new Error('Commit file response is paginated; prepare a manual fix');
    const commit = commitResponse.data;
    parent = commit.parents?.[0]?.sha;
    const main = (await github.rest.repos.getBranch({ ...params, branch: 'main' })).data.commit.sha;
    if (commit.parents?.length !== 1 || main !== run.head_sha || reproduction.head_sha !== run.head_sha ||
        reproduction.path !== run.path || reproduction.conclusion !== 'failure' ||
        (reproduction.id === run.id && reproduction.run_attempt === run.run_attempt) ||
        baseline.path !== run.path || baseline.head_sha !== parent || baseline.conclusion !== 'success') {
      throw new Error('Last-change reproduction and direct-parent baseline are not established');
    }
    const repeated = (await jobsFor(reproduction)).filter(job => job.conclusion === 'failure');
    if (failures.length !== repeated.length || failures.some(job => !repeated.some(other => fingerprint(run, job) === fingerprint(run, other)))) {
      throw new Error('Reproduction failure signatures differ');
    }
    const changed = commit.files || [];
    if (!changed.length || changed.length >= 300 || changed.some(file =>
      file.status !== 'modified' || !/^(apps|b4m-core|packages)\/.+\.(ts|tsx|js|mjs)$/.test(file.filename) ||
      /(^|[/._-])(test|tests|spec|specs|e2e|fixtures|snapshots|migrations|security|auth)([/._-]|$)/i.test(file.filename))) {
      throw new Error('Revert includes protected, non-source or incomplete changes; prepare a manual fix');
    }
    if (!failures.length || failures.some(job => planFailure({ run, job }).classification === 'setup' ||
        !(job.steps || []).some(step => step.conclusion === 'failure'))) {
      throw new Error('No actionable test failure metadata; inspect the original run');
    }
    confirmed = true;
    } catch {
      confirmationBlocked = true;
    }
  }
  const plans = [];
  for (const job of failures) {
    const plan = planFailure({ run, job, issues, recovered, confirmed });
    if (confirmationBlocked) {
      plan.next = 'Blocked: last-change evidence or safe-revert checks were not satisfied. Inspect test-level reproduction, the direct-parent full baseline, current main and changed files; prepare a manual fix if any condition cannot be established.';
    }
    plans.push(plan);
    core.info(`Triage ${plan.key}: ${plan.classification}${dryRun ? ' (dry run)' : ''}`);
    if (dryRun) continue;
    const body = evidenceBody(plan, run, job);
    if (plan.existing) {
      const comments = await github.paginate(github.rest.issues.listComments, { ...params, issue_number: plan.existing.number, per_page: 100 });
      if (!plan.existing.body?.includes(receipt(run)) && !comments.some(comment => comment.body?.includes(receipt(run)))) {
        await github.rest.issues.createComment({ ...params, issue_number: plan.existing.number, body });
      }
    } else {
      plan.existing = (await github.rest.issues.create({ ...params, title: `Full-suite triage: ${plan.classification} (${plan.key})`, body })).data;
      issues.push(plan.existing);
    }
  }
  if (confirmationBlocked) {
    if (!dryRun && plans[0]?.existing) {
      await github.rest.issues.createComment({ ...params, issue_number: plans[0].existing.number,
        body: 'Blocked: last-change confirmation did not meet the safe-revert checks. Inspect the reproduction, direct-parent baseline, main tip and changed-file scope; prepare a manual fix when a safe revert cannot be established. Tracking remains open.' });
    }
    throw new Error('Draft remediation blocked; last-change checks were not satisfied');
  }
  if (confirmed && !dryRun) {
    const issue = plans[0]?.existing;
    if (!issue) throw new Error('No tracked failure for remediation');
    try {
      if (!remediation) throw new Error('Remediation App token unavailable');
      const branch = `fix/full-suite-revert-${run.head_sha.slice(0, 12)}`;
      const existing = await github.rest.pulls.list({ ...params, state: 'all', head: `Bike4Mind:${branch}` });
      if (existing.data.length) return plans;
      const current = (await github.rest.repos.getBranch({ ...params, branch: 'main' })).data.commit.sha;
      if (current !== run.head_sha) throw new Error('Main advanced; reassess before remediation');
      const tree = (await github.rest.git.getCommit({ ...params, commit_sha: parent })).data.tree.sha;
      const commit = await remediation.rest.git.createCommit({ ...params, message: 'fix(ci): revert confirmed last-change regression', tree, parents: [run.head_sha] });
      const ref = `refs/heads/${branch}`;
      try {
        await remediation.rest.git.getRef({ ...params, ref: `heads/${branch}` });
      } catch (error) {
        if (error.status !== 404) throw error;
        await remediation.rest.git.createRef({ ...params, ref, sha: commit.data.sha });
      }
      const remote = (await remediation.rest.git.getRef({ ...params, ref: `heads/${branch}` })).data.object.sha;
      const candidate = (await remediation.rest.git.getCommit({ ...params, commit_sha: remote })).data;
      if (candidate.tree.sha !== tree || candidate.parents.length !== 1 || candidate.parents[0].sha !== run.head_sha) throw new Error('Existing remediation branch differs');
      const pr = await remediation.rest.pulls.create({ ...params, base: 'main', head: branch, draft: true,
        title: 'fix(ci): revert confirmed last-change regression',
        body: [`Refs #${issue.number}`, '', '## Description',
          'Maintainer-confirmed last-change regression; draft restores the direct parent tree for human review.',
          `Failed full run: ${runUrl(run)}`,
          `Reproduction: https://github.com/${REPO}/actions/runs/${id(inputs.reproduction_run_id)}`,
          `Green direct parent: https://github.com/${REPO}/actions/runs/${id(inputs.parent_run_id)}`, '',
          '## Customer note', 'none', '', '## Guide for Testers',
          '1. Review the linked test-level reproduction and confirm the same test passes on parent.',
          '2. Mark ready only after review; run the required full CI and full E2E verification.',
          '3. A human decides whether to merge. No automated merge or resolution is performed.',
          '', '## Additional Information', 'Draft creation is not verification of the reverted tree. Tracking remains open.',
        ].join('\n') });
      await github.rest.issues.createComment({ ...params, issue_number: issue.number, body: `Draft remediation: ${pr.data.html_url}\nAwaiting full verification and human review; not resolved.` });
    } catch {
      await github.rest.issues.createComment({ ...params, issue_number: issue.number,
        body: 'Blocked: draft remediation could not be prepared. Inspect the triage run permissions, App configuration and main/branch state, then retry a dry-run plan. Tracking remains open.' });
      throw new Error('Draft remediation blocked; tracking updated');
    }
  }
  return plans;
}
