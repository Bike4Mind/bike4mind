import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { CORE, EXCLUDED, STANDALONE, classificationErrors, dependencyClosure,
  eligibleProjects, selectProjects } from './project-selection.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const e2e = path.join(root, 'apps/client/e2e');
function loadProjects(env) {
  const output = execFileSync('pnpm', ['--filter', '@bike4mind/client', 'exec', 'tsx', '-e',
    `import config from './playwright.config.ts'; console.log('PROJECTS=' + JSON.stringify(config.projects, (_, v) => v instanceof RegExp ? { regex: v.source, flags: v.flags } : v))`],
  { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
  return JSON.parse(output.split('\n').find(line => line.startsWith('PROJECTS=')).slice(9),
    (_, value) => value?.regex ? new RegExp(value.regex, value.flags) : value);
}
const allFiles = readdirSync(e2e, { recursive: true }).map(String)
  .filter(file => /\.(spec|setup)\.tsx?$/.test(file) && !STANDALONE.includes(file))
  .map(file => path.join(e2e, file));
const projects = loadProjects({ AI_LATENCY_RUN: 'false', EXPORT_BYTES_RUN: 'false' });
const files = allFiles.filter(file => !/\/(ai-latency-|notebook-export-bytes\.)/.test(file));
const select = options => selectProjects({ projects, files, ...options });

test('all actual config flag combinations classify every hosted spec and setup', () => {
  for (const AI_LATENCY_RUN of ['false', 'true']) {
    for (const EXPORT_BYTES_RUN of ['false', 'true']) {
      const active = loadProjects({ AI_LATENCY_RUN, EXPORT_BYTES_RUN });
      const activeFiles = allFiles.filter(file =>
        (AI_LATENCY_RUN === 'true' || !path.basename(file).startsWith('ai-latency-')) &&
        (EXPORT_BYTES_RUN === 'true' || !path.basename(file).startsWith('notebook-export-bytes.')));
      assert.deepEqual(classificationErrors(active, activeFiles), []);
    }
  }
});

for (const [changedPath, extra] of [
  ['apps/client/app/components/Project/Card.tsx', ['projects']],
  ['apps/client/app/components/ImageStudio/Form.tsx', ['image-gen', 'studio']],
  ['apps/client/e2e/teams-checkout.spec.ts', ['teams']],
  ['apps/client/e2e/free-tier-limits.spec.ts', ['credits']],
  ['apps/client/e2e/admin-access-review.spec.ts', ['admin']],
  ['apps/client/e2e/launch-readiness-purchase.spec.ts', []],
  ['apps/client/e2e/referrals.spec.ts', []],
]) {
  test(`maps ${changedPath}`, () => {
    const selection = select({ changedPaths: [changedPath] });
    assert.equal(selection.mode, 'selected');
    assert.deepEqual(selection.projects, [...CORE, ...extra].sort());
  });
}

for (const changedPaths of [undefined, [], ['unknown/new.ts'], ['pnpm-lock.yaml'],
  ['apps/client/package.json'], ['apps/client/playwright.config.ts'],
  ['apps/client/e2e/fixtures.ts'], ['apps/client/e2e/helpers/auth.ts'],
  ['apps/client/e2e/projects.setup.ts'], ['apps/client/app/routes/projects/index.tsx'],
  ['apps/client/app/components/layouts/Notebook/index.tsx'], ['apps/client/pages/api/projects.ts'],
  ['apps/client/app/components/Project/Card.tsx', 'shared/auth.ts']]) {
  test(`full fallback for ${JSON.stringify(changedPaths)}`, () => {
    assert.deepEqual(select({ changedPaths }).projects, eligibleProjects(projects));
    assert.equal(select({ changedPaths }).mode, 'full');
  });
}

test('full override and uncertainty preserve exclusions including transitive dependencies', () => {
  const modified = [...projects, { name: 'new-suite', testMatch: /new\.spec\.ts$/, dependencies: ['referrals'] }];
  for (const options of [{ full: true }, { errors: ['diff error'] }, {}]) {
    const selection = selectProjects({ projects: modified, files, changedPaths: ['unknown'], ...options });
    assert.ok(!selection.projects.includes('new-suite'));
    assert.ok(!dependencyClosure(modified, selection.projects).some(name => EXCLUDED.includes(name)));
    CORE.forEach(name => assert.ok(selection.projects.includes(name)));
  }
});

test('unclassified projects, uncovered specs and unresolvable matching widen selection', () => {
  for (const changes of [
    { projects: [...projects, { name: 'new-suite', testMatch: /new\.spec\.ts$/ }] },
    { files: [...files, '/e2e/new.spec.ts'] },
    { projects: projects.map(project => project.name === 'teams' ? { ...project, testMatch: '**/*.ts' } : project) },
    { projects: projects.map(project => project.name === 'teams' ? { ...project, testDir: '/other' } : project) },
    { projects: projects.map(project => project.name === 'teams' ? { ...project, dependencies: ['missing'] } : project) },
  ]) {
    const selection = select({ changedPaths: ['apps/client/e2e/teams.spec.ts'], ...changes });
    assert.equal(selection.mode, 'full');
    assert.deepEqual(selection.projects, eligibleProjects(changes.projects ?? projects));
  }
});

test('setup graph remains automatic and includes unauthenticated multifile dependencies', () => {
  const selection = select({ changedPaths: ['apps/client/e2e/teams.spec.ts'] });
  assert.ok(selection.projects.every(name => !name.startsWith('setup-') && name !== 'warmup'));
  const closure = dependencyClosure(projects, selection.projects);
  for (const name of ['setup-core', 'warmup', 'setup-projects', 'setup-notebook', 'setup-prompts', 'setup-teams']) {
    assert.ok(closure.includes(name), name);
  }
});

test('empty-argument PR config fallback excludes restricted suites and keeps setup dependencies', () => {
  const pr = loadProjects({ PR_E2E: 'true', AI_LATENCY_RUN: 'false', EXPORT_BYTES_RUN: 'false' });
  assert.ok(EXCLUDED.every(name => !pr.some(project => project.name === name)));
  assert.deepEqual(eligibleProjects(pr), eligibleProjects(projects));
  assert.ok(dependencyClosure(pr, eligibleProjects(pr)).includes('setup-projects'));
  assert.ok(EXCLUDED.every(name => projects.some(project => project.name === name)));
});
