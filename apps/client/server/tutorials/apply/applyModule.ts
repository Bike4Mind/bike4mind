// Turns a made tutorial's export into a module directory, filled exactly as the server serves the draft.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { MODULE_BUNDLE_FORMAT, ModuleBundleSchema, type TutorialDraftContent } from '@bike4mind/common';
import { assertWritable, moduleDirOf } from './applyOverride';
import type { ModuleFiles, TutorialRepoLayout } from './layout';
import { checkBundleOwner } from './owner';

export { identifiersOf } from './layout';

export const isModuleBundle = (raw: unknown) => (raw as { format?: unknown } | null)?.format === MODULE_BUNDLE_FORMAT;

export interface ParsedModuleBundle {
  owner?: string;
  moduleId: string;
  content: TutorialDraftContent;
}

export function parseModuleBundle(raw: unknown): ParsedModuleBundle {
  const parsed = ModuleBundleSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`not a tutorial module bundle: ${issue?.path.join('.')} ${issue?.message}`.trim());
  }
  const { owner, moduleId, content } = parsed.data;
  if (content.moduleId !== moduleId) throw new Error('the bundle and its content name different modules');
  return { ...(owner !== undefined && { owner }), moduleId, content: content as unknown as TutorialDraftContent };
}

export type ModuleApplyResult =
  | { ok: false; reason: 'owner' | 'exists'; message: string }
  | { ok: false; reason: 'rules'; issues: ModuleFiles['issues'] }
  | { ok: true; dir: string; files: string[]; registration: ModuleFiles['registration'] };

/** Checks the owner, then the draft's rules, then that the directory is free; writes the files unless `dryRun`. */
export function applyModuleBundle(
  bundle: ParsedModuleBundle,
  layout: TutorialRepoLayout,
  { dryRun }: { dryRun: boolean }
): ModuleApplyResult {
  const verdict = checkBundleOwner(bundle, layout);
  if (!verdict.ok) return { ok: false, reason: 'owner', message: verdict.message };
  const dir = moduleDirOf(layout, bundle.moduleId);
  const made = layout.moduleFiles(bundle.content, dir);
  if (made.issues.length > 0) return { ok: false, reason: 'rules', issues: made.issues };
  if (existsSync(dir)) {
    return { ok: false, reason: 'exists', message: `refusing to write ${dir}: it already exists` };
  }
  const files = made.files.map(([path, text]): [string, string] => [
    path,
    layout.header && path.endsWith('.ts') ? `${layout.header}\n${text}` : text,
  ]);
  for (const [path] of files) assertWritable(layout, bundle.moduleId, path);
  if (!dryRun) {
    mkdirSync(dir, { recursive: true });
    for (const [path, text] of files) writeFileSync(path, text);
  }
  return { ok: true, dir, files: files.map(([path]) => path), registration: made.registration };
}

export function moduleChecklist(layout: TutorialRepoLayout, moduleId: string): string[] {
  return [
    `- [ ] Register it: ${layout.registers.join(' and ')} (the snippets above)`,
    `- [ ] ${layout.fieldsCommand}, then commit the editable-fields file it writes`,
    `- [ ] Format: pnpm exec prettier --write ${layout.modulesDir}/${moduleId}`,
    `- [ ] e2e: add a spec walking it, with the testids its steps point at`,
    '- [ ] After the deploy, the drafts card stops serving the draft: the repo module with its id wins',
  ];
}
