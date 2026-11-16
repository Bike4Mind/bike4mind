// The body both repos' apply scripts call: dispatches on the bundle format, refuses a bundle another repo owns,
// and prints what a person still has to do. Returns the exit code.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  applyBundle,
  assertWritable,
  moduleDirOf,
  parseBundle,
  prChecklist,
  specsQuoting,
  unitKey,
} from './applyOverride';
import { applyModuleBundle, isModuleBundle, moduleChecklist, parseModuleBundle } from './applyModule';
import type { TutorialRepoLayout } from './layout';
import { checkBundleOwner } from './owner';

const USAGE = 'usage: tutorials:apply <bundle.json> [--dry-run] [--guard]';

const list = (title: string, lines: readonly string[]) =>
  lines.length > 0 && console.log(`\n${title}\n${lines.map(l => `  ${l}`).join('\n')}`);

export async function runApplyCli(layout: TutorialRepoLayout, argv: readonly string[]): Promise<number> {
  const input = argv.find(a => !a.startsWith('--'));
  const dryRun = argv.includes('--dry-run');
  const runGuard = argv.includes('--guard');
  if (!input) {
    console.error(USAGE);
    return 2;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(input, 'utf8'));
  } catch (error) {
    console.error(`cannot read ${input}: ${(error as Error).message}`);
    return 2;
  }
  const head = (raw ?? {}) as { owner?: unknown; moduleId?: unknown };
  const verdict = checkBundleOwner(
    {
      ...(typeof head.owner === 'string' && { owner: head.owner }),
      moduleId: typeof head.moduleId === 'string' ? head.moduleId : '(unknown module)',
    },
    layout
  );
  if (!verdict.ok) {
    console.error(`Refused: ${verdict.message}`);
    return 1;
  }
  try {
    return isModuleBundle(raw)
      ? applyModule(layout, raw, dryRun, runGuard)
      : applyOverride(layout, raw, dryRun, runGuard);
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
}

const guardCommand = (layout: TutorialRepoLayout) =>
  `cd ${layout.guard.cwd ?? '.'} && pnpm exec vitest run ${layout.guard.test}`;

function applyModule(layout: TutorialRepoLayout, raw: unknown, dryRun: boolean, runGuard: boolean): number {
  const bundle = parseModuleBundle(raw);
  const { content } = bundle;
  console.log(`${content.moduleId}: made tutorial "${content.title}"${dryRun ? ' (dry run, nothing written)' : ''}`);
  const result = applyModuleBundle(bundle, layout, { dryRun });
  if (!result.ok) {
    if (result.reason === 'rules') {
      list(
        'Refused: the draft breaks these rules; fix it on its card and export again',
        result.issues.map(i => `${i.stepId ?? '-'} ${i.rule}: ${i.message}`)
      );
    } else {
      console.error(result.message);
    }
    return 1;
  }
  list(
    dryRun ? 'Would write' : 'Wrote',
    result.files.map(path => relative(layout.root, path))
  );
  for (const { file, text } of result.registration) console.log(`\nAdd to ${file} (imports, then the entry):\n${text}`);
  console.log(`\nThen run the guard:\n  ${guardCommand(layout)}`);
  if (runGuard) console.log('  (--guard is not run for a new module: it cannot pass until the registry lines are in)');
  list('PR checklist', moduleChecklist(layout, content.moduleId));
  return 0;
}

function applyOverride(layout: TutorialRepoLayout, raw: unknown, dryRun: boolean, runGuard: boolean): number {
  const bundle = parseBundle(raw);
  const dir = moduleDirOf(layout, bundle.moduleId);
  const repo = layout.repoModules().find(m => m.id === bundle.moduleId);
  if (!repo) {
    console.error(`no repo module ${bundle.moduleId}`);
    return 1;
  }
  const stepsPath = join(dir, 'steps.ts');
  const transcriptPath = join(dir, 'transcript.json');
  const versionPath = join(layout.root, layout.version.path);

  const result = applyBundle(
    bundle,
    {
      version: repo.version,
      index: repo.index,
      steps: repo.steps,
      transcript: JSON.parse(readFileSync(transcriptPath, 'utf8')),
      stepsSource: readFileSync(stepsPath, 'utf8'),
      versionSource: readFileSync(versionPath, 'utf8'),
    },
    layout
  );

  const writes = [
    [stepsPath, result.stepsSource],
    [transcriptPath, result.transcript && `${JSON.stringify(result.transcript, null, 2)}\n`],
    [versionPath, result.versionSource],
  ].filter((w): w is [string, string] => w[1] !== null);
  for (const [path] of writes) assertWritable(layout, bundle.moduleId, path);
  if (!dryRun) for (const [path, text] of writes) writeFileSync(path, text);

  console.log(
    `${bundle.moduleId}: ${bundle.units.length} exported edits${dryRun ? ' (dry run, nothing written)' : ''}`
  );
  for (const change of bundle.changes) console.log(`  by ${change.author} at ${change.at}: ${change.reason}`);
  list('Warnings', result.warnings);
  list('Applied', result.applied);
  list('Already in the repo (retired)', result.already);
  list(
    'Refused: the repo moved since the edit was saved; reconcile by hand',
    result.refused.map(
      r => `${r.key}\n    saved over: ${JSON.stringify(r.repoValue)}\n    repo now:   ${JSON.stringify(r.now)}`
    )
  );
  list(
    'Manual edits',
    result.manual.map(m => `${m.key}: ${m.edit}`)
  );
  list(
    dryRun ? 'Would write' : 'Wrote',
    writes.map(([path]) => relative(layout.root, path))
  );

  const specDir = layout.specsDir ? join(layout.root, layout.specsDir) : undefined;
  const specs =
    specDir && existsSync(specDir)
      ? readdirSync(specDir, { recursive: true })
          .filter(f => String(f).endsWith('.ts'))
          .map(f => ({ path: join(layout.specsDir!, String(f)), text: readFileSync(join(specDir, String(f)), 'utf8') }))
      : [];
  const changing = new Set([...result.applied, ...result.manual.map(m => m.key)]);
  const exported = bundle.units.filter(u => changing.has(unitKey(u)));

  let code = 0;
  if (runGuard && !dryRun) {
    const run = spawnSync('pnpm', ['exec', 'vitest', 'run', layout.guard.test], {
      cwd: join(layout.root, layout.guard.cwd ?? '.'),
      stdio: 'inherit',
    });
    if (run.status !== 0) code = 1;
  } else {
    console.log(`\nRun the guard:\n  ${guardCommand(layout)}`);
  }
  list('PR checklist', prChecklist(result, specsQuoting(exported, specs)));
  if (result.refused.length > 0 || result.manual.length > 0) code = 1;
  return code;
}
