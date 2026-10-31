import { describe, it, expect, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Executes the changes-filter step's shell against a throwaway git repo and asserts the
 * `deployable` output on both sides of the docs-only line: markdown anywhere is non-deployable,
 * unless it sits under `content-paths` (markdown the build or the tests read), and any
 * non-markdown file is deployable. A wrong `false` here skips every build and test leg quietly.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const action = fs.readFileSync(path.join(REPO_ROOT, '.github', 'actions', 'changes-filter', 'action.yml'), 'utf8');

/** The body under `key:` dedented by the indent of its first line, ending at the first line that is less indented. */
function readBlock(lines: string[], start: number): string {
  const body: string[] = [];
  const keyIndent = lines[start].search(/\S/);
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= keyIndent) break;
    body.push(line);
  }
  const indent = Math.min(...body.filter(l => l.trim()).map(l => l.search(/\S/)));
  return body.map(l => l.slice(indent)).join('\n');
}

/** The `run: |` script of the step with `id: filter`. */
function filterScript(): string {
  const lines = action.split('\n');
  const idAt = lines.findIndex(l => /^\s*- id: filter\s*$/.test(l));
  const runAt = lines.findIndex((l, i) => i > idAt && /^\s*run: \|\s*$/.test(l));
  expect(idAt).toBeGreaterThan(-1);
  expect(runAt).toBeGreaterThan(idAt);
  return readBlock(lines, runAt);
}

/** An input's literal `default: |` text, as the runner would hand it to the step. */
function inputDefault(name: string): string {
  const lines = action.split('\n');
  const inputAt = lines.findIndex(l => l === `  ${name}:`);
  const defaultAt = lines.findIndex((l, i) => i > inputAt && /^ {4}default: \|\s*$/.test(l));
  expect(inputAt).toBeGreaterThan(-1);
  expect(defaultAt).toBeGreaterThan(inputAt);
  return `${readBlock(lines, defaultAt)}\n`;
}

const script = filterScript();
const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

const gitEnv = {
  PATH: process.env.PATH ?? '',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

/** A repo whose second commit adds every file in `changedFiles`; returns both shas. */
function makeRepo(changedFiles: string[]) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'changes-filter-deployable-'));
  tmpDirs.push(cwd);
  const git = (...args: string[]) => {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
    expect(res.status, res.stderr).toBe(0);
    return res.stdout.trim();
  };
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'seed');
  const before = git('rev-parse', 'HEAD');
  for (const file of changedFiles) {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), 'x');
  }
  git('add', '.');
  git('commit', '-q', '-m', 'change');
  return { cwd, before, after: git('rev-parse', 'HEAD') };
}

/** Runs the step as a push and returns its outputs keyed by name. */
function outputsFor(changedFiles: string[], contentPaths = inputDefault('content-paths')): Record<string, string> {
  const { cwd, before, after } = makeRepo(changedFiles);
  const out = path.join(cwd, '..', `${path.basename(cwd)}.output`);
  fs.writeFileSync(out, '');
  tmpDirs.push(out);
  const res = spawnSync('bash', ['-c', script], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '',
      GITHUB_OUTPUT: out,
      EVENT_NAME: 'push',
      PUSH_BEFORE: before,
      PUSH_AFTER: after,
      EXCLUDE_PATHS: inputDefault('exclude-paths'),
      CONTENT_PATHS: contentPaths,
      DOCS_PATHS: inputDefault('docs-paths'),
      PUBLISHED_PATHS: inputDefault('published-paths'),
    },
    encoding: 'utf8',
  });
  expect(res.status, res.stderr + res.stdout).toBe(0);
  const outputs: Record<string, string> = {};
  for (const line of fs.readFileSync(out, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return outputs;
}

describe('changes-filter deployable', () => {
  // One representative per place markdown lives outside docs-site: an infra note, the root
  // docs tree, a workflow template, a design note inside a component tree, a root doc and a
  // package README. Each used to be deployable and ran the full pipeline.
  it.each([
    'infra/preview-shared-response-function.md',
    'docs/architecture/org-credit-hard-stop.md',
    '.github/pull_request_template.md',
    'apps/client/app/components/admin/DESIGN_GUIDE.md',
    'CONTRIBUTING.md',
    'packages/cli/README.md',
    'packages/cli/docs/acp.md',
  ])('is false for markdown-only change %s', file => {
    const outputs = outputsFor([file]);
    expect(outputs.deployable).toBe('false');
    expect(outputs['docs-changed']).toBe('false');
  });

  it('is false for a docs-site change, which reports docs-changed instead', () => {
    const outputs = outputsFor(['docs-site/docs/features/agents.md']);
    expect(outputs.deployable).toBe('false');
    expect(outputs['docs-changed']).toBe('true');
  });

  // Markdown the build or the tests read: the client content tree, the CLI's built-in agent
  // definitions, a parser fixture and the lake RAG eval corpus.
  it.each([
    'apps/client/content/legal/terms-of-service.md',
    'apps/client/content/pricing.mdx',
    'packages/cli/src/agents/defaults/plan.md',
    'b4m-core/services/src/modelDiscoveryService/sources/__fixtures__/openai/pricing.md',
    'b4m-core/services/src/llm/evals/lakeRag/corpus/si-units/si-base-units.md',
  ])('is true for markdown build input %s', file => {
    expect(outputsFor([file]).deployable).toBe('true');
  });

  it('is true for a source change', () => {
    expect(outputsFor(['infra/web.ts']).deployable).toBe('true');
  });

  it('is true when a PR mixes markdown with a source change', () => {
    expect(outputsFor(['infra/preview-shared-response-function.md', 'scripts/preview.mjs']).deployable).toBe('true');
  });

  it('treats an empty content-paths list as no carve-out rather than as every file', () => {
    expect(outputsFor(['packages/cli/src/agents/defaults/plan.md'], '').deployable).toBe('false');
    expect(outputsFor(['infra/notes.md'], '').deployable).toBe('false');
  });
});
