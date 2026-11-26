import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import config from '../playwright.config';
import { selectProjects, STANDALONE } from './project-selection.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const e2e = path.join(root, 'apps/client/e2e');
const projects = config.projects ?? [];
const files = readdirSync(e2e, { recursive: true })
  .map(String)
  .filter(file => /\.(spec|setup)\.tsx?$/.test(file) && !STANDALONE.includes(file))
  .map(file => path.join(e2e, file));
// Disabled opt-in suites are classified by the all-conditions guard in the tests.
const activeFiles = files.filter(
  file =>
    (process.env.AI_LATENCY_RUN === 'true' || !path.basename(file).startsWith('ai-latency-')) &&
    (process.env.EXPORT_BYTES_RUN === 'true' || !path.basename(file).startsWith('notebook-export-bytes.'))
);
let changedPaths: string[] | undefined;
const errors: string[] = [];
try {
  const base = process.env.E2E_BASE_SHA ?? '';
  const head = process.env.E2E_HEAD_SHA ?? '';
  if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head)) throw new Error('Missing immutable diff refs');
  const mergeBase = execFileSync('git', ['merge-base', base, head], { cwd: root, encoding: 'utf8' }).trim();
  changedPaths = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', mergeBase, head], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
} catch {
  errors.push('Diff unavailable');
}
const selection = selectProjects({
  projects,
  files: activeFiles,
  changedPaths,
  full: process.env.E2E_FULL === 'true',
  errors,
});
if (selection.projects.some((name: string) => !/^[a-z0-9-]+$/.test(name))) throw new Error('Unsafe project name');
const args = selection.projects.map((name: string) => `--project=${name}`).join(' ');
if (!args) throw new Error('No PR-eligible projects');
console.log(JSON.stringify(selection));
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `playwright_args=${args}\n`);
