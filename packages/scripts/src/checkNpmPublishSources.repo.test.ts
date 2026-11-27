import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guard on where npm publishes come from and what they publish.
 *
 * The registry rejects a publish once a package's metadata document passes 100 MB, and every
 * published version adds its manifest to that document for good: a version can only be removed
 * while the package has a single maintainer and nothing depends on it. Per-branch snapshot
 * publishes add a version on every green branch build, which is what fills the document. So
 * the only publish path is the release workflow, and it publishes release versions only.
 *
 * Branch builds that need to be installable belong somewhere disposable (a CI artifact), not in
 * a published package's history. scripts/check-npm-metadata-size.mjs is the runtime half of this
 * guard: it measures the documents on a schedule.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const GITHUB_DIR = path.join(REPO_ROOT, '.github');

const RELEASE_WORKFLOW = '.github/workflows/release.yaml';

type CommandKinds = { publish: boolean; snapshot: boolean };

const COMMON_VALUE_OPTIONS = ['--registry', '--userconfig', '--cache', '--loglevel', '--prefix'];
const VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
  npm: new Set([...COMMON_VALUE_OPTIONS, '--workspace', '-w']),
  pnpm: new Set([...COMMON_VALUE_OPTIONS, '--filter', '--filter-prod', '-F', '--dir', '-C', '--reporter']),
  yarn: new Set([...COMMON_VALUE_OPTIONS, '--cwd', '--cache-folder', '--mutex']),
};
const BOOLEAN_OPTIONS = new Set([
  '-g',
  '--global',
  '--ignore-scripts',
  '--silent',
  '--no-color',
  '--color',
  '--offline',
  '--no-git-checks',
]);
const SEPARATOR = /^[;&|()]+$/;

/** Conservative static command recognition, not an interpreter for arbitrary shell wrappers. */
function commandKinds(source: string): CommandKinds {
  const kinds = { publish: false, snapshot: false };
  const lines = source.replace(/\\\r?\n/g, ' ').split('\n');
  for (const line of lines) {
    const rawWords = line.match(/(?:[^\s;&|()'"\\]+|\\.|"[^"\n]*"|'[^'\n]*')+|[;&|()]+/g) ?? [];
    const comment = rawWords.findIndex(word => word.startsWith('#'));
    const words = (comment < 0 ? rawWords : rawWords.slice(0, comment)).map(word =>
      word.replace(/(['"])(.*?)\1/g, '$2')
    );
    for (let index = 0; index < words.length; index++) {
      const executable = words[index];
      const manager = path.posix.basename(executable);
      // YAML quoted run scalars and ordinary quoted shell command wrappers.
      if (/^(?:\S*\/)?(?:npm|pnpm|yarn|changeset)\s/.test(executable)) {
        const nested = commandKinds(executable);
        kinds.publish ||= nested.publish;
        kinds.snapshot ||= nested.snapshot;
      }
      if (manager === '--snapshot' || manager.startsWith('--snapshot=')) kinds.snapshot = true;
      if (manager === 'changeset:publish' || (manager === 'changeset' && words[index + 1] === 'publish')) {
        kinds.publish = true;
      }
      if (!Object.hasOwn(VALUE_OPTIONS, manager)) continue;
      const separator = words.findIndex((word, position) => position > index && SEPARATOR.test(word));
      const end = separator < 0 ? words.length : separator;
      let command = index + 1;
      let unsupported = false;
      while (command < end && words[command].startsWith('-')) {
        const option = words[command];
        if (option.includes('=')) {
          command++;
          continue;
        }
        if (VALUE_OPTIONS[manager].has(option)) {
          command += 2;
          continue;
        }
        const managerBoolean =
          manager === 'npm'
            ? option === '--workspaces'
            : manager === 'pnpm' && (/^-[rw]+$/.test(option) || ['--recursive', '--workspace-root'].includes(option));
        if (BOOLEAN_OPTIONS.has(option) || managerBoolean) {
          command++;
          continue;
        }
        unsupported = true;
        break;
      }
      if (manager === 'yarn' && words[command] === 'workspace') command += 2;
      // An unfamiliar prefix containing a publishing command fails conservatively, rather than
      // asserting it is safe. This can flag command-shaped data under unsupported shell syntax.
      if (unsupported) {
        kinds.publish ||= words.slice(command, end).includes('publish');
        kinds.snapshot ||= words
          .slice(command, end)
          .some((word, offset, remaining) => word === 'dist-tag' && remaining[offset + 1] === 'add');
      } else {
        kinds.publish ||= words[command] === 'publish';
        kinds.snapshot ||= manager !== 'yarn' && words[command] === 'dist-tag' && words[command + 1] === 'add';
      }
    }
  }
  return kinds;
}

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

const automationFiles = listFiles(GITHUB_DIR).filter(file => /\.(?:ya?ml|sh|mjs|js|ts)$/.test(file));
const relative = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join('/');

function filesMatching(kind: keyof CommandKinds): string[] {
  return automationFiles.filter(file => commandKinds(fs.readFileSync(file, 'utf8'))[kind]).map(relative);
}

function verifyRootScripts(scripts: Record<string, string>) {
  expect(scripts['changeset:publish']).toBe('changeset publish');
  expect(Object.keys(scripts).filter(name => commandKinds(scripts[name]).publish)).toEqual(['changeset:publish']);
  expect(Object.keys(scripts).filter(name => commandKinds(scripts[name]).snapshot)).toEqual([]);
}

describe('npm publish sources', () => {
  it('scans the workflows it is meant to guard', () => {
    expect(automationFiles.map(relative)).toContain(RELEASE_WORKFLOW);
  });

  it('publishes to npm from the release workflow only', () => {
    expect(filesMatching('publish')).toEqual([RELEASE_WORKFLOW]);
  });

  it('never publishes a snapshot version or moves a dist-tag from automation', () => {
    expect(filesMatching('snapshot')).toEqual([]);
  });

  it('keeps the root publish script a plain release publish', () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    verifyRootScripts(scripts);
  });
});

describe('command fixtures used by both repository guards', () => {
  it.each([
    '/usr/bin/npm publish',
    './node_modules/.bin/pnpm --filter @scope/pkg publish',
    '/usr/local/bin/yarn --cwd packages/pkg publish',
    'npm publish',
    'pnpm publish',
    'yarn publish',
    'changeset publish',
    'pnpm changeset:publish',
    'pnpm -r publish',
    'pnpm -rw publish',
    'pnpm --recursive publish',
    'pnpm --filter @scope/pkg publish --tag beta',
    "pnpm --filter='@scope/*' --workspace-root publish",
    'pnpm --filter "./packages/a b" publish',
    'pnpm -C packages/pkg publish',
    'npm --workspace @scope/pkg publish',
    'npm --workspace=@scope/pkg publish',
    'npm --workspaces publish',
    'npm -w @scope/pkg publish',
    'yarn --cwd packages/pkg publish',
    'yarn workspace @scope/pkg publish',
    'run: "pnpm --filter @scope/pkg publish"',
    'run: "/usr/bin/pnpm --filter @scope/pkg publish"',
    'pnpm build && npm --workspace @scope/pkg publish',
    'pnpm test; pnpm -r publish',
    'pnpm --future-option value publish',
    'pnpm --filter @scope/pkg \\\n  publish',
  ])('recognizes publishing: %s', command => expect(commandKinds(command).publish).toBe(true));

  it.each([
    'pnpm --filter @scope/pkg build',
    'npm --workspace @scope/pkg test',
    'pnpm --filter publish test',
    '/path/npm-helper publish',
    'npm-package-publish',
    '# pnpm -r publish',
    '  # npm publish',
    'The release owns package publishing.',
    'pnpm exec echo publish',
    'pnpm build # npm publish',
    'pnpm --filter @scope/pkg test\npublish',
  ])('does not invent publishing: %s', command => expect(commandKinds(command).publish).toBe(false));

  it.each([
    'pnpm changeset version --snapshot branch',
    'npm --workspace @scope/pkg dist-tag add @scope/pkg@1 beta',
    'pnpm --filter @scope/pkg dist-tag add @scope/pkg@1 beta',
    'npm --workspaces dist-tag add @scope/pkg@1 beta',
  ])('rejects snapshot/tag movement independently of the release allowlist: %s', command =>
    expect(commandKinds(command).snapshot).toBe(true)
  );

  it.each([
    'pnpm --filter @scope/pkg publish --tag beta',
    './node_modules/.bin/pnpm --filter @scope/pkg publish --tag beta',
  ])('rejects a root publish alias through the actual root-script assertion: %s', command => {
    expect(() =>
      verifyRootScripts({
        'changeset:publish': 'changeset publish',
        'release:beta': command,
      })
    ).toThrow();
  });
});
